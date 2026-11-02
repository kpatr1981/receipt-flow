"""Image side: find receipts in a photo, read their QR codes, OCR them.

Everything runs locally: OpenCV, zxing-cpp and the Tesseract binary.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import pytesseract
import zxingcpp
from PIL import Image, ImageOps

from . import parse

try:  # iPhone photos
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

# pytesseract hands Tesseract a temp file. Give it the real path: with no TMPDIR (MCP clients start servers with a
# bare environment) Python picks /tmp, a symlink some sandboxes stop Tesseract from following.
import os
import tempfile

tempfile.tempdir = os.path.realpath(tempfile.gettempdir())

OCR_LANG = "ell+eng"
HANDWRITING_DENSITY = 0.3  # tall components sparser than this are handwriting
WORK_SIZE = 1600  # long side, px, of the copy used to find receipts
LINE_JOIN = 0.0035  # horizontal reach (fraction of photo) that joins letters into a text line
AMOUNT_COLUMN = 0.06  # blocks narrower than this (fraction of photo) can be a receipt's amounts column
BLOCK_GAP = 0.035  # max vertical gap (fraction of photo size) between parts of one receipt


@dataclass
class Receipt:
    photo: str  # file name of the photo it came from
    bbox: tuple[int, int, int, int]  # x, y, w, h inside that photo
    date: dt.date | None = None
    time: str | None = None
    amount: float | None = None
    category: str = "other"
    source: str = ""  # "qr", "ocr" or ""
    certain: bool = False  # date and total both straight from the QR code, no ambiguity
    confidence: float = 0.0  # 0..1, how likely date AND amount are both right (see _confidence)
    warnings: list[str] = field(default_factory=list)
    text: str = ""
    crop: np.ndarray | None = field(default=None, repr=False)
    qr: list[str] = field(default_factory=list)  # raw QR/barcode texts: unique per receipt, used to spot duplicates


def load_photo(path: Path) -> np.ndarray:
    """Open any photo (JPEG/PNG/HEIC), apply EXIF rotation, return BGR array."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)


# --------------------------------------------------------------------------
# Finding receipts in a photo
# --------------------------------------------------------------------------

@dataclass
class Region:
    bbox: tuple[int, int, int, int]  # x, y, w, h in full-size pixels
    foreign: np.ndarray | None = None  # bool mask (bbox-sized): ink that belongs to something else


def _ink(small: np.ndarray) -> np.ndarray:
    """Dark printed ink only: coloured stamps and pen are ignored."""
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    b, _, r = (small[..., i].astype(np.int16) for i in range(3))
    sat = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)[..., 1]
    gray[((b - r) > 18) | ((r - b) > 30) | (sat > 70)] = 255
    ink = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 18)
    # Paper edges and shadows are long, nearly straight lines; letters are short. Drop the lines.
    M = max(ink.shape)
    L = max(15, int(0.025 * M))
    fat_x = cv2.dilate(ink, np.ones((1, 3), np.uint8))
    fat_y = cv2.dilate(ink, np.ones((3, 1), np.uint8))
    vertical = cv2.morphologyEx(fat_x, cv2.MORPH_OPEN, np.ones((L, 1), np.uint8))
    horizontal = cv2.morphologyEx(fat_y, cv2.MORPH_OPEN, np.ones((1, 3 * L), np.uint8))
    edges = cv2.dilate(vertical | horizontal, np.ones((3, 3), np.uint8))
    return cv2.bitwise_and(ink, cv2.bitwise_not(edges))


