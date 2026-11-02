"""receipt-feedback: work through the request backlog from the terminal.

    receipt-feedback list [--all] [--limit N]    requests still waiting for a rating (--all: rated too)
    receipt-feedback rate ID good|bad [NOTE...]  record the verdict (again = replace)
    receipt-feedback stats [--json]              good/bad totals, by interface and by lowest confidence
    receipt-feedback summary [N]                 last N requests (default all): success rate, pending
"""
from __future__ import annotations

import argparse
import json
import sys

from . import backlog


def _print_request(r: dict) -> None:
    verdict = f"{r['rating'].upper()}" + (f" ({r['note']})" if r["note"] else "") if r["rating"] else "unrated"
    print(f"{r['request_id']}  {r['created'][:16].replace('T', ' ')} UTC  {r['interface']:4}  {verdict}")
    for res in r["results"]:
        print(f"    {res['file']}" + (f"  error: {res['error']}" if "error" in res else ""))
        for x in res["receipts"]:
            amount = f"{x['amount']:.2f}" if x["amount"] is not None else "?"
            print(f"      {x['date'] or '?':10}  {amount:>9}  {'code' if x['from_code'] else 'text':4}  {x['confidence']:.2f}")


def _print_table(title: str, rows: dict) -> None:
    print(f"\n{title}")
    for name, t in rows.items():
        pct = f"{t['good_pct']:5.1f}% good" if t["good_pct"] is not None else "     -     "
        print(f"  {name:28} {t['requests']:5} requests  {t['rated']:5} rated  {t['good']:4} good  {t['bad']:4} bad  {pct}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="receipt-feedback", description="Rate receipt reads good/bad and see the statistics.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list", help="requests waiting for a rating")
    ls.add_argument("--all", action="store_true", help="include rated requests")
    ls.add_argument("--limit", type=int, default=20)
    rt = sub.add_parser("rate", help="rate a request good or bad")
    rt.add_argument("request_id")
    rt.add_argument("rating", choices=backlog.RATINGS)
    rt.add_argument("note", nargs="*", help="what was wrong (optional)")
    st = sub.add_parser("stats", help="good/bad statistics")
    st.add_argument("--json", action="store_true")
    sm = sub.add_parser("summary", help="success rate and pending count over the last N requests")
    sm.add_argument("n", nargs="?", type=int, help="how many recent requests (default: all)")
    args = ap.parse_args(argv)

    if args.cmd == "list":
        reqs = backlog.backlog(unrated_only=not args.all, limit=args.limit)
        if not reqs:
            print("Nothing waiting for a rating." if not args.all else "No requests logged yet.")
        for r in reqs:
            _print_request(r)
    elif args.cmd == "rate":
        try:
            _print_request(backlog.rate(args.request_id, args.rating, " ".join(args.note)))
        except KeyError:
            print(f"Unknown request id: {args.request_id}", file=sys.stderr)
            return 1
    elif args.cmd == "summary":
        if args.n is not None and args.n < 1:
            print("N must be at least 1", file=sys.stderr)
            return 1
        s = backlog.summary(args.n)
        scope = f"last {s['requests']} requests" if args.n else f"all {s['requests']} requests"
        pct = f"{s['success_pct']}%" if s["success_pct"] is not None else "-"
        print(f"{scope}: {s['verified']} verified ({s['good']} good, {s['bad']} bad) -> success {pct}")
        print(f"pending verification: {s['pending_in_window']} of these, {s['pending_total']} overall")
    else:
        s = backlog.stats()
        if args.json:
            print(json.dumps(s, indent=2))
        else:
            _print_table("Overall", {"all requests": s["total"]})
            print(f"  {s['total']['unrated']} still unrated")
            _print_table("By interface", s["by_interface"])
            _print_table("By lowest confidence in the request", s["by_lowest_confidence"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
