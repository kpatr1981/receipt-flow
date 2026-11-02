"""Photos in -> receipts (with crops) -> one single-page PDF per month."""
from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import time
import uuid
from collections import defaultdict
from pathlib import Path

import cv2
from PIL import Image

from . import detect, parse, pdfpage

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "output"
JOBS = OUTPUT / ".jobs"
MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".bmp"}


def new_job() -> Path:
    _forget_old_jobs()
    job = JOBS / uuid.uuid4().hex[:12]
    (job / "photos").mkdir(parents=True)
    (job / "crops").mkdir()
    return job


def _forget_old_jobs(days: int = 7) -> None:
    """Uploaded photos and crops are working files; the results live in output/."""
    if not JOBS.is_dir():
        return
    cutoff = time.time() - days * 86400
    for job in JOBS.iterdir():
        if job.is_dir() and job.stat().st_mtime < cutoff:
            shutil.rmtree(job, ignore_errors=True)


def scan_job(job: Path) -> list[dict]:
    """Find and read every receipt in the job's photos; save a crop of each."""
    rows = []
    for photo in sorted((job / "photos").iterdir()):
        if photo.suffix.lower() not in IMAGE_EXT:
            continue
        for rec in detect.scan_photo(photo):
            rid = f"r{len(rows) + 1}"
            cv2.imwrite(str(job / "crops" / f"{rid}.jpg"), rec.crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            rows.append({
                "id": rid,
                "photo": rec.photo,
                "date": rec.date.isoformat() if rec.date else "",
                "time": rec.time or "",
                "amount": rec.amount,
                "category": rec.category,
                "description": parse.CATEGORY_LABELS.get(rec.category, ""),
                "source": rec.source,
                "certain": rec.certain,
                "warnings": rec.warnings,
                "qr": rec.qr,
            })
    rows.sort(key=lambda r: (r["date"] or "9999", r["time"]))
    mark_duplicates(rows)
    (job / "receipts.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False))
    return rows


def _shown(photo: str) -> str:
    return photo.split("_", 1)[1] if photo[:2].isdigit() and "_" in photo else photo


def _describe(r: dict) -> str:
    when = "/".join(reversed(r["date"].split("-"))) if r["date"] else "no date"
    amount = f"{r['amount']:.2f} €" if r["amount"] is not None else "no amount"
    return f"the {when}, {amount} receipt from {_shown(r['photo'])}"


def mark_duplicates(rows: list[dict]) -> None:
    """Same QR code = same receipt: the later copy starts unused. Same date, time and amount = maybe."""
    by_qr: dict[str, dict] = {}
    by_stamp: dict[tuple, dict] = {}
    for r in rows:
        r.setdefault("skip", False)
        first = next((by_qr[q] for q in r.get("qr", []) if q in by_qr), None)
        if first is not None:
            r["skip"] = True
            r["duplicate_of"] = first["id"]
            r["warnings"].insert(0, f"Duplicate: same QR code as {_describe(first)}. Left out; tick Use to keep it.")
        else:
            for q in r.get("qr", []):
                by_qr[q] = r
            if r["date"] and r["time"] and r["amount"] is not None:
                stamp = (r["date"], r["time"], r["amount"])
                if stamp in by_stamp:
                    r["warnings"].insert(0, f"Possible duplicate of {_describe(by_stamp[stamp])}: same date, time and amount.")
                else:
                    by_stamp[stamp] = r


def photo_names(job: Path) -> list[str]:
    return [p.name for p in sorted((job / "photos").iterdir()) if p.suffix.lower() in IMAGE_EXT]


def add_manual(job: Path, photo: str) -> dict:
    """A receipt the tool missed: the user types its values; the page shows the whole (upright) photo."""
    if photo not in photo_names(job):
        raise ValueError("Unknown photo")
    img = detect.load_photo(job / "photos" / photo)
    img = detect.turn(img, detect.upright_turn(img, detect.read_qrs(img)))
    s = min(1.0, 2000 / max(img.shape[:2]))
    img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    n = len(list((job / "crops").glob("m*.jpg"))) + 1
    rid = f"m{n}"
    cv2.imwrite(str(job / "crops" / f"{rid}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return {"id": rid, "photo": photo, "date": "", "time": "", "amount": None, "category": "other",
            "description": "", "source": "manual", "certain": False,
            "warnings": ["Added by hand: the PDF page shows the whole photo for this one"]}


MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def _surname(name: str) -> str:
    """Last word of the name, safe for a file name ("" when there is no name)."""
    parts = name.split()
    return re.sub(r"[^\w]+", "", parts[-1]).lower() if parts else ""


def export(job: Path, rows: list[dict], out_dir: Path = OUTPUT, name: str = "") -> list[dict]:
    """One single-page PDF per month, receipts numbered in date order. Returns what was written.

    `name` (optional) goes in the page title and, as a surname, in the file name."""
    name = " ".join(name.split())[:80]
    by_month: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for r in rows:
        if r.get("skip"):
            continue
        if not r.get("date") or r.get("amount") in (None, ""):
            raise ValueError(f"Receipt {r['id']} needs a date and an amount first")
        d = dt.date.fromisoformat(r["date"])
        by_month[(d.year, d.month)].append(r)

    written = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for (year, month), items in sorted(by_month.items()):
        items.sort(key=lambda r: (r["date"], r.get("time") or ""))
        surname = _surname(name)
        stem = f"expenses_{MONTH_ABBR[month - 1]}_{year}" + (f"_{surname}" if surname else "")
        crops = [Image.open(job / "crops" / f"{r['id']}.jpg").convert("RGB") for r in items]
        title = f"{name}  ·  {MONTHS[month - 1]} {year}" if name else f"{MONTHS[month - 1]} {year}"
        page = pdfpage.compose_month_page(crops, list(range(1, len(crops) + 1)), title)
        pdf_path = out_dir / f"{stem}.pdf"
        pdfpage.save_pdf(page, pdf_path)
        page.convert("RGB").resize((page.width // 3, page.height // 3)).save(job / f"{stem}.png")
        written.append({
            "key": f"{year}-{month:02d}",
            "month": f"{MONTHS[month - 1]} {year}",
            "count": len(items),
            "total": round(sum(float(r["amount"]) for r in items), 2),
            "pdf": pdf_path.name,
            "preview": f"{stem}.png",
        })
    return written
