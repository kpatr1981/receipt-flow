"""The one answer the CLI, REST API and MCP server give for a receipt photo.

Per receipt found in the photo, and nothing else:
    date        "YYYY-MM-DD" or None when it could not be read
    amount      total in euro (float) or None when it could not be read
    from_code   True when the amount came from the receipt's QR code / barcode, False when from printed text
    confidence  0..1, how sure the tool is that date AND amount are both right (rules in detect._confidence)

One photo can hold several receipts, so a photo gives a list. Everything runs locally.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import TypedDict

import pytesseract
from PIL import UnidentifiedImageError

from . import detect

MAX_BYTES = 50 * 1024 * 1024


class ReceiptResult(TypedDict):
    date: str | None
    amount: float | None
    from_code: bool
    confidence: float


class PhotoResult(TypedDict, total=False):
    file: str
    receipts: list[ReceiptResult]
    error: str  # only when the photo could not be read at all


def _result(rec: detect.Receipt) -> ReceiptResult:
    return {
        "date": rec.date.isoformat() if rec.date else None,
        "amount": rec.amount,
        "from_code": rec.source == "qr",
        "confidence": rec.confidence,
    }


def read_photo(path: str | os.PathLike, name: str = "") -> list[ReceiptResult]:
    """Every receipt in one photo (JPEG, PNG, HEIC, WebP, TIFF, BMP). Raises ValueError if it is not a readable image."""
    path = Path(path).expanduser()
    if not path.is_file():
        raise ValueError(f"No such file: {path}")
    try:
        return [_result(r) for r in detect.scan_photo(path)]
    except (pytesseract.TesseractError, pytesseract.TesseractNotFoundError, UnicodeDecodeError) as e:
        # before OSError: TesseractNotFoundError is one
        raise ValueError(f"Tesseract OCR failed ({type(e).__name__}); is it installed and on PATH?") from e
    except (UnidentifiedImageError, OSError) as e:
        raise ValueError(f"Not a readable image: {name or path.name}") from e


def read_bytes(data: bytes, filename: str = "photo.jpg") -> list[ReceiptResult]:
    """Same as read_photo for an uploaded photo; the temporary copy is deleted afterwards."""
    if not data:
        raise ValueError("Empty upload")
    if len(data) > MAX_BYTES:
        raise ValueError(f"Photo larger than {MAX_BYTES // (1024 * 1024)} MB")
    suffix = Path(filename).suffix.lower() or ".jpg"
    with tempfile.TemporaryDirectory(prefix="receiptflow-") as tmp:
        p = Path(tmp) / f"upload{suffix}"
        p.write_bytes(data)
        return read_photo(p, name=filename)


def read_many(paths: list[str | os.PathLike]) -> list[PhotoResult]:
    """One entry per photo; a photo that fails gets an error instead of stopping the rest."""
    out: list[PhotoResult] = []
    for p in paths:
        try:
            out.append({"file": str(p), "receipts": read_photo(p)})
        except ValueError as e:
            out.append({"file": str(p), "receipts": [], "error": str(e)})
    return out
