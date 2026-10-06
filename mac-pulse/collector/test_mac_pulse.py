"""Run with: uv run -p 3.12 --with pytest pytest mac-pulse/collector"""

from __future__ import annotations

import json
import urllib.error

import pytest

import mac_pulse as mp

VM_STAT = """\
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3846.
Pages wired down:                             131904.
Pages purgeable:                                   4.
"Translation faults":                     6471500977.
Anonymous pages:                              103795.
Pages occupied by compressor:                 194212.
Swapins:                                    39900738.
Swapouts:                                   46009870.
"""

PS = """\
 544976  12.0 /Applications/T3 Code (Alpha).app/Contents/Frameworks/T3 Code (Alpha) Helper (Renderer).app/Contents/MacOS/T3 Code (Alpha) Helper (Renderer)
 149520   1.5 /Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)
 233056   3.0 claude
   1024   0.0 /usr/sbin/cfprefsd
"""

LAUNCHCTL = """\
PID\tStatus\tLabel
28176\t0\tio.github.river3015.voice-agent-discord
-\t78\tio.github.river3015.receipt-book
81502\t-15\tio.github.river3015.voice-input
7519\t0\tcom.openssh.ssh-agent
"""


def test_swapusage():
    text = "total = 6144.00M  used = 5164.12M  free = 979.88M  (encrypted)"
    assert mp.parse_swapusage(text) == (6144 << 20, int(5164.12 * (1 << 20)))


def test_vm_stat_and_memory_used():
    page_size, vm = mp.parse_vm_stat(VM_STAT)
    assert page_size == 16384 and vm["Translation faults"] == 6471500977
    used, compressed = mp.memory_used(page_size, vm)
    assert used == (103795 - 4 + 131904 + 194212) * 16384
    assert compressed == 194212 * 16384


def test_battery():
    ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;"
    assert mp.parse_battery(ac) == (100, 1)
    assert mp.parse_battery(
        "Now drawing from 'Battery Power'\n -InternalBattery-0\t42%;"
    ) == (42, 0)
    assert mp.parse_battery("Now drawing from 'AC Power'") == (None, 1)


def test_speed_limit():
    assert (
        mp.parse_speed_limit("Note: No thermal warning level has been recorded") is None
    )
    assert (
        mp.parse_speed_limit("CPU_Scheduler_Limit \t= 100\nCPU_Speed_Limit \t= 80")
        == 80
    )


def test_ps_groups_by_app_and_drops_paths():
    procs = mp.parse_ps(PS, top=2)
    assert procs == [
        {
            "name": "T3 Code (Alpha)",
            "count": 2,
            "rss_bytes": (544976 + 149520) * 1024,
            "cpu_pct": 13.5,
        },
        {"name": "claude", "count": 1, "rss_bytes": 233056 * 1024, "cpu_pct": 3.0},
    ]


def test_launchctl_filters_by_prefix():
    jobs = mp.parse_launchctl(LAUNCHCTL, ["io.github.river3015."])
    assert jobs == {
        "io.github.river3015.voice-agent-discord": {"pid": 28176, "last_exit": 0},
        "io.github.river3015.receipt-book": {"pid": None, "last_exit": 78},
        "io.github.river3015.voice-input": {"pid": 81502, "last_exit": -15},
    }


def test_prometheus_format():
    sample = {
        "ts": 1,
        "load1": 1.5,
        "battery_pct": None,
        "processes": [{"name": 'a"b', "rss_bytes": 10}],
        "jobs": {"x": {"pid": None}},
    }
    assert mp.to_prometheus(sample) == (
        "mac_pulse_load1 1.5\n"
        'mac_pulse_process_rss_bytes{name="a\\"b"} 10\n'
        'mac_pulse_job_running{label="x"} 0\n'
    )


def test_spool_sends_in_batches_and_keeps_on_failure(tmp_path, monkeypatch):
    now = 1_800_000_000
    for ts in range(now - 40, now):
        mp.spool({"ts": ts}, tmp_path)
    mp.spool({"ts": now - mp.SPOOL_MAX_AGE_S - 1}, tmp_path)  # too old, dropped
    posted = []
    monkeypatch.setattr(
        mp, "post", lambda endpoint, samples, headers: posted.append(samples)
    )
    assert mp.send_spool("https://example", {}, tmp_path, now) == 40
    assert [len(b) for b in posted] == [30, 10]
    assert posted[0][0] == {"ts": now - 40}
    assert list(tmp_path.iterdir()) == []

    mp.spool({"ts": now}, tmp_path)

    def fail(*args):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(mp, "post", fail)
    with pytest.raises(urllib.error.URLError):
        mp.send_spool("https://example", {}, tmp_path, now)
    assert [json.loads(p.read_text()) for p in tmp_path.glob("*.json")] == [{"ts": now}]


def test_collect_on_this_mac():
    sample = mp.collect(mp.Config(watch_jobs=["io.github.river3015."]))
    assert 0 < sample["mem_used_bytes"] <= sample["mem_total_bytes"] * 1.1
    assert sample["mem_pressure"] in (1, 2, 4)
    assert len(sample["processes"]) <= mp.TOP_PROCESSES
    assert all("/" not in p["name"] for p in sample["processes"])
