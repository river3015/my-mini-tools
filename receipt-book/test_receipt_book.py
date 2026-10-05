"""Run with: uv run --with pytest pytest receipt-book (no API calls)."""

from __future__ import annotations

import struct
import subprocess
import zlib
from pathlib import Path

import pytest

import receipt_book as rb


def png(path: Path, width: int, height: int, seed: int = 0) -> Path:
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + bytes([seed % 256]) * width for _ in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return path


def receipt(**overrides) -> dict:
    data = {
        "is_receipt": True,
        "store_name": "スーパーA",
        "purchased_on": "2026-10-03",
        "purchased_time": "18:20",
        "payment_method": "credit_card",
        "total": 1080,
        "tax_included": True,
        "tax_8": 80,
        "tax_10": None,
        "items": [
            {
                "name": "牛乳",
                "quantity": 1,
                "amount": 300,
                "tax_rate": 8,
                "category": "食費",
            },
            {
                "name": "食パン",
                "quantity": 2,
                "amount": 400,
                "tax_rate": 8,
                "category": "食費",
            },
            {
                "name": "値引",
                "quantity": 1,
                "amount": -20,
                "tax_rate": 8,
                "category": "食費",
            },
            {
                "name": "洗剤",
                "quantity": 1,
                "amount": 400,
                "tax_rate": 10,
                "category": "日用品",
            },
        ],
        "notes": "",
    }
    data.update(overrides)
    return data


def fake_extractor(results: list[dict]) -> rb.Extractor:
    queue = list(results)

    def extract(image: bytes, media_type: str) -> rb.Extraction:
        assert media_type == "image/jpeg" and image[:2] == b"\xff\xd8"
        return rb.Extraction(queue.pop(0), "fake-model", 1500, 800)

    return extract


@pytest.fixture
def env(tmp_path: Path):
    config = rb.Config(
        inbox_dir=tmp_path / "inbox",
        archive_dir=tmp_path / "archive",
        db_path=tmp_path / "db" / "receipts.db",
        store_rules={"カフェ": "外食"},
        item_rules={"洗剤": "日用品"},
    )
    config.inbox_dir.mkdir()
    return config, rb.connect(config.db_path)


def test_find_issues_tax_included_ok():
    assert rb.find_issues(receipt()) == []


def test_find_issues_tax_excluded_adds_tax():
    data = receipt(tax_included=False, total=1176, tax_8=56, tax_10=40)
    assert rb.find_issues(data) == []


def test_find_issues_mismatch_and_missing():
    issues = rb.find_issues(
        receipt(total=2000, purchased_on=None, notes="店名が一部かすれている")
    )
    assert any("合わない" in i for i in issues)
    assert "日付が読み取れない" in issues
    assert "読み取りに不確かな箇所がある" in issues


def test_categorize_precedence(env):
    config, _ = env
    assert rb.categorize(config, "カフェB", {"name": "洗剤", "category": "その他"}) == (
        "日用品",
        "item_rule",
    )
    assert rb.categorize(config, "カフェB", {"name": "ラテ", "category": "食費"}) == (
        "外食",
        "store_rule",
    )
    assert rb.categorize(
        config, "スーパー", {"name": "謎", "category": "存在しない"}
    ) == (rb.UNCATEGORIZED, "model")


def test_allocate_spreads_total():
    items = [{"amount": 300, "category": "食費"}, {"amount": 100, "category": "日用品"}]
    assert rb.allocate(440, items) == {"食費": 330, "日用品": 110}
    assert sum(rb.allocate(1001, items * 3).values()) == 1001
    assert rb.allocate(500, [{"amount": 0, "category": "食費"}]) == {
        rb.UNCATEGORIZED: 500
    }