def find_receipts(img: np.ndarray) -> list[Region]:
    """Receipts in an upright photo, left to right.

    Words are joined into text lines; lines that sit in the same column close
    above/below each other form one receipt. Touching or overlapping receipts
    stay apart because their columns of text do not overlap.
    """
    h, w = img.shape[:2]
    s = min(1.0, WORK_SIZE / max(h, w))
    small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    sh, sw = small.shape[:2]
    M = max(sh, sw)
    lines = cv2.dilate(_ink(small), cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(LINE_JOIN * M)), 3)))
    n, labels, st, _ = cv2.connectedComponentsWithStats(lines)

    keep = []
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area < 30 or bh < 0.005 * M:
            continue  # specks, hairlines, dashed separators
        if bh > 0.35 * M or bw > 0.45 * sw:
            continue  # desk, big shadows
        if bh > 0.03 * M and area / float(bw * bh) < HANDWRITING_DENSITY:
            continue  # handwriting, scribbles: tall but thin strokes (printed lines are dense)
        if bh > 2.5 * bw:
            continue  # paper edges
        if x == 0 or y == 0 or x + bw >= sw or y + bh >= sh:
            continue  # cut by the photo border: background
        keep.append(i)

    # Lines -> blocks: horizontal overlap and a small vertical gap.
    parent = {i: i for i in keep}

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_top = sorted(keep, key=lambda i: st[i][1])
    for k, a in enumerate(by_top):
        ax, ay, aw, ah, _ = st[a]
        for b in by_top[k + 1 :]:
            bx, by, bw, bh, _ = st[b]
            if by - (ay + ah) > 0.03 * M:
                break
            if min(ax + aw, bx + bw) - max(ax, bx) > 0.3 * min(aw, bw):
                parent[root(a)] = root(b)
    groups: dict[int, list[int]] = {}
    for i in keep:
        groups.setdefault(root(i), []).append(i)

    def span(members):
        return [min(st[i][0] for i in members), min(st[i][1] for i in members),
                max(st[i][0] + st[i][2] for i in members), max(st[i][1] + st[i][3] for i in members)]

    # Blocks -> receipts. First give narrow amount columns to the labels on their left,
    # then join blocks stacked in the same column (header above body, QR below).
    def stacked(A, B):
        overlap = min(A[2], B[2]) - max(A[0], B[0])
        gap = max(A[1], B[1]) - min(A[3], B[3])
        return overlap > 0.5 * min(A[2] - A[0], B[2] - B[0]) and gap < BLOCK_GAP * M

    def beside(A, B):
        # Amounts are right-aligned, so their labels are on the left: only join leftwards.
        v_overlap = min(A[3], B[3]) - max(A[1], B[1])
        wide, thin = (A, B) if (A[2] - A[0]) >= (B[2] - B[0]) else (B, A)
        return (
            thin[2] - thin[0] < AMOUNT_COLUMN * M
            and wide[0] < thin[0]
            and -0.02 * M < thin[0] - wide[2] < 0.04 * M
            and v_overlap > 0.6 * (thin[3] - thin[1])
        )

    blocks = list(groups.values())
    for rule in (beside, stacked):
        merged = True
        while merged:
            merged = False
            for a in range(len(blocks)):
                A = span(blocks[a])
                for b in range(a + 1, len(blocks)):
                    if rule(A, span(blocks[b])):
                        blocks[a] += blocks.pop(b)
                        merged = True
                        break
                if merged:
                    break

    def split_columns(members):
        """A block holding receipts side by side: cut where almost no text line crosses."""
        x0, y0, x1, y1 = span(members)
        width = x1 - x0
        if width < 0.15 * M or len(members) < 6:
            return [members]
        cover = np.zeros(width, np.int32)
        for i in members:
            cover[st[i][0] - x0 : st[i][0] + st[i][2] - x0] += 1
        busy = np.median(cover[cover > 0])
        margin = int(0.06 * M)  # a receipt is at least this wide
        best, best_x = None, None
        for x in range(margin, width - margin):
            if cover[x] <= max(1, 0.12 * busy) and (best is None or cover[x] < best):
                best, best_x = cover[x], x
        if best_x is None:
            return [members]
        cut = x0 + best_x
        left = [i for i in members if st[i][0] + st[i][2] / 2 < cut]
        right = [i for i in members if st[i][0] + st[i][2] / 2 >= cut]
        if len(left) < 3 or len(right) < 3:
            return [members]
        return split_columns(left) + split_columns(right)

    blocks = [part for m in blocks for part in split_columns(m)]
    blocks = [m for m in blocks if len(m) >= 3 and (span(m)[3] - span(m)[1]) >= 0.06 * M]
    owner = np.zeros(n, np.int32)  # component -> block number (1-based), 0 = none
    for k, members in enumerate(blocks, 1):
        owner[members] = k
    block_map = owner[labels]

    regions = []
    pad = int(0.012 * M)
    for k, members in enumerate(blocks, 1):
        x0, y0, x1, y1 = span(members)
        x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(sw, x1 + pad), min(sh, y1 + pad)
        box = (int(x0 / s), int(y0 / s), int((x1 - x0) / s), int((y1 - y0) / s))
        sub = block_map[y0:y1, x0:x1]
        other = ((sub != 0) & (sub != k)).astype(np.uint8)
        foreign = cv2.resize(other, (box[2], box[3]), interpolation=cv2.INTER_NEAREST) > 0
        regions.append(Region(box, foreign if foreign.any() else None))
    regions.sort(key=lambda r: (r.bbox[0], r.bbox[1]))
    return regions or [Region((0, 0, w, h))]


