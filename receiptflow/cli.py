"""receipt-read PHOTO ...   -> date, amount, read from code or not, confidence for every receipt

    receipt-read photo.jpg              table
    receipt-read --json a.jpg b.heic    JSON: [{"file", "receipts": [{date, amount, from_code, confidence}], "error"?}]

Exit code 0 when every photo was read, 1 when one or more could not be opened.
"""
from __future__ import annotations

import argparse
import json
import sys

from .extract import read_many


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="receipt-read", description="Read date and amount from receipt photos (all local).")
    ap.add_argument("photos", nargs="+", help="photo files (JPEG, PNG, HEIC...); one photo can hold several receipts")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    args = ap.parse_args(argv)

    results = read_many(args.photos)
    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        for res in results:
            print(res["file"])
            if "error" in res:
                print(f"  error: {res['error']}")
            elif not res["receipts"]:
                print("  no receipt found")
            for r in res["receipts"]:
                amount = f"{r['amount']:.2f}" if r["amount"] is not None else "?"
                print(f"  {r['date'] or '?':10}  {amount:>9}  {'code' if r['from_code'] else 'text':4}  {r['confidence']:.2f}")
    return 1 if any("error" in r for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
