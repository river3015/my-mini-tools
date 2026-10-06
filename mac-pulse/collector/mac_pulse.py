#!/opt/homebrew/bin/python3
"""Collect memory, swap, CPU, disk and process stats on macOS and send them.

Run once a minute by launchd. Each run takes one sample, adds it to a local
spool, and sends the spool to the mac-pulse Worker. Samples that fail to send
stay in the spool and are retried on the next run (for up to a day).
Standard library only, so it starts fast and needs no virtualenv.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import tomllib

CONFIG_PATH = Path.home() / ".config" / "mac-pulse" / "config.toml"
SPOOL_DIR = Path.home() / ".local" / "state" / "mac-pulse" / "spool"
KEYCHAIN_TOKEN = "mac-pulse-token"
KEYCHAIN_ACCESS_ID = "mac-pulse-access-client-id"
KEYCHAIN_ACCESS_SECRET = "mac-pulse-access-client-secret"
SPOOL_MAX_AGE_S = 24 * 3600
# The Worker accepts at most this many samples per request (D1 free plan: 50 queries per invocation).
BATCH_SIZE = 30
MAX_BATCHES_PER_RUN = 5
TOP_PROCESSES = 10


@dataclass
class Config:
    endpoint: str = ""  # e.g. https://mac-pulse.<account>.workers.dev
    # launchd labels (prefix match) whose running state is sent.
    watch_jobs: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> Config:
        if not path.exists():
            return cls()
        with path.open("rb") as f:
            return cls(**tomllib.load(f))


def log(message: str) -> None:
    print(
        f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", file=sys.stderr, flush=True
    )


def run(*cmd: str) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout


def keychain(service: str) -> str | None:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or None if result.returncode == 0 else None


# --- Parsers (pure, tested with captured output) --------------------------------


def parse_sysctl(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        key, sep, value = line.partition(": ")
        if sep:
            values[key.strip()] = value.strip()
    return values


def parse_size(text: str) -> int:
    """'6144.00M' -> bytes."""
    units = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30}
    return int(float(text[:-1]) * units[text[-1]])


def parse_swapusage(text: str) -> tuple[int, int]:
    found = dict(re.findall(r"(total|used|free) = ([\d.]+[KMG])", text))
    return parse_size(found["total"]), parse_size(found["used"])


def parse_vm_stat(text: str) -> tuple[int, dict[str, int]]:
    page_size = int(re.search(r"page size of (\d+) bytes", text).group(1))
    counts = {}
    for line in text.splitlines()[1:]:
        key, sep, value = line.rpartition(":")
        if sep:
            counts[key.strip().strip('"')] = int(value.strip().rstrip("."))
    return page_size, counts


def memory_used(page_size: int, vm: dict[str, int]) -> tuple[int, int]:
    """Return (used, compressed) bytes, close to Activity Monitor's "Memory Used"."""
    app = vm["Anonymous pages"] - vm["Pages purgeable"]
    compressed = vm["Pages occupied by compressor"]
    return (
        app + vm["Pages wired down"] + compressed
    ) * page_size, compressed * page_size


def parse_battery(text: str) -> tuple[int | None, int | None]:
    on_ac = 1 if "'AC Power'" in text else 0 if "'Battery Power'" in text else None
    pct = re.search(r"(\d+)%", text)
    return (int(pct.group(1)) if pct else None), on_ac


def parse_speed_limit(text: str) -> int | None:
    found = re.search(r"CPU_Speed_Limit\s*=\s*(\d+)", text)
    return int(found.group(1)) if found else None


def app_name(path: str) -> str:
    """Group helpers under their app: '/Applications/Foo.app/.../Foo Helper' -> 'Foo'."""
    if ".app/" in path:
        return path.split(".app/", 1)[0].rsplit("/", 1)[-1]
    return path.rsplit("/", 1)[-1]


def parse_ps(text: str, top: int = TOP_PROCESSES) -> list[dict]:
    """Group `ps -axo rss=,%cpu=,comm=` by app. Only executable names are kept, never arguments."""
    groups: dict[str, dict] = {}
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) != 3:
            continue
        rss_kb, cpu, comm = parts
        name = app_name(comm)[:100]
        g = groups.setdefault(
            name, {"name": name, "count": 0, "rss_bytes": 0, "cpu_pct": 0.0}
        )
        g["count"] += 1
        g["rss_bytes"] += int(rss_kb) * 1024
        g["cpu_pct"] = round(g["cpu_pct"] + float(cpu), 1)
    return sorted(groups.values(), key=lambda g: -g["rss_bytes"])[:top]


def parse_launchctl(text: str, prefixes: list[str]) -> dict[str, dict]:
    jobs = {}
    for line in text.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) != 3 or not any(parts[2].startswith(p) for p in prefixes):
            continue
        pid, status, label = parts
        jobs[label] = {
            "pid": int(pid) if pid != "-" else None,
            "last_exit": int(status) if status.lstrip("-").isdigit() else None,
        }
    return jobs


# --- Collection -----------------------------------------------------------------


