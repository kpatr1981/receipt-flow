"""Pure text parsing: QR payloads and OCR text -> date / amount / category.

No image work here, so everything is unit-testable with plain strings.
"""
from __future__ import annotations

import datetime as dt
import difflib
import re
from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------


@dataclass
class Found:
    date: dt.date | None = None
    time: str | None = None  # "HH:MM"
    amount: float | None = None
    candidates: list[float] = field(default_factory=list)  # other plausible totals
    guessed: bool = False  # no total line found: the amount is just the biggest € value
    checked: bool = False  # OCR total confirmed by litres x price or net + VAT


# --------------------------------------------------------------------------
# QR codes
# --------------------------------------------------------------------------

def _valid_stamp(y: int, mo: int, d: int, h: int = 0, mi: int = 0) -> dt.date | None:
    if not (0 <= h < 24 and 0 <= mi < 60):
        return None
    try:
        day = dt.date(y, mo, d)
    except ValueError:
        return None
    this_year = dt.date.today().year
    if not (this_year - 3 <= day.year <= this_year + 1):
        return None
    return day


def parse_aade_sig(sig: str) -> list[Found]:
    """Greek cash-register signature (www1.aade.gr/tameiakes ... ?SIG=...).

    It ends with YYMMDDHHMM followed by the total, e.g. ...2610131428 + 50.00.
    The hash before it is hex, so the split point is ambiguous; return every
    split that gives a real date-time, shortest amount first.
    """
    out = []
    for k in range(1, 7):
        m = re.search(r"(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{%d}\.\d{2})$" % k, sig)
        if not m:
            continue
        yy, mo, d, h, mi = (int(g) for g in m.groups()[:5])
        amount_txt = m.group(6)
        if len(amount_txt.split(".")[0]) > 1 and amount_txt.startswith("0"):
            continue  # "050.00" is not how totals are printed
        day = _valid_stamp(2000 + yy, mo, d, h, mi)
        amount = float(amount_txt)
        if day and amount > 0:
            out.append(Found(day, f"{h:02d}:{mi:02d}", amount))
    return out


_AMOUNT_TOKEN = re.compile(r"^\d{1,6}[.,]\d{2}$")


def parse_sig_layout(sig: str) -> Found | None:
    """AADE signature by its layout: device (3 letters + 8 digits), 8-digit counter,
    hex hash (30 or 40 chars), optional YYMMDDHHMM, total ("." or ",")."""
    # 30-char hash + date-time has the same length as a 40-char hash alone: try date-times first.
    for hash_len, with_time in ((30, True), (40, True), (40, False), (30, False)):
        stamp = r"(\d{10})" if with_time else r"()"
        m = re.fullmatch(r"[A-Z]{3}\d{8}\d{8}[0-9A-Fa-f]{%d}%s(\d{1,6}[.,]\d{2})" % (hash_len, stamp), sig)
        if not m:
            continue
        amount_txt = m.group(2).replace(",", ".")
        if len(amount_txt.split(".")[0]) > 1 and amount_txt.startswith("0"):
            continue
        found = Found(amount=float(amount_txt))
        if with_time:
            st = m.group(1)
            day = _valid_stamp(2000 + int(st[:2]), int(st[2:4]), int(st[4:6]), int(st[6:8]), int(st[8:10]))
            if not day:
                continue
            found.date, found.time = day, f"{st[6:8]}:{st[8:10]}"
        return found
    return None