def crop_region(img: np.ndarray, region: Region) -> np.ndarray:
    """The receipt cut out, with ink from neighbouring receipts painted paper-white."""
    x, y, w, h = region.bbox
    crop = img[y : y + h, x : x + w].copy()
    if region.foreign is not None:
        paper = np.median(crop.reshape(-1, 3), axis=0).astype(np.uint8)
        crop[region.foreign[: crop.shape[0], : crop.shape[1]]] = paper
    return crop


# --------------------------------------------------------------------------
# QR
# --------------------------------------------------------------------------

@dataclass
class QR:
    centre: tuple[float, float]
    text: str
    turn: int  # quarter turns needed to make it upright: 0, 90 (counter-clockwise), 180, -90 (clockwise)


def _quarter(deg: float) -> int:
    q = (int(round(deg / 90)) * 90 + 180) % 360 - 180
    return 180 if q == -180 else q


def read_qrs(img: np.ndarray) -> list[QR]:
    out = []
    for r in zxingcpp.read_barcodes(img):  # QR, and the PDF417/DataMatrix some taximeters print
        if r.format == zxingcpp.BarcodeFormat.EAN13 or r.format == zxingcpp.BarcodeFormat.EAN8:
            continue  # loyalty/product barcodes carry no receipt data
        p = r.position
        cx = (p.top_left.x + p.top_right.x + p.bottom_left.x + p.bottom_right.x) / 4
        cy = (p.top_left.y + p.top_right.y + p.bottom_left.y + p.bottom_right.y) / 4
        out.append(QR((cx, cy), r.text, _quarter(r.orientation)))
    return out


# --------------------------------------------------------------------------
# Orientation
# --------------------------------------------------------------------------

_ROTATE = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, -90: cv2.ROTATE_90_CLOCKWISE}


def turn(img: np.ndarray, quarter: int) -> np.ndarray:
    return img if quarter == 0 else cv2.rotate(img, _ROTATE[quarter])


_WORDS = ("ΑΠΟΔΕΙΞΗ", "ΣΥΝΟΛΟ", "ΦΠΑ", "ΑΦΜ", "ΔΟΥ", "ΤΙΜΗ", "ΠΛΗΡΩΤΕΟ", "ΜΕΤΡΗΤΑ", "ΚΑΡΤΑ", "ΕΥΡΩ", "ΑΞΙΑ",
          "ΠΟΣΟΤΗΤΑ", "ΛΙΤΡΩΝ", "ΤΑΡΙΦΑ", "ΤΗΛ", "TOTAL", "EUR", "ΗΜ", "ΑΡ")


def readability(img: np.ndarray) -> int:
    """How much receipt-like text Tesseract finds in this orientation."""
    text = pytesseract.image_to_string(img, lang=OCR_LANG, config="--psm 11")
    folded = parse.fold(text)
    score = 3 * len(re.findall(r"\d{1,2}/\d{1,2}/\d{2,4}", text))
    score += 2 * len(re.findall(r"\d+[.,]\d{2}(?!\d)", text))
    score += 3 * sum(folded.count(w) for w in _WORDS)
    return score


def text_turn(img: np.ndarray, candidates=(0, 90, 180, -90)) -> int:
    """No QR to go by: read a small copy each way round and keep the most readable.

    (Tesseract's own orientation check alone was confidently wrong on photos with
    upright handwriting next to sideways receipts.)
    """
    f = min(1.0, 1400 / max(img.shape[:2]))
    small = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    small = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    scores = {q: readability(turn(small, q)) for q in candidates}
    best = max(scores, key=scores.get)
    if best != 0 and scores[best] < max(6, 1.3 * scores.get(0, 0)):
        return 0  # not clearly better than leaving it
    return best


def upright_turn(img: np.ndarray, qrs: list[QR]) -> int:
    """How the whole photo must turn so receipts read normally: QR codes vote, else Tesseract."""
    if qrs:
        votes = Counter(q.turn for q in qrs)
        return votes.most_common(1)[0][0]
    return text_turn(img)


# --------------------------------------------------------------------------
# OCR
# --------------------------------------------------------------------------

