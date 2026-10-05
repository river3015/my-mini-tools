#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "anthropic>=1.11",
# ]
# ///
"""Turn receipt photos into a household account book.

Images dropped into the inbox are read by Claude into store, date, total, tax
and line items, checked (item sum vs. total, duplicates), categorized with
rules from the config, and stored in SQLite. Reports are by month and category.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from base64 import standard_b64encode
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import tomllib

KEYCHAIN_SERVICE = "receipt-book-anthropic"
CONFIG_PATH = Path.home() / ".config" / "receipt-book" / "config.toml"
ICLOUD_DIR = Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
PAYMENT_METHODS = ["cash", "credit_card", "e_money", "qr", "other", "unknown"]
UNCATEGORIZED = "未分類"
# Allowed gap between the item sum (plus tax when prices exclude it) and the total.
TOTAL_TOLERANCE_YEN = 2

SYSTEM_PROMPT = """\
あなたは日本のレシートを読み取り、家計簿用のデータにする担当です。
画像に写っている内容だけを使い、読めない箇所は推測で埋めずに notes に書いてください。

- 金額はすべて円の整数にする。
- items にはレシートの明細行を上から順に入れる。amount はその行に印字された金額（数量×単価）。
- 値引き・割引・クーポンの行は、金額を負の数にした品目として入れる。カテゴリは値引き対象の品目と同じにする。
- 小計・合計・税額・お預り・お釣りの行は items に入れない。
- total はポイントや電子マネーで支払う前の、税込の合計金額。
- tax_included は、明細の金額が税込（内税）なら true、税抜（外税）なら false。
- tax_8 / tax_10 は、8%・10% それぞれの消費税額（内税なら「内消費税」の額）。書かれていなければ null。
- 軽減税率の印（※、*、軽 など）が付いた品目は tax_rate を 8、それ以外で税率が分かる品目は 10、分からなければ 0 にする。
- 日付は西暦の YYYY-MM-DD にする（和暦は変換する）。時刻は HH:MM。分からなければ null。
- category は次の一覧から最も近いものを選ぶ: {categories}
- 写っているのがレシートや領収書でなければ is_receipt を false にし、ほかは空でよい。
"""


@dataclass
class Config:
    model: str = "claude-opus-5-5"
    # low / medium / high / xhigh / max. Empty to omit (for models without effort).
    effort: str = "medium"
    # Re-run a declined request on Anthropic's recommended fallback model.
    fallbacks: bool = True
    max_image_px: int = 2048
    inbox_dir: Path = ICLOUD_DIR / "receipts" / "inbox"
    archive_dir: Path = ICLOUD_DIR / "receipts"
    db_path: Path = (
        Path.home() / "Library" / "Application Support" / "receipt-book" / "receipts.db"
    )
    categories: list[str] = field(
        default_factory=lambda: [
            "食費",
            "外食",
            "日用品",
            "医療・薬",
            "衣服・美容",
            "趣味・娯楽",
            "交通",
            "住まい・家具家電",
            "交際費",
            "その他",
        ]
    )
    # Substring of an item name -> category. Takes precedence over everything else.
    item_rules: dict[str, str] = field(default_factory=dict)
    # Substring of a store name -> category for all items of that store.
    store_rules: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> Config:
        if not path.exists():
            return cls()
        with path.open("rb") as f:
            data = tomllib.load(f)
        for key in ("inbox_dir", "archive_dir", "db_path"):
            if key in data:
                data[key] = Path(data[key]).expanduser()
        config = cls(**data)
        known = set(config.categories) | {UNCATEGORIZED}
        for name, rules in (
            ("item_rules", config.item_rules),
            ("store_rules", config.store_rules),
        ):
            for pattern, category in rules.items():
                if category not in known:
                    raise SystemExit(
                        f"{name}: {pattern!r} -> {category!r} is not in categories"
                    )
        return config


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def load_api_key() -> str:
    if key := os.environ.get("ANTHROPIC_API_KEY"):
        return key
    result = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    raise SystemExit(
        "Anthropic API key not found. Store it in the Keychain:\n"
        f'  security add-generic-password -s {KEYCHAIN_SERVICE} -a "$USER" -w'
    )


# --- Extraction ---------------------------------------------------------------


def receipt_schema(categories: list[str]) -> dict:
    nullable_int = {"anyOf": [{"type": "integer"}, {"type": "null"}]}
    item = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "quantity": {"type": "integer"},
            "amount": {"type": "integer"},
            "tax_rate": {"type": "integer", "enum": [0, 8, 10]},
            "category": {"type": "string", "enum": [*categories, UNCATEGORIZED]},
        },
        "required": ["name", "quantity", "amount", "tax_rate", "category"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "is_receipt": {"type": "boolean"},
            "store_name": {"type": "string"},
            "purchased_on": {
                "anyOf": [{"type": "string", "format": "date"}, {"type": "null"}]
            },
            "purchased_time": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "payment_method": {"type": "string", "enum": PAYMENT_METHODS},
            "total": nullable_int,
            "tax_included": {"type": "boolean"},
            "tax_8": nullable_int,
            "tax_10": nullable_int,
            "items": {"type": "array", "items": item},
            "notes": {"type": "string"},
        },
        "required": [
            "is_receipt",
            "store_name",
            "purchased_on",
            "purchased_time",
            "payment_method",
            "total",
            "tax_included",
            "tax_8",
            "tax_10",
            "items",
            "notes",
        ],
        "additionalProperties": False,
    }


@dataclass
class Extraction:
    data: dict
    model: str
    input_tokens: int
    output_tokens: int


class ExtractionError(Exception):
    pass


Extractor = Callable[[bytes, str], Extraction]


def prepare_image(path: Path, max_px: int) -> tuple[bytes, str]:
    """Convert to JPEG (HEIC is not accepted by the API) and cap the long edge."""
    info = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    dims = [int(line.split(":")[1]) for line in info.splitlines() if "pixel" in line]
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "receipt.jpg"
        cmd = ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85"]
        if dims and max(dims) > max_px:
            cmd += ["-Z", str(max_px)]
        subprocess.run(
            [*cmd, str(path), "--out", str(out)], capture_output=True, check=True
        )
        return out.read_bytes(), "image/jpeg"


def claude_extractor(config: Config, api_key: str) -> Extractor:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    system = SYSTEM_PROMPT.format(categories="、".join(config.categories))
    output_config: dict = {
        "format": {"type": "json_schema", "schema": receipt_schema(config.categories)}
    }
    if config.effort:
        output_config["effort"] = config.effort
    extra: dict = {}
    if config.fallbacks:
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}

    def extract(image: bytes, media_type: str) -> Extraction:
        try:
            response = client.beta.messages.create(
                model=config.model,
                max_tokens=16000,
                system=system,
                output_config=output_config,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": standard_b64encode(image).decode(),
                                },
                            },
                            {
                                "type": "text",
                                "text": "このレシートを読み取ってください。",
                            },
                        ],
                    }
                ],
                **extra,
            )
        except anthropic.RateLimitError as e:
            raise ExtractionError(f"rate limited: {e}") from e
        except anthropic.APIStatusError as e:
            raise ExtractionError(f"API error {e.status_code}: {e.message}") from e
        except anthropic.APIConnectionError as e:
            raise ExtractionError(f"connection error: {e}") from e
        if response.stop_reason == "refusal":
            raise ExtractionError("the model declined the request")
        if response.stop_reason == "max_tokens":
            raise ExtractionError("the response was cut off (max_tokens)")
        texts = [block.text for block in response.content if block.type == "text"]
        if not texts:
            raise ExtractionError(f"no text in response (stop: {response.stop_reason})")
        try:
            data = json.loads(texts[-1])
        except json.JSONDecodeError as e:
            raise ExtractionError(f"invalid JSON in response: {e}") from e
        return Extraction(
            data=data,
            model=response.model,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
        )

    return extract


# --- Checks and categories ----------------------------------------------------


def find_issues(data: dict) -> list[str]:
    issues = []
    if not data.get("purchased_on"):
        issues.append("日付が読み取れない")
    total = data.get("total")
    if total is None:
        issues.append("合計が読み取れない")
    if not data.get("items"):
        issues.append("明細がない")
    if total is not None and data.get("items"):
        expected = sum(item["amount"] for item in data["items"])
        if not data.get("tax_included"):
            expected += (data.get("tax_8") or 0) + (data.get("tax_10") or 0)
        if abs(expected - total) > TOTAL_TOLERANCE_YEN:
            issues.append(f"明細の合計 {expected} 円と合計 {total} 円が合わない")
    if data.get("notes", "").strip():
        issues.append("読み取りに不確かな箇所がある")
    return issues


def categorize(config: Config, store_name: str, item: dict) -> tuple[str, str]:
    """Return (category, source). Item rules > store rules > the model's choice."""
    for pattern, category in config.item_rules.items():
        if pattern in item["name"]:
            return category, "item_rule"
    for pattern, category in config.store_rules.items():
        if pattern in store_name:
            return category, "store_rule"
    category = item.get("category") or UNCATEGORIZED
    if category not in config.categories:
        category = UNCATEGORIZED
    return category, "model"