def parse_qr(text: str) -> Found | None:
    """Pull date + total out of whatever a receipt QR holds."""
    m = re.search(r"SIG=([0-9A-Za-z.,]+)", text)
    if m:
        exact = parse_sig_layout(m.group(1))
        if exact:
            return exact
        options = parse_aade_sig(m.group(1).replace(",", "."))
        if options:
            best = options[0]
            best.candidates = [o.amount for o in options[1:]]
            return best
        # No date-time in this signature (e.g. taximeters): the total still ends it.
        t = re.search(r"(\d+)[.,](\d{2})$", m.group(1))
        if t:
            whole = t.group(1)
            amounts = [float(f"{whole[i:]}.{t.group(2)}") for i in range(len(whole)) if whole[i] != "0" or i == len(whole) - 1]
            amounts = [a for a in amounts if 0 < a < 100000]
            if amounts:
                # Longest run without a leading zero first; the printed total (OCR) can pick another.
                return Found(amount=amounts[0], candidates=amounts[1:])

    # Generic: delimited fields (e.g. "2;0016831;...;2026-10-20;17:36:20;...;2,129;9,39;20,00;1118469")
    found = Found()
    m = re.search(r"(20\d{2})-(\d{2})-(\d{2})", text)
    if m:
        found.date = _valid_stamp(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    else:
        m = re.search(r"(?<!\d)(\d{1,2})([/.\-])(\d{1,2})\2(20\d{2})(?!\d)", text)  # dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
        if m:
            found.date = _valid_stamp(int(m.group(4)), int(m.group(3)), int(m.group(1)))
    m = re.search(r"\b(\d{2}):(\d{2})(?::\d{2})?\b", text)
    if m and int(m.group(1)) < 24 and int(m.group(2)) < 60:
        found.time = f"{m.group(1)}:{m.group(2)}"
    tokens = re.split(r"[;|&?=\s]", text)
    amounts = [float(t.replace(",", ".")) for t in tokens if _AMOUNT_TOKEN.match(t)]
    if amounts:
        found.amount = max(amounts)
    if found.date or found.amount:
        return found
    return None


# --------------------------------------------------------------------------
# OCR text
# --------------------------------------------------------------------------

# Tesseract mixes Latin look-alikes into Greek words; fold both to one alphabet.
_FOLD = str.maketrans({
    "A": "Α", "B": "Β", "E": "Ε", "H": "Η", "I": "Ι", "K": "Κ", "M": "Μ", "N": "Ν",
    "O": "Ο", "P": "Ρ", "T": "Τ", "X": "Χ", "Y": "Υ", "Z": "Ζ",
    "Ά": "Α", "Έ": "Ε", "Ή": "Η", "Ί": "Ι", "Ό": "Ο", "Ύ": "Υ", "Ώ": "Ω", "Ϊ": "Ι", "Ϋ": "Υ",
})


def fold(s: str) -> str:
    return s.upper().translate(_FOLD)


def _has_word(line: str, word: str, cutoff: float = 0.75) -> bool:
    w = fold(word)
    for tok in re.findall(r"[^\s.:,;()\-_/|]+", fold(line)):
        if tok.startswith(w) or difflib.SequenceMatcher(None, tok[: len(w)], w).ratio() >= cutoff:
            return True
    return False


_MONEY = re.compile(r"(?<![\d,.])(\d{1,5})\s?[.,]\s?(\d{2})(?![\d%/¢])")  # "13.00/" is a rate whose % was misread
_DATE = re.compile(r"(?<!\d)(\d{1,2})\s?[/.\-]\s?(\d{1,2})\s?[/.\-]\s?(20\d{2}|\d{2})(?!\d)")
_TIME = re.compile(r"(?<!\d)([01]?\d|2[0-3])\s?:\s?([0-5]\d)(?!\d)")


def _money(line: str) -> list[float]:
    return [float(f"{a}.{b}") for a, b in _MONEY.findall(line)]


TOTAL_WORDS = ["ΣΥΝΟΛΟ", "ΠΛΗΡΩΤΕΟ", "TOTAL", "ΓΕΝΙΚΟ", "ΠΟΣΟ", "ΑΞΙΑ ΜΕ ΦΠΑ"]
NOT_TOTAL_WORDS = ["ΛΙΤΡΩΝ", "ΤΕΜΑΧΙΩΝ", "ΠΟΣΟΤΗΤΑ", "ΚΑΘΑΡΗ", "ΕΙΔΩΝ"]


_STRAY_EURO = re.compile(r"(\d\s?[.,]\s?\d{2})[8€6EeΕε](?=[\s|\]\[)]*$)")
_DECIMAL3 = re.compile(r"(?<![\d,.])(\d{1,3})\s?[.,]\s?(\d{3})(?!\d)")


def _fuel_total(lines: list[str]) -> float | None:
    """Litres x price per litre, both printed with 3 decimals on Greek fuel receipts."""
    price = litres = None
    for line in lines:
        vals = [float(f"{a}.{b}") for a, b in _DECIMAL3.findall(line)]
        if not vals:
            continue
        if _has_word(line, "ΤΙΜΗ") and (_has_word(line, "ΛΙΤΡΟΥ") or _has_word(line, "ΜΟΝΑΔΑΣ")):
            price = vals[-1]
        elif _has_word(line, "ΛΙΤΡΩΝ") or _has_word(line, "ΠΟΣΟΤΗΤΑ"):
            litres = vals[-1]
    if price and litres and 0.5 < price < 5 and 0 < litres < 500:
        return round(price * litres, 2)
    return None


# "€5.65-13.00%" (taxi meters): an amount followed by its VAT rate. The rate is not money.
_RATE_SUFFIX = re.compile(r"(\d+(?:\s?[.,]\s?\d{2})?)\s?-\s?\d{1,2}\s?[.,]\s?\d{1,2}\S*")
_RATE = re.compile(r"(?<![\d.,])\d{1,2}\s?[.,]\s?\d{2}\s?%")


def _clean_line(line: str) -> str:
    line = _STRAY_EURO.sub(r"\1€", line)
    line = _RATE_SUFFIX.sub(r"\1", line)
    return _RATE.sub(" % ", line)  # keep the % so VAT lines still look like VAT lines


def parse_ocr(text: str) -> Found:
    found = Found()
    lines = [_clean_line(l) for l in text.splitlines() if l.strip()]

    # Date: prefer one that is labelled, on its own line or the line above it:
    #   ΕΝΑΡΞΗ (ΔΙΑΔΡΟΜΗΣ) / ΗΜ/ΝΙΑ / ΗΜΕΡΟΜΗΝΙΑ / DATE  >  ΛΗΞΗ (trip end)  >  unlabelled
    def label_score(text: str) -> int:
        f = fold(text)
        if _has_word(text, "ΕΝΑΡΞΗ", 0.8) or re.search(r"ΗΜ\s?/\s?Ν|ΗΜΕΡΟΜ|DATE|(?<![Α-ΩA-Z])ΗΜ\s?:", f):
            return 3
        if _has_word(text, "ΛΗΞΗ", 0.8):
            return 2
        return 0

    dated = []
    for i, line in enumerate(lines):
        for d, mo, y in _DATE.findall(line):
            year = int(y) + (2000 if len(y) == 2 else 0)
            day = _valid_stamp(year, int(mo), int(d))
            if day:
                score = label_score(line)
                if score == 0 and i > 0 and not _DATE.search(lines[i - 1]):
                    score = label_score(lines[i - 1])  # "ΕΝΑΡΞΗ ΔΙΑΔΡΟΜΗΣ:" with the date below
                t = _TIME.search(line[line.find(d):] if d in line else line)
                dated.append((score, -i, day, f"{int(t.group(1)):02d}:{t.group(2)}" if t else None))
    if dated:
        dated.sort(key=lambda x: (x[0], x[1]), reverse=True)
        _, _, found.date, found.time = dated[0]

    # Amount: total lines first, then check net + VAT.
    totals, payable, net, vat = [], [], None, None
    for i, line in enumerate(lines):
        vals = _money(line)
        if not vals and any(_has_word(line, w) for w in TOTAL_WORDS) and i + 1 < len(lines):
            # "ΠΛΗΡΩΤΕΟ :" with the amount printed on the line below (big taximeter print)
            below = lines[i + 1]
            if not any(_has_word(below, w) for w in NOT_TOTAL_WORDS):
                vals = _money(below)
        if not vals:
            continue
        if any(_has_word(line, w) for w in NOT_TOTAL_WORDS):
            if _has_word(line, "ΚΑΘΑΡΗ"):
                net = vals[-1]
            continue
        if re.search(r"Φ\.?\s?Π\.?\s?Α|ΦΠΑ|VAT", fold(line)) and "%" in line and not _has_word(line, "ΣΥΝΟΛΟ"):
            vat = vals[-1]
            continue
        if any(_has_word(line, w) for w in TOTAL_WORDS):
            totals.append(vals[-1])
            if any(_has_word(line, w, 0.8) for w in ("ΠΛΗΡΩΤΕΟ", "ΣΥΝΟΛΟ/TOTAL")):
                payable.append(vals[-1])

    fuel = _fuel_total(lines)
    summed = round(net + vat, 2) if net is not None and vat is not None else None
    checks = [c for c in (fuel, summed) if c is not None]
    agreed = [t for t in totals if any(abs(t - c) <= 0.011 for c in checks)]  # pump rounding: 1 cent
    if agreed:
        found.amount, found.checked = agreed[0], True
    elif fuel is not None and summed is not None and abs(fuel - summed) <= 0.011:
        found.amount, found.checked = summed, True
    elif summed is not None and (summed in totals or not totals):
        found.amount = summed
    elif summed is not None:
        found.amount = max(totals)
        found.candidates.append(summed)
    elif payable:
        found.amount = payable[-1]  # the amount payable is the last word on the bill
    elif totals:
        found.amount = max(totals)
    else:
        euros = [v for line in lines if "€" in line or "EUR" in line.upper() or "ΕΥΡΩ" in fold(line) for v in _money(line)]
        if euros:
            found.amount = max(euros)
            found.guessed = True
    found.candidates += [t for t in totals + checks if t != found.amount and t not in found.candidates]
    return found


# --------------------------------------------------------------------------
# Category (fuel, taxi, tolls, ...)
# --------------------------------------------------------------------------

CATEGORY_RULES: list[tuple[str, list[str]]] = [
    ("fuel", ["UNLEADED", "DIESEL", "ΑΜΟΛΥΒΔ", "ΚΑΥΣΙΜ", "ΠΕΤΡΕΛΑΙΟ", "ΒΕΝΖΙΝ", "ΛΙΤΡΩΝ", "LPG", "ΥΓΡΑΕΡΙΟ"]),
    ("tolls", ["ΔΙΟΔΙ", "ΑΤΤΙΚΗ ΟΔΟΣ", "ΟΛΥΜΠΙΑ ΟΔΟΣ", "ΝΕΑ ΟΔΟΣ", "ΕΓΝΑΤΙΑ", "ΜΩΡΕΑΣ", "ΚΕΝΤΡΙΚΗ ΟΔΟΣ", "TOLL"]),
    ("parking", ["ΣΤΑΘΜΕΥΣ", "PARKING"]),
    ("taxi", ["TAXI", "ΤΑΞΙ", "ΚΤΕΛ", "ΑΚΤΟΠΛΟ", "ΕΙΣΙΤΗΡΙΟ", "FERRY", "ΤΑΡΙΦΑ", "ΣΗΜΑΙΑ", "ΔΙΑΔΡΟΜ",
              "ΑΡ.ΟΧΗΜΑΤΟΣ", "ΑΡ. ΟΧΗΜΑΤΟΣ", "ΚΟΜΙΣΤΡ", "ΤΑΞΙΜΕΤΡ", "ΑΝΑΜΟΝΗ"]),
    ("hotel", ["ΞΕΝΟΔΟΧ", "HOTEL", "ΔΙΑΝΥΚΤΕΡ", "ΔΩΜΑΤΙ"]),
    ("meals", ["ΕΣΤΙΑΤ", "ΤΑΒΕΡΝ", "ΚΑΦΕ", "CAFE", "COFFEE", "ΣΟΥΒΛΑΚ", "ΨΗΤΟΠΩΛ", "ΠΙΤΣΑ", "PIZZA", "RESTAURANT", "ΜΕΖΕΔ", "ΓΕΥΜΑ"]),
]

CATEGORY_LABELS = {
    "hotel": "Hotel",
    "parking": "Parking",
    "meals": "Meal",
    "tolls": "Tolls",
    "fuel": "Fuel",
    "taxi": "Taxi / bus / ferry",
    "other": "Other",
}


def guess_category(text: str) -> str:
    t = fold(text)
    lines = text.splitlines()
    for key, words in CATEGORY_RULES:
        for w in words:
            if fold(w) in t:
                return key
            if " " not in w and len(w) >= 5 and any(_has_word(l, w, 0.8) for l in lines):
                return key  # OCR swapped a letter (ΤΑΡΙΦΛ)
    return "other"


RECEIPT_WORDS = ["ΑΠΟΔΕΙΞΗ", "ΣΥΝΟΛΟ", "ΦΠΑ", "ΑΦΜ", "ΤΙΜΟΛΟΓΙΟ", "TOTAL", "ΜΕΤΡΗΤΑ", "ΚΑΡΤΑ"]


def looks_like_receipt(text: str) -> bool:
    return sum(1 for w in RECEIPT_WORDS if any(_has_word(l, w, 0.8) for l in text.splitlines())) >= 2