def _upscaled_gray(crop: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    f = float(np.clip(1600 / crop.shape[1], 1.0, 3.0))
    return cv2.resize(gray, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)


def ocr_passes(crop: np.ndarray):
    """OCR texts from gentlest to most aggressive preparation; stop pulling when you have enough.

    1. plain grayscale (Tesseract binarises itself; best for clean prints and coloured ad paper)
    2. strongly coloured ink (rubber stamps, pen) removed
    3. darkest channel, contrast stretched (faded thermal print)
    4. plain grayscale read as a single column
    """
    gray = _upscaled_gray(crop)
    yield pytesseract.image_to_string(gray, lang=OCR_LANG, config="--psm 6")

    sat = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[..., 1]
    b, _, r = (crop[..., i].astype(np.int16) for i in range(3))
    stamp = (sat > 60) & ((b - r) > 25)
    if stamp.mean() > 0.002:
        f = gray.shape[1] / crop.shape[1]
        mask = cv2.resize(stamp.astype(np.uint8), (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
        no_stamp = gray.copy()
        no_stamp[mask] = 255
        yield pytesseract.image_to_string(no_stamp, lang=OCR_LANG, config="--psm 6")

    dark = cv2.resize(crop.min(axis=2), (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_CUBIC)
    dark = cv2.normalize(dark, None, 0, 255, cv2.NORM_MINMAX)
    yield pytesseract.image_to_string(dark, lang=OCR_LANG, config="--psm 6")
    yield pytesseract.image_to_string(gray, lang=OCR_LANG, config="--psm 4")


# --------------------------------------------------------------------------
# Whole photo -> receipts
# --------------------------------------------------------------------------

def _foreign_at(region: Region, pt) -> bool:
    if region.foreign is None:
        return False
    x, y, _, _ = region.bbox
    fy, fx = int(pt[1] - y), int(pt[0] - x)
    return 0 <= fy < region.foreign.shape[0] and 0 <= fx < region.foreign.shape[1] and bool(region.foreign[fy, fx])


def _inside(pt, box) -> bool:
    x, y, w, h = box
    return x <= pt[0] <= x + w and y <= pt[1] <= y + h


def deskew(crop: np.ndarray, max_angle: float = 12.0) -> np.ndarray:
    """Straighten a receipt lying a few degrees off: pick the angle whose text rows are sharpest."""
    small_w = 700
    f = min(1.0, small_w / crop.shape[1])
    small = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    ink = _ink(small)
    h, w = ink.shape
    centre = (w / 2, h / 2)

    def score(angle):
        m = cv2.getRotationMatrix2D(centre, angle, 1.0)
        rows = cv2.warpAffine(ink, m, (w, h)).sum(axis=1, dtype=np.float64)
        return float(np.sum(np.diff(rows) ** 2))

    coarse = max(np.arange(-max_angle, max_angle + 0.1, 1.0), key=score)
    best = max(np.arange(coarse - 1, coarse + 1.01, 0.25), key=score)
    if abs(best) < 0.5:
        return crop
    H, W = crop.shape[:2]
    m = cv2.getRotationMatrix2D((W / 2, H / 2), best, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(H * sin + W * cos), int(H * cos + W * sin)
    m[0, 2] += nw / 2 - W / 2
    m[1, 2] += nh / 2 - H / 2
    paper = tuple(int(v) for v in np.median(crop.reshape(-1, 3), axis=0))
    return cv2.warpAffine(crop, m, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=paper)


def read_qrs_hard(crop: np.ndarray) -> list[QR]:
    """Small or soft QR codes: try bigger and higher-contrast copies."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    for f in (2.0, 3.0, 1.5):
        big = cv2.resize(gray, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
        for variant in (big, cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
                        cv2.adaptiveThreshold(big, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 10)):
            found = read_qrs(variant)
            if found:
                return found
    return []


def scan_photo(path: Path) -> list[Receipt]:
    img = load_photo(path)
    qrs = read_qrs(img)
    quarter = upright_turn(img, qrs)
    if quarter:
        img = turn(img, quarter)
        qrs = read_qrs(img)
    receipts = []
    for region in find_receipts(img):
        box = region.bbox
        crop = crop_region(img, region)
        mine = [q for q in qrs if _inside(q.centre, box) and not _foreign_at(region, q.centre)]
        # A receipt lying differently from the rest of the photo.
        own_turn = Counter(q.turn for q in mine).most_common(1)[0][0] if mine else text_turn(crop, (0, 180))
        if own_turn:
            crop = turn(crop, own_turn)
        crop = deskew(crop)
        if not mine:
            mine = read_qrs_hard(crop)
        qr_texts = [q.text for q in mine]
        qr_found = [f for f in (parse.parse_qr(t) for t in qr_texts) if f]
        qr_has_date = any(f.date for f in qr_found)
        qr_has_amount = any(f.amount is not None for f in qr_found)

        texts = []
        ocr_found = parse.Found()
        for text in ocr_passes(crop):
            texts.append(text)
            got = parse.parse_ocr(text)
            ocr_found.date = ocr_found.date or got.date
            ocr_found.time = ocr_found.time or got.time
            if ocr_found.amount is None or (ocr_found.guessed and got.amount is not None and not got.guessed):
                ocr_found.amount, ocr_found.guessed, ocr_found.checked = got.amount, got.guessed, got.checked
            ocr_found.candidates += [c for c in [got.amount, *got.candidates] if c is not None and c not in ocr_found.candidates]
            if (qr_has_date or ocr_found.date) and (qr_has_amount or (ocr_found.amount is not None and not ocr_found.guessed)):
                break
        rec = Receipt(photo=path.name, bbox=box, text="\n".join(texts), crop=crop, qr=[t for t in qr_texts if t.strip()])

        if not qr_found and not parse.looks_like_receipt(rec.text) and ocr_found.amount is None:
            # Handwriting, a sticker, a stray mark: little text. A crumpled receipt still has lots of
            # (badly read) text: keep it so the user can type its values in.
            if len(re.findall(r"\w", texts[0])) < 150:
                continue

        _merge(rec, qr_found, ocr_found)
        rec.category = parse.guess_category(rec.text + "\n" + "\n".join(qr_texts))
        receipts.append(rec)
    return receipts


def _merge(rec: Receipt, qr_found: list[parse.Found], ocr_found: parse.Found) -> None:
    best_qr = None
    for f in qr_found:
        # An ambiguous AADE split: let the printed total pick.
        if ocr_found.amount is not None and ocr_found.amount in f.candidates:
            f.amount = ocr_found.amount
    for f in qr_found:
        if f.date and f.amount:
            best_qr = f
            break
    if best_qr is None and qr_found:
        best_qr = qr_found[0]

    if best_qr and best_qr.amount is not None:
        rec.amount, rec.source = best_qr.amount, "qr"
        rec.certain = best_qr.date is not None and (not best_qr.candidates or ocr_found.amount == best_qr.amount)
        rec.date = best_qr.date or ocr_found.date
        rec.time = best_qr.time or ocr_found.time
        if best_qr.candidates and ocr_found.amount != best_qr.amount:
            rec.warnings.append(f"QR total is ambiguous ({', '.join(f'{c:.2f}' for c in [best_qr.amount, *best_qr.candidates])}): check it")
    else:
        rec.amount, rec.date, rec.time = ocr_found.amount, ocr_found.date, ocr_found.time
        rec.source = "ocr" if (rec.amount is not None or rec.date) else ""
        if rec.source == "ocr":
            rec.warnings.append("No QR code read: check the amount and date")
        if ocr_found.guessed and rec.amount is not None:
            # No total line: don't fill a likely-wrong number in, ask for it instead.
            rec.warnings.append(f"No total line found (largest € amount seen: {rec.amount:.2f})")
            rec.amount = None
    if rec.amount is None:
        rec.warnings.append("Amount not found")
    if rec.date is None:
        rec.warnings.append("Date not found")
    rec.confidence = _confidence(rec, best_qr, ocr_found)


def _confidence(rec: Receipt, best_qr: parse.Found | None, ocr_found: parse.Found) -> float:
    """Rule-based (not statistically calibrated): how sure the reading of date AND amount is.

    1 rule per line so it stays explainable:
      both missing or one missing                         -> 0.0  (nothing to trust as a row)
      date + amount from the code, single reading         -> 0.99
      amount from the code, date from the printed text    -> 0.70
      amount from the code but the code is ambiguous      -> 0.50 (0.45 if the code has no date either)
      printed text only, total confirmed by litres x price
        or net + VAT                                      -> 0.65
      printed text only, total line                       -> 0.50
      ...minus 0.15 when the printed text also shows other plausible totals
    """
    if rec.amount is None or rec.date is None:
        return 0.0
    if rec.source == "qr" and best_qr is not None:
        if rec.certain:
            return 0.99
        ambiguous = bool(best_qr.candidates) and ocr_found.amount != best_qr.amount
        if ambiguous:
            return 0.45 if best_qr.date is None else 0.5
        return 0.7
    score = 0.65 if ocr_found.checked else 0.5
    if any(c != rec.amount for c in ocr_found.candidates):
        score -= 0.15
    return round(score, 2)
