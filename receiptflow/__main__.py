"""python -m receiptflow            -> open the local web UI
python -m receiptflow PHOTO ...  -> read the photos, write one PDF per month and print the table, no UI
"""
from __future__ import annotations

import argparse
import shutil
import threading
import webbrowser
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(prog="receiptflow", description="Receipt photos -> one PDF page per month + a table to copy (all local)")
    ap.add_argument("photos", nargs="*", type=Path, help="photos to process without the UI")
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--name", default="", help="name for the PDF title and file name (optional)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    from . import pipeline

    if args.photos:
        job = pipeline.new_job()
        for i, p in enumerate(args.photos):
            shutil.copy(p, job / "photos" / f"{i:02d}_{p.name}")
        rows = pipeline.scan_job(job)
        for r in rows:
            r["skip"] = not r["date"] or r["amount"] is None
            warn = ("  ! " + "; ".join(r["warnings"])) if r["warnings"] else ""
            print(f"{r['date'] or '??????????'}  {r['amount'] if r['amount'] is not None else '?':>8}  {r['source'] or '-':3}{warn}")
        for m in pipeline.export(job, rows, name=args.name):
            print(f"\n{m['month']}: {m['count']} receipts, {m['total']:.2f} EUR -> output/{m['pdf']}  (not verified: check them)")
            items = sorted((r for r in rows if not r["skip"] and r["date"].startswith(m["key"])), key=lambda r: (r["date"], r["time"]))
            for n, r in enumerate(items, 1):
                y, mo, d = r["date"].split("-")
                print(f"{n}\t{d}/{mo}/{y}\t{r['amount']:.2f}")
        return

    from .app import app

    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, [url]).start()
    print(f"Receipt Flow running at {url}  (Ctrl+C to stop)")
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
