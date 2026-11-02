import shutil
from pathlib import Path

import pytest

from receiptflow import pipeline

FIXTURE = Path(__file__).parent / "fixtures" / "oct_2026_three_fuel.jpeg"

# The fixtures are real receipt photos, kept out of the public repo: these tests run where they exist.
pytestmark = pytest.mark.skipif(not FIXTURE.exists(), reason="tests/fixtures/ (real receipt photos) not present")


@pytest.fixture(scope="module")
def scanned(tmp_path_factory):
    pipeline.JOBS = tmp_path_factory.mktemp("jobs")
    job = pipeline.new_job()
    shutil.copy(FIXTURE, job / "photos")
    return job, pipeline.scan_job(job)


def test_three_fuel_receipts(scanned):
    _, rows = scanned
    got = [(r["date"], r["amount"], r["category"], r["source"]) for r in rows]
    assert got == [("2026-10-13", 30.0, "fuel", "qr"), ("2026-10-13", 50.0, "fuel", "qr"), ("2026-10-20", 20.0, "fuel", "qr")]


def test_one_pdf_per_month(scanned, tmp_path):
    job, rows = scanned
    rows = [dict(r) for r in rows]
    rows[2]["date"] = "2026-11-03"  # move one receipt to November
    written = pipeline.export(job, rows, out_dir=tmp_path)
    assert [(m["key"], m["month"], m["count"], m["total"]) for m in written] == [
        ("2026-10", "October 2026", 2, 80.0), ("2026-11", "November 2026", 1, 20.0)]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["expenses_nov_2026.pdf", "expenses_oct_2026.pdf"]
    import re
    for pdf in tmp_path.glob("*.pdf"):
        assert len(re.findall(rb"/Type\s*/Page[^s]", pdf.read_bytes())) == 1


def test_skipped_and_incomplete(scanned, tmp_path):
    job, rows = scanned
    rows = [dict(r) for r in rows]
    rows[0]["skip"] = True
    assert pipeline.export(job, rows, out_dir=tmp_path)[0]["count"] == 2
    rows[1]["amount"] = None
    with pytest.raises(ValueError):
        pipeline.export(job, rows, out_dir=tmp_path)


def test_sideways_touching_receipts(tmp_path_factory):
    """Sep 2025 photo: taken sideways, 4 receipts touching, handwriting, two without a readable QR."""
    pipeline.JOBS = tmp_path_factory.mktemp("jobs_sep")
    job = pipeline.new_job()
    shutil.copy(Path(__file__).parent / "fixtures" / "sep_2025_sideways_mixed.jpeg", job / "photos")
    rows = pipeline.scan_job(job)
    assert len(rows) == 4  # a handwritten name + month is not a receipt
    by_amount = {r["amount"]: r for r in rows}
    assert by_amount[60.01]["date"] == "2025-09-02" and by_amount[60.01]["category"] == "fuel"
    assert by_amount[10.0]["date"] == "2025-09-25" and by_amount[10.0]["certain"]
    assert by_amount[10.52]["category"] == "taxi" and not by_amount[10.52]["certain"]
    assert sum(r["certain"] for r in rows) == 1  # everything else waits for the user's tick


def test_export_refuses_unverified(scanned):
    from receiptflow.app import app
    job, rows = scanned
    pipeline.JOBS = job.parent
    client = app.test_client()
    rows = [dict(r, verified=False) for r in rows]
    assert client.post(f"/api/export/{job.name}", json={"receipts": rows}).status_code == 400


def test_add_by_hand(scanned, tmp_path):
    job, rows = scanned
    pipeline.JOBS = job.parent
    row = pipeline.add_manual(job, pipeline.photo_names(job)[0])
    assert row["source"] == "manual" and (job / "crops" / f"{row['id']}.jpg").exists()
    row.update(date="2026-10-21", amount=7.5, column="E", verified=True)
    written = pipeline.export(job, [*rows, row], out_dir=tmp_path)
    assert written[0]["count"] == 4 and written[0]["total"] == 107.5


def test_sideways_receipts_with_upright_handwriting(tmp_path_factory):
    """Jul 2025: receipts lie sideways, the handwriting is upright, no QR decodes. It must turn the right way."""
    pipeline.JOBS = tmp_path_factory.mktemp("jobs_jul")
    job = pipeline.new_job()
    shutil.copy(Path(__file__).parent / "fixtures" / "jul_2025_sideways_upright_handwriting.jpeg", job / "photos")
    rows = pipeline.scan_job(job)
    assert len(rows) == 4
    got = {(r["date"], r["amount"]) for r in rows}
    assert ("2025-07-15", 50.0) in got and ("2025-07-10", 15.48) in got
    assert not any(r["certain"] for r in rows)  # nothing from a QR here: all wait for the user's tick


def test_same_photo_file_twice_is_skipped(tmp_path_factory):
    from receiptflow.app import app
    pipeline.JOBS = tmp_path_factory.mktemp("jobs_dup_file")
    data = FIXTURE.read_bytes()
    import io
    res = app.test_client().post("/api/photos", data={"photos": [(io.BytesIO(data), "a.jpeg"), (io.BytesIO(data), "a (1).jpeg")]},
                                 content_type="multipart/form-data").get_json()
    assert res["skipped"] == [{"photo": "a (1).jpeg", "same_as": "a.jpeg"}]
    assert len(res["receipts"]) == 3


def test_same_receipts_in_two_photos(tmp_path_factory):
    """A re-encoded copy (different file, same receipts): matched by QR code, the copies start unused."""
    from PIL import Image
    pipeline.JOBS = tmp_path_factory.mktemp("jobs_dup_qr")
    job = pipeline.new_job()
    shutil.copy(FIXTURE, job / "photos" / "00_first.jpeg")
    Image.open(FIXTURE).save(job / "photos" / "01_second.jpeg", quality=80)
    rows = pipeline.scan_job(job)
    assert len(rows) == 6
    dupes = [r for r in rows if r.get("duplicate_of")]
    assert len(dupes) == 3 and all(r["skip"] for r in dupes)
    assert all("Duplicate: same QR code" in r["warnings"][0] for r in dupes)
    assert sum(not r["skip"] for r in rows) == 3


def test_possible_duplicate_same_date_time_amount():
    rows = [
        {"id": "r1", "photo": "00_a.jpg", "date": "2025-07-10", "time": "10:21", "amount": 15.48, "warnings": [], "qr": []},
        {"id": "r2", "photo": "01_b.jpg", "date": "2025-07-10", "time": "10:21", "amount": 15.48, "warnings": [], "qr": []},
        {"id": "r3", "photo": "01_b.jpg", "date": "2025-07-10", "time": "18:00", "amount": 15.48, "warnings": [], "qr": []},
    ]
    pipeline.mark_duplicates(rows)
    assert not rows[1]["skip"] and rows[1]["warnings"][0].startswith("Possible duplicate of the 10/07/2025, 15.48 € receipt from a.jpg")
    assert rows[2]["warnings"] == []


def test_optional_name_on_pdf(scanned, tmp_path):
    job, rows = scanned
    assert pipeline.export(job, rows, out_dir=tmp_path)[0]["pdf"] == "expenses_oct_2026.pdf"
    assert pipeline.export(job, rows, out_dir=tmp_path, name="  Maria   Papadopoulou ")[0]["pdf"] == "expenses_oct_2026_papadopoulou.pdf"
