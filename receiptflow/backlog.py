"""Request log + user feedback, shared by the REST API and the MCP server.

Every read gets a request id. The log keeps what was answered (file names and results, never the photos) so the
user can later rate each request good or bad. Ratings give the overall statistics, and per confidence band they
show whether the confidence numbers mean what they say.

Stored in SQLite: output/requests.sqlite3, or the file named by RECEIPTFLOW_DB.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import uuid
from collections import defaultdict
from contextlib import closing
from pathlib import Path

RATINGS = ("good", "bad")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    id          TEXT PRIMARY KEY,
    created     TEXT NOT NULL,           -- UTC, ISO 8601
    interface   TEXT NOT NULL,           -- rest | mcp
    files       INTEGER NOT NULL,
    receipts    INTEGER NOT NULL,
    from_code   INTEGER NOT NULL,        -- receipts whose amount came from the QR code / barcode
    min_conf    REAL,                    -- lowest receipt confidence (NULL: no receipt found)
    errors      INTEGER NOT NULL,        -- photos that could not be read
    results     TEXT NOT NULL,           -- the JSON answered
    rating      TEXT CHECK (rating IN ('good', 'bad')),
    note        TEXT,
    rated       TEXT
);
CREATE INDEX IF NOT EXISTS requests_created ON requests(created);
"""


def db_path() -> Path:
    env = os.environ.get("RECEIPTFLOW_DB")
    return Path(env) if env else Path(__file__).resolve().parent.parent / "output" / "requests.sqlite3"


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")  # REST threads + MCP process can write at once
    con.executescript(_SCHEMA)
    return con


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def log_request(interface: str, results: list[dict]) -> str:
    """Store one answered request; returns its id."""
    rid = uuid.uuid4().hex[:12]
    receipts = [r for res in results for r in res.get("receipts", [])]
    with closing(_connect()) as con, con:
        con.execute(
            "INSERT INTO requests (id, created, interface, files, receipts, from_code, min_conf, errors, results)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rid, _now(), interface, len(results), len(receipts), sum(1 for r in receipts if r["from_code"]),
             min((r["confidence"] for r in receipts), default=None), sum(1 for res in results if "error" in res),
             json.dumps(results, ensure_ascii=False)),
        )
    return rid


def _row(r: sqlite3.Row) -> dict:
    return {
        "request_id": r["id"], "created": r["created"], "interface": r["interface"],
        "results": json.loads(r["results"]), "rating": r["rating"], "note": r["note"], "rated": r["rated"],
    }


def get(request_id: str) -> dict | None:
    with closing(_connect()) as con:
        r = con.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
    return _row(r) if r else None


def rate(request_id: str, rating: str, note: str = "") -> dict:
    """Rate a request good or bad (rating again replaces the earlier one). Raises KeyError / ValueError."""
    rating = (rating or "").strip().lower()
    if rating not in RATINGS:
        raise ValueError('rating must be "good" or "bad"')
    with closing(_connect()) as con, con:
        cur = con.execute("UPDATE requests SET rating = ?, note = ?, rated = ? WHERE id = ?",
                          (rating, (note or "").strip()[:1000] or None, _now(), request_id))
        if cur.rowcount == 0:
            raise KeyError(request_id)
    return get(request_id)


def backlog(unrated_only: bool = True, limit: int = 50) -> list[dict]:
    """Newest first. By default only the requests still waiting for a rating."""
    limit = max(1, min(int(limit), 500))
    where = "WHERE rating IS NULL" if unrated_only else ""
    with closing(_connect()) as con:
        rows = con.execute(f"SELECT * FROM requests {where} ORDER BY created DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
    return [_row(r) for r in rows]


def _band(min_conf: float | None, errors: int) -> str:
    if errors:
        return "photo not readable"
    if min_conf is None:
        return "no receipt found"
    if min_conf >= 0.99:
        return "0.99 (all from code)"
    if min_conf >= 0.6:
        return "0.60-0.98"
    if min_conf > 0:
        return "0.01-0.59"
    return "0 (date or amount missing)"


def stats() -> dict:
    """Totals, plus good/bad split by interface and by the request's lowest confidence."""
    with closing(_connect()) as con:
        rows = con.execute("SELECT interface, min_conf, errors, rating FROM requests").fetchall()

    def tally():
        return {"requests": 0, "rated": 0, "good": 0, "bad": 0, "good_pct": None}

    total, by_iface, by_band = tally(), defaultdict(tally), defaultdict(tally)
    for r in rows:
        for t in (total, by_iface[r["interface"]], by_band[_band(r["min_conf"], r["errors"])]):
            t["requests"] += 1
            if r["rating"]:
                t["rated"] += 1
                t[r["rating"]] += 1
    for t in (total, *by_iface.values(), *by_band.values()):
        if t["rated"]:
            t["good_pct"] = round(100 * t["good"] / t["rated"], 1)
    total["unrated"] = total["requests"] - total["rated"]
    return {"total": total, "by_interface": dict(by_iface), "by_lowest_confidence": dict(by_band)}


def summary(n: int | None = None) -> dict:
    """The last n requests (all when n is None): how many were rated good/bad, success rate, how many still pending.

    success_pct = good / rated, so it only counts requests the user has verified; pending_in_window says how many of
    the n are not verified yet, pending_total how many are waiting overall.
    """
    with closing(_connect()) as con:
        if n is None:
            rows = con.execute("SELECT rating FROM requests").fetchall()
        else:
            n = max(1, int(n))
            rows = con.execute("SELECT rating FROM requests ORDER BY created DESC, rowid DESC LIMIT ?", (n,)).fetchall()
        pending_total = con.execute("SELECT COUNT(*) FROM requests WHERE rating IS NULL").fetchone()[0]
    good = sum(1 for r in rows if r["rating"] == "good")
    bad = sum(1 for r in rows if r["rating"] == "bad")
    rated = good + bad
    return {
        "last_n": n,
        "requests": len(rows),
        "verified": rated,
        "good": good,
        "bad": bad,
        "success_pct": round(100 * good / rated, 1) if rated else None,
        "pending_in_window": len(rows) - rated,
        "pending_total": pending_total,
    }
