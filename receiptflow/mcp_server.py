"""MCP server (stdio): lets an assistant read receipt photos on this machine.

    python -m receiptflow.mcp_server

Tools:
    read_receipts(paths)                          photo files on this machine
    read_receipt_image(image_base64, filename)    a photo sent inline
        -> {"request_id", "results": [{"file", "receipts": [{date, amount, from_code, confidence}], "error"?}]}
    rate_request(request_id, rating, note)        the user's verdict: "good" or "bad"
    list_requests(unrated_only, limit)            the backlog still waiting for a verdict
    request_stats()                               good/bad totals, by interface and by lowest confidence
    success_summary(n)                            last n requests: success rate and how many still pending
The log (receiptflow/backlog.py) is shared with the REST API and keeps file names and results, never photos.
"""
from __future__ import annotations

import base64
import binascii
from typing import Any

from mcp.server.mcpserver import MCPServer

from . import backlog
from .extract import PhotoResult, read_bytes, read_many

server = MCPServer(
    "receiptflow",
    instructions=(
        "Reads Greek/English till receipts from photos, locally. Each receipt gives date (YYYY-MM-DD), amount (euro), "
        "from_code (true = read from the QR code/barcode, exact) and confidence (0..1 that date AND amount are right). "
        "null date/amount means it could not be read: ask the user. Treat confidence below 0.9 as 'please check'. "
        "Every read returns a request_id. When the user says whether a result was right or wrong, record it with "
        "rate_request (good/bad, plus a short note on what was wrong); list_requests shows reads still unrated."
    ),
)


def _logged(results: list[PhotoResult]) -> dict[str, Any]:
    return {"request_id": backlog.log_request("mcp", results), "results": results}


@server.tool()
def read_receipts(paths: list[str]) -> dict[str, Any]:
    """Read every receipt in one or more photo files (JPEG, PNG, HEIC...) on this machine.

    One photo can hold several receipts. Returns a request_id (for rate_request) and one entry per photo:
    its receipts, or an error.
    """
    return _logged(read_many(paths))


@server.tool()
def read_receipt_image(image_base64: str, filename: str = "photo.jpg") -> dict[str, Any]:
    """Read every receipt in one photo sent as base64 (filename only sets the image type, e.g. .heic).

    Returns a request_id (for rate_request) and the photo's receipts, or an error.
    """
    try:
        data = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError):
        result: PhotoResult = {"file": filename, "receipts": [], "error": "image_base64 is not valid base64"}
    else:
        try:
            result = {"file": filename, "receipts": read_bytes(data, filename)}
        except ValueError as e:
            result = {"file": filename, "receipts": [], "error": str(e)}
    return _logged([result])


@server.tool()
def rate_request(request_id: str, rating: str, note: str = "") -> dict[str, Any]:
    """Record whether a read was right: rating "good" or "bad", note = what was wrong (optional).

    Rating the same request again replaces the earlier verdict.
    """
    try:
        return backlog.rate(request_id, rating, note)
    except KeyError:
        return {"error": f"Unknown request id: {request_id}"}
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
def list_requests(unrated_only: bool = True, limit: int = 20) -> dict[str, Any]:
    """Recent reads, newest first, with their results and verdicts. By default only those still unrated."""
    return {"requests": backlog.backlog(unrated_only=unrated_only, limit=limit)}


@server.tool()
def request_stats() -> dict[str, Any]:
    """How often reads were rated good or bad: overall, per interface (rest/mcp) and per lowest confidence."""
    return backlog.stats()


@server.tool()
def success_summary(n: int | None = None) -> dict[str, Any]:
    """How successful the last n reads were (n omitted: all of them) and how many wait for verification.

    Returns verified, good, bad, success_pct (good / verified), pending_in_window (of those n, not rated yet)
    and pending_total (unrated overall).
    """
    if n is not None and n < 1:
        return {"error": "n must be at least 1"}
    return backlog.summary(n)


def main() -> None:
    server.run()  # stdio


if __name__ == "__main__":
    main()