# --- Storage ------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY,
    image_sha256 TEXT NOT NULL UNIQUE,
    image_path TEXT NOT NULL,
    store_name TEXT NOT NULL,
    purchased_on TEXT,
    purchased_time TEXT,
    payment_method TEXT NOT NULL,
    total INTEGER,
    tax_included INTEGER NOT NULL,
    tax_8 INTEGER,
    tax_10 INTEGER,
    status TEXT NOT NULL,
    issues TEXT NOT NULL,
    notes TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    tax_rate INTEGER NOT NULL,
    category TEXT NOT NULL,
    category_source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_purchased_on ON receipts(purchased_on);
"""


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA)
    return db


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def find_duplicate(db: sqlite3.Connection, data: dict) -> int | None:
    if not data.get("purchased_on") or data.get("total") is None:
        return None
    row = db.execute(
        "SELECT id FROM receipts WHERE store_name = ? AND purchased_on = ?"
        " AND purchased_time IS ? AND total = ?",
        (
            data["store_name"],
            data["purchased_on"],
            data.get("purchased_time"),
            data["total"],
        ),
    ).fetchone()
    return row["id"] if row else None


def save_receipt(
    db: sqlite3.Connection,
    config: Config,
    digest: str,
    image_path: Path,
    extraction: Extraction,
) -> tuple[int, list[str]]:
    data = extraction.data
    issues = find_issues(data)
    cur = db.execute(
        "INSERT INTO receipts (image_sha256, image_path, store_name, purchased_on,"
        " purchased_time, payment_method, total, tax_included, tax_8, tax_10, status,"
        " issues, notes, model, input_tokens, output_tokens, raw_json, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            digest,
            str(image_path),
            data["store_name"],
            data.get("purchased_on"),
            data.get("purchased_time"),
            data["payment_method"],
            data.get("total"),
            int(bool(data.get("tax_included"))),
            data.get("tax_8"),
            data.get("tax_10"),
            "needs_review" if issues else "ok",
            json.dumps(issues, ensure_ascii=False),
            data.get("notes", ""),
            extraction.model,
            extraction.input_tokens,
            extraction.output_tokens,
            json.dumps(data, ensure_ascii=False),
            datetime.now().astimezone().isoformat(timespec="seconds"),
        ),
    )
    receipt_id = cur.lastrowid
    for line_no, item in enumerate(data["items"], start=1):
        category, source = categorize(config, data["store_name"], item)
        db.execute(
            "INSERT INTO items (receipt_id, line_no, name, quantity, amount, tax_rate,"
            " category, category_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                receipt_id,
                line_no,
                item["name"],
                item["quantity"],
                item["amount"],
                item["tax_rate"],
                category,
                source,
            ),
        )
    db.commit()
    return receipt_id, issues


# --- Commands -----------------------------------------------------------------


def move_unique(src: Path, dest_dir: Path, stem: str, copy: bool = False) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{stem}{src.suffix.lower()}"
    n = 2
    while dest.exists():
        dest = dest_dir / f"{stem}-{n}{src.suffix.lower()}"
        n += 1
    if copy:
        shutil.copy2(src, dest)
    else:
        shutil.move(src, dest)
    return dest


def safe_name(text: str) -> str:
    keep = "".join(c if c.isalnum() else "-" for c in text).strip("-")
    return keep[:30] or "unknown"


def inbox_images(inbox: Path) -> list[Path]:
    if not inbox.is_dir():
        raise SystemExit(f"inbox not found: {inbox}")
    # iCloud placeholders for files not yet downloaded start with "." and are skipped.
    return sorted(
        p
        for p in inbox.iterdir()
        if p.is_file()
        and not p.name.startswith(".")
        and p.suffix.lower() in IMAGE_SUFFIXES
    )


def ingest(
    config: Config,
    db: sqlite3.Connection,
    extract: Extractor,
    files: list[Path],
    copy: bool = False,
) -> int:
    """Import images. Inbox files are moved to the archive; with copy, they are kept."""
    failures = 0
    archive = config.archive_dir

    def file_away(path: Path, dest_dir: Path, stem: str) -> Path:
        return move_unique(path, dest_dir, stem, copy=copy)

    for path in files:
        digest = sha256(path)
        if db.execute(
            "SELECT 1 FROM receipts WHERE image_sha256 = ?", (digest,)
        ).fetchone():
            dest = file_away(path, archive / "duplicates", path.stem)
            log(f"{path.name}: already imported, moved to {dest}")
            continue
        try:
            image, media_type = prepare_image(path, config.max_image_px)
            extraction = extract(image, media_type)
        except (ExtractionError, subprocess.CalledProcessError) as e:
            failures += 1
            log(f"{path.name}: failed, left in the inbox: {e}")
            continue
        data = extraction.data
        if not data.get("is_receipt"):
            dest = file_away(path, archive / "rejected", path.stem)
            log(f"{path.name}: not a receipt, moved to {dest}")
            continue
        if (dup := find_duplicate(db, data)) is not None:
            dest = file_away(path, archive / "duplicates", path.stem)
            log(f"{path.name}: same as receipt #{dup}, moved to {dest}")
            continue
        day = data.get("purchased_on") or datetime.now().astimezone().date().isoformat()
        dest = file_away(
            path,
            archive / "processed" / day[:4] / day[5:7],
            f"{day}_{safe_name(data['store_name'])}",
        )
        receipt_id, issues = save_receipt(db, config, digest, dest, extraction)
        mark = "要確認: " + " / ".join(issues) if issues else "ok"
        log(
            f"{path.name}: #{receipt_id} {day} {data['store_name']}"
            f" {data.get('total')}円 ({mark})"
        )
    return failures


def month_rows(db: sqlite3.Connection, month: str) -> list[sqlite3.Row]:
    return db.execute(
        "SELECT * FROM receipts WHERE substr(COALESCE(purchased_on, created_at), 1, 7) = ?"
        " ORDER BY purchased_on, purchased_time, id",
        (month,),
    ).fetchall()


def allocate(total: int | None, items: list[sqlite3.Row]) -> dict[str, int]:
    """Spread the receipt total over item categories in proportion to item amounts.

    This puts tax (for tax-excluded receipts) and rounding into the categories,
    so category sums add up to the receipt totals.
    """
    if total is None:
        return {}
    base = sum(item["amount"] for item in items)
    if base <= 0:
        return {UNCATEGORIZED: total}
    shares: dict[str, int] = {}
    allocated = 0
    for item in items:
        share = round(total * item["amount"] / base)
        shares[item["category"]] = shares.get(item["category"], 0) + share
        allocated += share
    if allocated != total and shares:
        largest = max(shares, key=lambda c: shares[c])
        shares[largest] += total - allocated
    return shares


def items_of(db: sqlite3.Connection, receipt_id: int) -> list[sqlite3.Row]:
    return db.execute(
        "SELECT * FROM items WHERE receipt_id = ? ORDER BY line_no", (receipt_id,)
    ).fetchall()


def cmd_report(db: sqlite3.Connection, month: str) -> None:
    receipts = month_rows(db, month)
    if not receipts:
        print(f"{month}: レシートなし")
        return
    by_category: dict[str, int] = {}
    by_store: dict[str, int] = {}
    for r in receipts:
        for category, amount in allocate(r["total"], items_of(db, r["id"])).items():
            by_category[category] = by_category.get(category, 0) + amount
        by_store[r["store_name"]] = by_store.get(r["store_name"], 0) + (r["total"] or 0)
    total = sum(r["total"] or 0 for r in receipts)
    review = sum(1 for r in receipts if r["status"] == "needs_review")
    print(f"{month}  合計 {total:,}円  レシート {len(receipts)}枚  要確認 {review}枚")
    print("\nカテゴリ別")
    for category, amount in sorted(by_category.items(), key=lambda kv: -kv[1]):
        pct = amount / total * 100 if total else 0
        print(f"  {category:<12} {amount:>9,}円  {pct:5.1f}%")
    print("\n店別（上位10）")
    for store, amount in sorted(by_store.items(), key=lambda kv: -kv[1])[:10]:
        print(f"  {store:<20} {amount:>9,}円")


def cmd_list(db: sqlite3.Connection, month: str) -> None:
    for r in month_rows(db, month):
        mark = " [要確認]" if r["status"] == "needs_review" else ""
        print(
            f"#{r['id']:<5} {r['purchased_on'] or '----------'} {r['store_name']:<20}"
            f" {r['total'] if r['total'] is not None else '?':>8}円{mark}"
        )


def cmd_show(db: sqlite3.Connection, receipt_id: int) -> None:
    r = db.execute("SELECT * FROM receipts WHERE id = ?", (receipt_id,)).fetchone()
    if r is None:
        raise SystemExit(f"receipt #{receipt_id} not found")
    tax = "税込" if r["tax_included"] else "税抜"
    print(
        f"#{r['id']} {r['purchased_on']} {r['purchased_time'] or ''} {r['store_name']}"
    )
    print(f"合計 {r['total']}円（明細は{tax}）  8%税 {r['tax_8']}  10%税 {r['tax_10']}")
    print(f"支払い {r['payment_method']}  状態 {r['status']}")
    for issue in json.loads(r["issues"]):
        print(f"  ! {issue}")
    if r["notes"]:
        print(f"メモ: {r['notes']}")
    print(f"画像: {r['image_path']}")
    for item in items_of(db, receipt_id):
        rate = f"{item['tax_rate']}%" if item["tax_rate"] else ""
        print(
            f"  item {item['id']:<6} {item['name']:<24} x{item['quantity']}"
            f" {item['amount']:>7}円 {rate:>3} {item['category']} ({item['category_source']})"
        )


def cmd_review(db: sqlite3.Connection) -> None:
    rows = db.execute(
        "SELECT * FROM receipts WHERE status = 'needs_review' ORDER BY purchased_on, id"
    ).fetchall()
    if not rows:
        print("要確認のレシートはありません")
    for r in rows:
        issues = " / ".join(json.loads(r["issues"]))
        print(f"#{r['id']:<5} {r['purchased_on']} {r['store_name']}  {issues}")


def cmd_set_category(
    config: Config, db: sqlite3.Connection, item_ids: list[int], category: str
) -> None:
    if category not in [*config.categories, UNCATEGORIZED]:
        raise SystemExit(f"unknown category: {category}")
    for item_id in item_ids:
        cur = db.execute(
            "UPDATE items SET category = ?, category_source = 'manual' WHERE id = ?",
            (category, item_id),
        )
        if cur.rowcount == 0:
            raise SystemExit(f"item {item_id} not found")
    db.commit()


def cmd_resolve(db: sqlite3.Connection, receipt_id: int) -> None:
    cur = db.execute(
        "UPDATE receipts SET status = 'ok' WHERE id = ? AND status = 'needs_review'",
        (receipt_id,),
    )
    db.commit()
    if cur.rowcount == 0:
        raise SystemExit(f"receipt #{receipt_id} is not waiting for review")


def cmd_recategorize(config: Config, db: sqlite3.Connection) -> None:
    """Re-apply the rules to every item that was not set by hand."""
    changed = 0
    rows = db.execute(
        "SELECT items.*, receipts.store_name, receipts.raw_json FROM items"
        " JOIN receipts ON receipts.id = items.receipt_id"
        " WHERE items.category_source != 'manual'"
    ).fetchall()
    for row in rows:
        model_items = json.loads(row["raw_json"])["items"]
        item = {
            "name": row["name"],
            "category": model_items[row["line_no"] - 1]["category"],
        }
        category, source = categorize(config, row["store_name"], item)
        if (category, source) != (row["category"], row["category_source"]):
            db.execute(
                "UPDATE items SET category = ?, category_source = ? WHERE id = ?",
                (category, source, row["id"]),
            )
            changed += 1
    db.commit()
    print(f"{changed} 品目を更新しました")


def cmd_export(db: sqlite3.Connection, month: str) -> None:
    writer = csv.writer(sys.stdout)
    writer.writerow(
        [
            "receipt_id",
            "date",
            "time",
            "store",
            "payment",
            "item",
            "quantity",
            "amount",
            "tax_rate",
            "category",
            "receipt_total",
            "status",
        ]
    )
    for r in month_rows(db, month):
        for item in items_of(db, r["id"]):
            writer.writerow(
                [
                    r["id"],
                    r["purchased_on"],
                    r["purchased_time"],
                    r["store_name"],
                    r["payment_method"],
                    item["name"],
                    item["quantity"],
                    item["amount"],
                    item["tax_rate"],
                    item["category"],
                    r["total"],
                    r["status"],
                ]
            )


def cmd_usage(db: sqlite3.Connection) -> None:
    for row in db.execute(
        "SELECT model, COUNT(*) AS n, SUM(input_tokens) AS input,"
        " SUM(output_tokens) AS output FROM receipts GROUP BY model"
    ):
        print(
            f"{row['model']}: {row['n']}枚  入力 {row['input']:,} / 出力 {row['output']:,}"
            f" トークン（1枚平均 {row['input'] // row['n']:,} / {row['output'] // row['n']:,}）"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser(
        "ingest", help="read receipts in the inbox (given files are copied, not moved)"
    )
    p.add_argument("files", nargs="*", type=Path)
    this_month = datetime.now().astimezone().strftime("%Y-%m")
    for name, help_text in (
        ("report", "category and store totals for a month"),
        ("list", "receipts in a month"),
        ("export", "items in a month as CSV"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("month", nargs="?", default=this_month, help="YYYY-MM")
    p = sub.add_parser("show", help="one receipt with its items")
    p.add_argument("receipt_id", type=int)
    sub.add_parser("review", help="receipts that need a manual check")
    p = sub.add_parser("resolve", help="mark a checked receipt as ok")
    p.add_argument("receipt_id", type=int)
    p = sub.add_parser("set-category", help="set the category of items by hand")
    p.add_argument("category")
    p.add_argument("item_ids", nargs="+", type=int)
    sub.add_parser("recategorize", help="re-apply the rules after editing the config")
    sub.add_parser("usage", help="token usage per model")
    args = parser.parse_args()

    config = Config.load(args.config)
    db = connect(config.db_path)
    match args.command:
        case "ingest":
            files = args.files or inbox_images(config.inbox_dir)
            if not files:
                log("no images in the inbox")
                return
            extract = claude_extractor(config, load_api_key())
            if ingest(config, db, extract, files, copy=bool(args.files)):
                sys.exit(1)
        case "report":
            cmd_report(db, args.month)
        case "list":
            cmd_list(db, args.month)
        case "export":
            cmd_export(db, args.month)
        case "show":
            cmd_show(db, args.receipt_id)
        case "review":
            cmd_review(db)
        case "resolve":
            cmd_resolve(db, args.receipt_id)
        case "set-category":
            cmd_set_category(config, db, args.item_ids, args.category)
        case "recategorize":
            cmd_recategorize(config, db)
        case "usage":
            cmd_usage(db)


if __name__ == "__main__":
    main()