def collect(config: Config) -> dict:
    now = int(time.time())
    sysctl = parse_sysctl(
        run(
            "sysctl",
            "hw.memsize",
            "hw.model",
            "vm.swapusage",
            "vm.loadavg",
            "kern.boottime",
            "kern.memorystatus_level",
            "kern.memorystatus_vm_pressure_level",
        )
    )
    swap_total, swap_used = parse_swapusage(sysctl["vm.swapusage"])
    load = sysctl["vm.loadavg"].strip("{} ").split()
    boot = int(re.search(r"sec = (\d+)", sysctl["kern.boottime"]).group(1))
    page_size, vm = parse_vm_stat(run("vm_stat"))
    used, compressed = memory_used(page_size, vm)
    battery_pct, on_ac = parse_battery(run("pmset", "-g", "batt"))
    disk = shutil.disk_usage("/")
    return {
        "ts": now,
        "model": sysctl["hw.model"],
        "mem_total_bytes": int(sysctl["hw.memsize"]),
        "disk_total_bytes": disk.total,
        "mem_used_bytes": used,
        "mem_compressed_bytes": compressed,
        "mem_free_pct": int(sysctl["kern.memorystatus_level"]),
        "mem_pressure": int(sysctl["kern.memorystatus_vm_pressure_level"]),
        "swap_total_bytes": swap_total,
        "swap_used_bytes": swap_used,
        "swapins": vm["Swapins"],
        "swapouts": vm["Swapouts"],
        "load1": float(load[0]),
        "load5": float(load[1]),
        "cpu_speed_limit": parse_speed_limit(run("pmset", "-g", "therm")),
        "disk_free_bytes": disk.free,
        "battery_pct": battery_pct,
        "on_ac": on_ac,
        "uptime_s": now - boot,
        "processes": parse_ps(run("ps", "-axo", "rss=,%cpu=,comm=")),
        "jobs": parse_launchctl(run("launchctl", "list"), config.watch_jobs)
        if config.watch_jobs
        else {},
    }


def to_prometheus(sample: dict) -> str:
    """Render a sample in the Prometheus text format (for a future local scrape)."""
    lines = []
    for key, value in sample.items():
        if isinstance(value, (int, float)) and key != "ts" and value is not None:
            lines.append(f"mac_pulse_{key} {value}")
    for p in sample["processes"]:
        name = p["name"].replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'mac_pulse_process_rss_bytes{{name="{name}"}} {p["rss_bytes"]}')
    for label, job in sample["jobs"].items():
        lines.append(
            f'mac_pulse_job_running{{label="{label}"}} {int(job["pid"] is not None)}'
        )
    return "\n".join(lines) + "\n"


# --- Spool and send ---------------------------------------------------------------


def spool(sample: dict, spool_dir: Path) -> None:
    spool_dir.mkdir(parents=True, exist_ok=True)
    path = spool_dir / f"{sample['ts']}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(sample, separators=(",", ":")))
    tmp.rename(path)


def spooled(spool_dir: Path, now: int) -> list[Path]:
    files = []
    for path in sorted(spool_dir.glob("*.json")):
        if now - int(path.stem) > SPOOL_MAX_AGE_S:
            path.unlink()
        else:
            files.append(path)
    return files


def post(endpoint: str, samples: list[dict], headers: dict[str, str]) -> None:
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/api/ingest",
        data=json.dumps({"samples": samples}).encode(),
        # Cloudflare's Browser Integrity Check rejects urllib's default
        # User-Agent ("Python-urllib/3.x") with error 1010.
        headers={"Content-Type": "application/json", "User-Agent": "mac-pulse", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def send_spool(
    endpoint: str, headers: dict[str, str], spool_dir: Path, now: int
) -> int:
    """Send spooled samples oldest first. Returns how many were sent."""
    files = spooled(spool_dir, now)
    sent = 0
    for i in range(0, min(len(files), BATCH_SIZE * MAX_BATCHES_PER_RUN), BATCH_SIZE):
        batch = files[i : i + BATCH_SIZE]
        post(endpoint, [json.loads(p.read_text()) for p in batch], headers)
        for path in batch:
            path.unlink()
        sent += len(batch)
    return sent


def auth_headers() -> dict[str, str]:
    token = os.environ.get("MAC_PULSE_TOKEN") or keychain(KEYCHAIN_TOKEN)
    if not token:
        raise SystemExit(
            "ingest token not found. Store it in the Keychain:\n"
            f'  security add-generic-password -s {KEYCHAIN_TOKEN} -a "$USER" -w'
        )
    headers = {"Authorization": f"Bearer {token}"}
    access_id = keychain(KEYCHAIN_ACCESS_ID)
    access_secret = keychain(KEYCHAIN_ACCESS_SECRET)
    if access_id and access_secret:
        headers["CF-Access-Client-Id"] = access_id
        headers["CF-Access-Client-Secret"] = access_secret
    return headers


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=["run", "print", "prometheus"],
        help="run: collect and send (default), print: show the sample as JSON, "
        "prometheus: show it in the Prometheus text format",
    )
    args = parser.parse_args()
    config = Config.load(args.config)

    sample = collect(config)
    if args.command == "print":
        print(json.dumps(sample, ensure_ascii=False, indent=2))
        return
    if args.command == "prometheus":
        sys.stdout.write(to_prometheus(sample))
        return

    if not config.endpoint:
        raise SystemExit(f"endpoint is not set in {args.config}")
    spool(sample, SPOOL_DIR)
    try:
        send_spool(config.endpoint, auth_headers(), SPOOL_DIR, sample["ts"])
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:200]
        log(f"send failed: HTTP {e.code} {body}")
        sys.exit(1)
    except (urllib.error.URLError, TimeoutError) as e:
        # Offline or asleep network: keep the spool for the next run.
        log(f"send failed, kept in spool: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
