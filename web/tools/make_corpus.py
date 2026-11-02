"""Collect real OCR texts + QR payloads from samples/ and record what the Python parser makes of them.

The JS port must give identical results on this corpus (web/test/corpus.test.mjs).
Run from the project root: .venv/bin/python web/tools/make_corpus.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")
from receiptflow import detect, parse  # noqa: E402

out = {"ocr": [], "qr": []}
photos = sorted(p for p in Path("samples").rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".heic", ".png"})
for photo in photos:
    img = detect.load_photo(photo)
    for q in detect.read_qrs(img):
        f = parse.parse_qr(q.text)
        out["qr"].append({"text": q.text, "expect": None if f is None else {
            "date": f.date.isoformat() if f.date else None, "time": f.time, "amount": f.amount, "candidates": f.candidates}})
    img = detect.turn(img, detect.upright_turn(img, detect.read_qrs(img)))
    for region in detect.find_receipts(img):
        crop = detect.deskew(detect.crop_region(img, region))
        for text in detect.ocr_passes(crop):
            f = parse.parse_ocr(text)
            out["ocr"].append({"photo": photo.name, "text": text, "expect": {
                "date": f.date.isoformat() if f.date else None, "time": f.time, "amount": f.amount,
                "candidates": f.candidates, "guessed": f.guessed,
                "category": parse.guess_category(text), "receipt": parse.looks_like_receipt(text)}})
    print(photo.name, len(out["ocr"]), file=sys.stderr)
Path("web/test/corpus/parse_corpus.json").write_text(json.dumps(out, ensure_ascii=False, indent=0))
print("ocr texts:", len(out["ocr"]), "qr payloads:", len(out["qr"]))
