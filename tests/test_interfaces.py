"""CLI, REST API and MCP server all give: date, amount, from_code, confidence per receipt."""
import asyncio
import base64
import datetime as dt
import io
import json
from pathlib import Path

import pytest

from receiptflow import api, cli, detect, extract, mcp_server, parse

FIXTURE = Path(__file__).parent / "fixtures" / "oct_2026_three_fuel.jpeg"
# Real receipt photo, kept out of the public repo: photo tests run where it exists.
needs_photo = pytest.mark.skipif(not FIXTURE.exists(), reason="tests/fixtures/ (real receipt photos) not present")
EXPECTED = [
    {"date": "2026-10-13", "amount": 30.0, "from_code": True, "confidence": 0.99},
    {"date": "2026-10-13", "amount": 50.0, "from_code": True, "confidence": 0.99},
    {"date": "2026-10-20", "amount": 20.0, "from_code": True, "confidence": 0.99},
]


def by_date(rs):
    return sorted(rs, key=lambda r: (r["date"] or "", r["amount"] or 0))


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("RECEIPTFLOW_DB", str(tmp_path / "requests.sqlite3"))


@pytest.fixture(scope="module")
def photo_bytes():
    if not FIXTURE.exists():
        pytest.skip("tests/fixtures/ not present")
    return FIXTURE.read_bytes()


@needs_photo
def test_extract_only_the_four_fields():
    rs = extract.read_photo(FIXTURE)
    assert by_date(rs) == EXPECTED
    assert all(set(r) == {"date", "amount", "from_code", "confidence"} for r in rs)


def test_not_an_image(tmp_path):
    bad = tmp_path / "notes.txt"
    bad.write_text("hello")
    with pytest.raises(ValueError, match="Not a readable image"):
        extract.read_photo(bad)
    assert extract.read_many([str(bad), str(tmp_path / "missing.jpg")])[1]["error"].startswith("No such file")


@needs_photo
def test_cli_json(capsys, tmp_path):
    assert cli.main(["--json", str(FIXTURE)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out[0]["file"] == str(FIXTURE) and by_date(out[0]["receipts"]) == EXPECTED
    assert cli.main([str(tmp_path / "missing.jpg")]) == 1


@needs_photo
def test_rest_multipart_and_raw(photo_bytes):
    c = api.app.test_client()
    assert c.get("/health").json == {"ok": True}
    r = c.post("/v1/receipts", data={"photo": [(io.BytesIO(photo_bytes), "oct.jpeg"), (io.BytesIO(b"junk"), "x.jpg")]},
               content_type="multipart/form-data")
    assert r.status_code == 200
    assert len(r.json["request_id"]) == 12
    first, second = r.json["results"]
    assert first["file"] == "oct.jpeg" and by_date(first["receipts"]) == EXPECTED
    assert "error" in second
    r = c.post("/v1/receipts", data=photo_bytes, content_type="image/jpeg")
    assert by_date(r.json["results"][0]["receipts"]) == EXPECTED
    assert c.post("/v1/receipts", data="hi", content_type="text/plain").status_code == 400


@needs_photo
def test_mcp_tools(photo_bytes):
    async def go():
        tools = {t.name for t in await mcp_server.server.list_tools()}
        assert tools == {"read_receipts", "read_receipt_image", "rate_request", "list_requests", "request_stats",
                         "success_summary"}
        return await mcp_server.server.call_tool("read_receipt_image", {"image_base64": base64.b64encode(photo_bytes).decode()})

    res = asyncio.run(go())
    payload = res.structured_content
    payload = payload.get("result", payload)
    assert len(payload["request_id"]) == 12
    assert by_date(payload["results"][0]["receipts"]) == EXPECTED
    bad = mcp_server.read_receipt_image("@@not base64@@")
    assert bad["results"][0]["error"] == "image_base64 is not valid base64"
    assert mcp_server.rate_request(payload["request_id"], "good")["rating"] == "good"
    assert mcp_server.success_summary(2) == {"last_n": 2, "requests": 2, "verified": 1, "good": 1, "bad": 0,
                                             "success_pct": 100.0, "pending_in_window": 1, "pending_total": 1}
    assert mcp_server.success_summary(0) == {"error": "n must be at least 1"}


# ---- confidence rules (detect._confidence) --------------------------------------------------

def rec(**kw):
    r = detect.Receipt(photo="p", bbox=(0, 0, 1, 1), date=dt.date(2026, 10, 1), amount=10.0)
    for k, v in kw.items():
        setattr(r, k, v)
    return r


def test_confidence_rules():
    day = dt.date(2026, 10, 1)
    qr_exact = parse.Found(date=day, amount=10.0)
    assert detect._confidence(rec(source="qr", certain=True), qr_exact, parse.Found()) == 0.99
    assert detect._confidence(rec(source="qr"), parse.Found(amount=10.0), parse.Found(date=day)) == 0.7
    ambiguous = parse.Found(date=day, amount=10.0, candidates=[110.0])
    assert detect._confidence(rec(source="qr"), ambiguous, parse.Found()) == 0.5
    assert detect._confidence(rec(source="ocr"), None, parse.Found(amount=10.0, checked=True)) == 0.65
    assert detect._confidence(rec(source="ocr"), None, parse.Found(amount=10.0)) == 0.5
    assert detect._confidence(rec(source="ocr"), None, parse.Found(amount=10.0, candidates=[12.0])) == 0.35
    assert detect._confidence(rec(source="ocr", amount=None), None, parse.Found()) == 0.0
    assert detect._confidence(rec(source="qr", date=None), qr_exact, parse.Found()) == 0.0


def test_ocr_cross_check_sets_checked():
    fuel = "ΑΜΟΛΥΒΔΗ\nΠΟΣΟΤΗΤΑ ΛΙΤΡΩΝ 10,000\nΤΙΜΗ ΛΙΤΡΟΥ 1,800\nΣΥΝΟΛΟ 18,00\n01/10/2026"
    f = parse.parse_ocr(fuel)
    assert (f.amount, f.checked) == (18.0, True)
    assert parse.parse_ocr("ΣΥΝΟΛΟ 18,00\n01/10/2026").checked is False
