"""REST API: POST a receipt photo, get date, amount, read-from-code and confidence back.

    python -m receiptflow.api [--host 127.0.0.1] [--port 8781]

    GET  /health                   -> {"ok": true}
    POST /v1/receipts              multipart, one or more files in field "photo"
                                   or the raw image as the body (Content-Type: image/...)
        -> 200 {"request_id": "3f9c0a1b2c4d",
                "results": [{"file": "a.jpg", "receipts": [{"date", "amount", "from_code", "confidence"}]}]}
           a file that is not a readable image gets "error" in its entry (the others are still read)
        -> 400 {"error": "..."} when nothing was sent

    Feedback (the backlog: every request waits for a good/bad rating)
    GET  /v1/requests?all=1&limit=50   unrated requests, newest first (all=1: rated ones too)
    GET  /v1/requests/<id>             one request, its results and rating
    POST /v1/requests/<id>/feedback    {"rating": "good" | "bad", "note": "optional"}  (again = replace)
    GET  /v1/stats                     good/bad totals, by interface and by lowest confidence
    GET  /v1/summary?n=50              last n requests (no n: all): verified, good, bad, success_pct,
                                       pending_in_window, pending_total

Photos are read from a temporary copy that is deleted straight after. The log keeps file names and results
only (receiptflow/backlog.py).
"""
from __future__ import annotations

import argparse

from flask import Flask, jsonify, request

from . import backlog
from .extract import MAX_BYTES, PhotoResult, read_bytes

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES * 4  # a few photos per request


def _one(name: str, data: bytes) -> PhotoResult:
    try:
        return {"file": name, "receipts": read_bytes(data, name)}
    except ValueError as e:
        return {"file": name, "receipts": [], "error": str(e)}


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.post("/v1/receipts")
def receipts():
    files = request.files.getlist("photo")
    if files:
        results = [_one(f.filename or "photo", f.read()) for f in files]
    elif request.mimetype.startswith("image/") or request.mimetype == "application/octet-stream":
        data = request.get_data()
        if not data:
            return jsonify(error="Empty body"), 400
        name = request.headers.get("X-Filename") or "photo." + (request.mimetype.split("/")[1] if "/" in request.mimetype else "jpg")
        results = [_one(name, data)]
    else:
        return jsonify(error='Send the photo as multipart field "photo" or as the raw body with an image/* Content-Type'), 400
    return jsonify(request_id=backlog.log_request("rest", results), results=results)


@app.get("/v1/requests")
def list_requests():
    all_ = request.args.get("all", "").lower() in ("1", "true", "yes")
    try:
        limit = int(request.args.get("limit", 50))
    except ValueError:
        return jsonify(error="limit must be a number"), 400
    return jsonify(requests=backlog.backlog(unrated_only=not all_, limit=limit))


@app.get("/v1/requests/<request_id>")
def get_request(request_id: str):
    r = backlog.get(request_id)
    return jsonify(r) if r else (jsonify(error="Unknown request id"), 404)


@app.post("/v1/requests/<request_id>/feedback")
def feedback(request_id: str):
    body = request.get_json(silent=True) or request.form
    try:
        return jsonify(backlog.rate(request_id, body.get("rating", ""), body.get("note", "")))
    except KeyError:
        return jsonify(error="Unknown request id"), 404
    except ValueError as e:
        return jsonify(error=str(e)), 400


@app.get("/v1/stats")
def stats():
    return jsonify(backlog.stats())


@app.get("/v1/summary")
def summary():
    n = request.args.get("n")
    if n is not None and (not n.isdigit() or int(n) < 1):
        return jsonify(error="n must be a whole number of at least 1"), 400
    return jsonify(backlog.summary(int(n) if n else None))


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error=f"Request larger than {app.config['MAX_CONTENT_LENGTH'] // (1024 * 1024)} MB"), 413


def main() -> None:
    ap = argparse.ArgumentParser(prog="receipt-api", description="Receipt reading REST API (local).")
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to accept other machines (no auth: trusted network only)")
    ap.add_argument("--port", type=int, default=8781)
    args = ap.parse_args()
    print(f"Receipt API on http://{args.host}:{args.port}/v1/receipts  (Ctrl+C to stop)")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
