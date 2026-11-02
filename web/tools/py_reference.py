"""Python results on every sample photo, for comparing the JS port: web/test/corpus/py_results.json"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")
from receiptflow import detect  # noqa: E402

photos = sorted(p for p in Path("samples").rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".heic", ".png"})
out = {}
for photo in photos:
    recs = detect.scan_photo(photo)
    out[str(photo)] = [{"date": r.date.isoformat() if r.date else None, "time": r.time, "amount": r.amount,
                        "source": r.source, "certain": r.certain, "bbox": list(r.bbox)} for r in recs]
    print(photo.name, len(recs), file=sys.stderr)
Path("web/test/corpus/py_results.json").write_text(json.dumps(out, indent=1))