def test_ingest_moves_and_flags(env, tmp_path, capsys):
    config, db = env
    png(config.inbox_dir / "a.png", 40, 3000, seed=1)
    png(config.inbox_dir / "b.png", 40, 40, seed=2)
    png(config.inbox_dir / "c.png", 40, 40, seed=3)
    png(config.inbox_dir / "d.png", 40, 40, seed=4)
    extract = fake_extractor(
        [
            receipt(),
            receipt(store_name="カフェB", total=999),
            receipt(is_receipt=False, items=[]),
            receipt(),  # same store, time and total as a.png
        ]
    )
    failures = rb.ingest(config, db, extract, rb.inbox_images(config.inbox_dir))

    assert failures == 0
    assert list(config.inbox_dir.iterdir()) == []
    processed = sorted(
        p.name for p in (config.archive_dir / "processed" / "2026" / "10").iterdir()
    )
    assert processed == ["2026-10-03_カフェB.png", "2026-10-03_スーパーA.png"]
    assert [p.name for p in (config.archive_dir / "rejected").iterdir()] == ["c.png"]
    assert [p.name for p in (config.archive_dir / "duplicates").iterdir()] == ["d.png"]

    rows = db.execute("SELECT store_name, status FROM receipts ORDER BY id").fetchall()
    assert [tuple(r) for r in rows] == [
        ("スーパーA", "ok"),
        ("カフェB", "needs_review"),
    ]
    cafe_items = db.execute(
        "SELECT category, category_source FROM items WHERE receipt_id = 2"
    ).fetchall()
    assert {tuple(r) for r in cafe_items} == {
        ("外食", "store_rule"),
        ("日用品", "item_rule"),
    }

    rb.cmd_report(db, "2026-10")
    out = capsys.readouterr().out
    assert "合計 2,079円" in out and "要確認 1枚" in out


def test_ingest_skips_already_imported_and_keeps_given_files(env, tmp_path):
    config, db = env
    original = png(tmp_path / "x.png", 40, 40, seed=9)
    rb.ingest(config, db, fake_extractor([receipt()]), [original], copy=True)
    assert original.exists()
    rb.ingest(config, db, fake_extractor([]), [original], copy=True)
    assert db.execute("SELECT COUNT(*) FROM receipts").fetchone()[0] == 1
    assert (config.archive_dir / "duplicates" / "x.png").exists()


def test_ingest_failure_leaves_file(env):
    config, db = env
    path = png(config.inbox_dir / "a.png", 40, 40)

    def failing(image: bytes, media_type: str) -> rb.Extraction:
        raise rb.ExtractionError("boom")

    assert rb.ingest(config, db, failing, [path]) == 1
    assert path.exists()


def test_prepare_image_caps_long_edge(tmp_path):
    image, media_type = rb.prepare_image(png(tmp_path / "tall.png", 100, 3000), 2048)
    out = tmp_path / "out.jpg"
    out.write_bytes(image)
    info = subprocess.run(
        ["sips", "-g", "pixelHeight", str(out)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert media_type == "image/jpeg" and "pixelHeight: 2048" in info


def test_recategorize_keeps_manual(env):
    config, db = env
    path = png(config.inbox_dir / "a.png", 40, 40)
    rb.ingest(config, db, fake_extractor([receipt()]), [path])
    rb.cmd_set_category(config, db, [1], "外食")
    config.item_rules = {"牛乳": "その他", "パン": "その他"}
    rb.cmd_recategorize(config, db)
    rows = db.execute(
        "SELECT name, category, category_source FROM items ORDER BY line_no"
    ).fetchall()
    assert [tuple(r) for r in rows][:2] == [
        ("牛乳", "外食", "manual"),
        ("食パン", "その他", "item_rule"),
    ]


def test_schema_is_strict():
    schema = rb.receipt_schema(["食費"])
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    item = schema["properties"]["items"]["items"]
    assert set(item["required"]) == set(item["properties"])


def test_config_rejects_unknown_rule_category(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('[item_rules]\n"牛乳" = "飲み物"\n')
    with pytest.raises(SystemExit):
        rb.Config.load(path)
