// Pure text parsing: QR payloads and OCR text -> date / amount / category.
// Port of receiptflow/parse.py. Dates are ISO strings "YYYY-MM-DD", times "HH:MM".

/** @typedef {{date: string|null, time: string|null, amount: number|null, candidates: number[], guessed: boolean}} Found */

/** @returns {Found} */
export function found(init = {}) {
  return { date: null, time: null, amount: null, candidates: [], guessed: false, ...init };
}

const pad = (n) => String(n).padStart(2, "0");
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// --------------------------------------------------------------------------
// Dates
// --------------------------------------------------------------------------

export function validStamp(y, mo, d, h = 0, mi = 0) {
  if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60)) return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const thisYear = new Date().getFullYear();
  if (!(y >= thisYear - 3 && y <= thisYear + 1)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// --------------------------------------------------------------------------
// QR codes
// --------------------------------------------------------------------------

/** Greek cash-register signature: ends with YYMMDDHHMM + total; every valid split, shortest amount first. */
export function parseAadeSig(sig) {
  const out = [];
  for (let k = 1; k < 7; k++) {
    const m = sig.match(new RegExp(`(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{${k}}\\.\\d{2})$`));
    if (!m) continue;
    const [yy, mo, d, h, mi] = m.slice(1, 6).map(Number);
    const amountTxt = m[6];
    if (amountTxt.split(".")[0].length > 1 && amountTxt.startsWith("0")) continue;
    const day = validStamp(2000 + yy, mo, d, h, mi);
    const amount = parseFloat(amountTxt);
    if (day && amount > 0) out.push(found({ date: day, time: `${pad(h)}:${pad(mi)}`, amount }));
  }
  return out;
}

/** AADE signature by its layout: device (3 letters + 8 digits), 8-digit counter,
 *  hex hash (30 or 40), optional YYMMDDHHMM, total ("." or ","). */
export function parseSigLayout(sig) {
  // 30-char hash + date-time is as long as a 40-char hash alone: try date-times first.
  for (const [hashLen, withTime] of [[30, true], [40, true], [40, false], [30, false]]) {
    const stamp = withTime ? "(\\d{10})" : "()";
    const m = sig.match(new RegExp(`^[A-Z]{3}\\d{8}\\d{8}[0-9A-Fa-f]{${hashLen}}${stamp}(\\d{1,6}[.,]\\d{2})$`));
    if (!m) continue;
    const amountTxt = m[2].replace(",", ".");
    if (amountTxt.split(".")[0].length > 1 && amountTxt.startsWith("0")) continue;
    const f = found({ amount: parseFloat(amountTxt) });
    if (withTime) {
      const st = m[1];
      const day = validStamp(2000 + +st.slice(0, 2), +st.slice(2, 4), +st.slice(4, 6), +st.slice(6, 8), +st.slice(8, 10));
      if (!day) continue;
      f.date = day;
      f.time = `${st.slice(6, 8)}:${st.slice(8, 10)}`;
    }
    return f;
  }
  return null;
}

const AMOUNT_TOKEN = /^\d{1,6}[.,]\d{2}$/;

/** Pull date + total out of whatever a receipt QR holds. @returns {Found|null} */
export function parseQr(text) {
  const sig = text.match(/SIG=([0-9A-Za-z.,]+)/);
  if (sig) {
    const exact = parseSigLayout(sig[1]);
    if (exact) return exact;
    const options = parseAadeSig(sig[1].replaceAll(",", "."));
    if (options.length) {
      const best = options[0];
      best.candidates = options.slice(1).map((o) => o.amount);
      return best;
    }
    // No date-time in this signature (e.g. taximeters): the total still ends it.
    const t = sig[1].match(/(\d+)[.,](\d{2})$/);
    if (t) {
      const whole = t[1];
      let amounts = [];
      for (let i = 0; i < whole.length; i++) {
        if (whole[i] !== "0" || i === whole.length - 1) amounts.push(parseFloat(`${whole.slice(i)}.${t[2]}`));
      }
      amounts = amounts.filter((a) => a > 0 && a < 100000);
      if (amounts.length) return found({ amount: amounts[0], candidates: amounts.slice(1) });
    }
  }

  // Generic: delimited fields ("2;0016831;...;2026-10-20;17:36:20;...;2,129;9,39;20,00;1118469")
  const f = found();
  let m = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) f.date = validStamp(+m[1], +m[2], +m[3]);
  else {
    m = text.match(/(?<!\d)(\d{1,2})([/.\-])(\d{1,2})\2(20\d{2})(?!\d)/); // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
    if (m) f.date = validStamp(+m[4], +m[3], +m[1]);
  }
  m = text.match(/\b(\d{2}):(\d{2})(?::\d{2})?\b/);
  if (m && +m[1] < 24 && +m[2] < 60) f.time = `${m[1]}:${m[2]}`;
  const amounts = text.split(/[;|&?=\s]/).filter((t) => AMOUNT_TOKEN.test(t)).map((t) => parseFloat(t.replace(",", ".")));
  if (amounts.length) f.amount = Math.max(...amounts);
  return f.date || f.amount ? f : null;
}

// --------------------------------------------------------------------------
// OCR text
// --------------------------------------------------------------------------

// Tesseract mixes Latin look-alikes into Greek words; fold both to one alphabet.
const FOLD = {
  A: "Α", B: "Β", E: "Ε", H: "Η", I: "Ι", K: "Κ", M: "Μ", N: "Ν", O: "Ο", P: "Ρ", T: "Τ", X: "Χ", Y: "Υ", Z: "Ζ",
  "Ά": "Α", "Έ": "Ε", "Ή": "Η", "Ί": "Ι", "Ό": "Ο", "Ύ": "Υ", "Ώ": "Ω", "Ϊ": "Ι", "Ϋ": "Υ",
};

export function fold(s) {
  let out = "";
  for (const ch of s.toUpperCase()) out += FOLD[ch] ?? ch;
  return out;
}

/** difflib.SequenceMatcher(None, a, b).ratio() (Ratcliff/Obershelp), for short strings. */
export function similarity(a, b) {
  const total = a.length + b.length;
  if (!total) return 1;
  const matches = (alo, ahi, blo, bhi) => {
    let bestI = alo, bestJ = blo, bestK = 0;
    for (let i = alo; i < ahi; i++) {
      for (let j = blo; j < bhi; j++) {
        let k = 0;
        while (i + k < ahi && j + k < bhi && a[i + k] === b[j + k]) k++;
        if (k > bestK) { bestI = i; bestJ = j; bestK = k; }
      }
    }
    if (!bestK) return 0;
    return bestK + matches(alo, bestI, blo, bestJ) + matches(bestI + bestK, ahi, bestJ + bestK, bhi);
  };
  return (2 * matches(0, a.length, 0, b.length)) / total;
}

export function hasWord(line, word, cutoff = 0.75) {
  const w = [...fold(word)];
  for (const tok of fold(line).match(/[^\s.:,;()\-_/|]+/g) || []) {
    const t = [...tok];
    if (tok.startsWith(w.join("")) || similarity(t.slice(0, w.length), w) >= cutoff) return true;
  }
  return false;
}

const MONEY = /(?<![\d,.])(\d{1,5})\s?[.,]\s?(\d{2})(?![\d%/¢])/g; // "13.00/" is a rate whose % was misread
const DATE = /(?<!\d)(\d{1,2})\s?[/.\-]\s?(\d{1,2})\s?[/.\-]\s?(20\d{2}|\d{2})(?!\d)/g;
const DATE1 = new RegExp(DATE.source);
const TIME = /(?<!\d)([01]?\d|2[0-3])\s?:\s?([0-5]\d)(?!\d)/;

export const money = (line) => [...line.matchAll(MONEY)].map((m) => parseFloat(`${m[1]}.${m[2]}`));

const TOTAL_WORDS = ["ΣΥΝΟΛΟ", "ΠΛΗΡΩΤΕΟ", "TOTAL", "ΓΕΝΙΚΟ", "ΠΟΣΟ", "ΑΞΙΑ ΜΕ ΦΠΑ"];
const NOT_TOTAL_WORDS = ["ΛΙΤΡΩΝ", "ΤΕΜΑΧΙΩΝ", "ΠΟΣΟΤΗΤΑ", "ΚΑΘΑΡΗ", "ΕΙΔΩΝ"];

const STRAY_EURO = /(\d\s?[.,]\s?\d{2})[8€6EeΕε](?=[\s|\]\[)]*$)/;
const DECIMAL3 = /(?<![\d,.])(\d{1,3})\s?[.,]\s?(\d{3})(?!\d)/g;

/** Litres x price per litre, both printed with 3 decimals on Greek fuel receipts. */
function fuelTotal(lines) {
  let price = null, litres = null;
  for (const line of lines) {
    const vals = [...line.matchAll(DECIMAL3)].map((m) => parseFloat(`${m[1]}.${m[2]}`));
    if (!vals.length) continue;
    if (hasWord(line, "ΤΙΜΗ") && (hasWord(line, "ΛΙΤΡΟΥ") || hasWord(line, "ΜΟΝΑΔΑΣ"))) price = vals.at(-1);
    else if (hasWord(line, "ΛΙΤΡΩΝ") || hasWord(line, "ΠΟΣΟΤΗΤΑ")) litres = vals.at(-1);
  }
  if (price && litres && price > 0.5 && price < 5 && litres > 0 && litres < 500) return round2(price * litres);
  return null;
}

// "€5.65-13.00%" (taxi meters): an amount followed by its VAT rate. The rate is not money.
const RATE_SUFFIX = /(\d+(?:\s?[.,]\s?\d{2})?)\s?-\s?\d{1,2}\s?[.,]\s?\d{1,2}\S*/g;
const RATE = /(?<![\d.,])\d{1,2}\s?[.,]\s?\d{2}\s?%/g;

export function cleanLine(line) {
  line = line.replace(STRAY_EURO, "$1€");
  line = line.replace(RATE_SUFFIX, "$1");
  return line.replace(RATE, " % "); // keep the % so VAT lines still look like VAT lines
}

function labelScore(text) {
  const f = fold(text);
  if (hasWord(text, "ΕΝΑΡΞΗ", 0.8) || /ΗΜ\s?\/\s?Ν|ΗΜΕΡΟΜ|DATE|(?<![Α-ΩA-Z])ΗΜ\s?:/.test(f)) return 3;
  if (hasWord(text, "ΛΗΞΗ", 0.8)) return 2;
  return 0;
}

/** @returns {Found} */
export function parseOcr(text) {
  const f = found();
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).map(cleanLine);

  // Date: prefer one that is labelled, on its own line or the line above it:
  //   ΕΝΑΡΞΗ (ΔΙΑΔΡΟΜΗΣ) / ΗΜ/ΝΙΑ / ΗΜΕΡΟΜΗΝΙΑ / DATE  >  ΛΗΞΗ (trip end)  >  unlabelled
  const dated = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(DATE)) {
      const [, d, mo, y] = m;
      const day = validStamp(+y + (y.length === 2 ? 2000 : 0), +mo, +d);
      if (!day) continue;
      let score = labelScore(line);
      if (score === 0 && i > 0 && !DATE1.test(lines[i - 1])) score = labelScore(lines[i - 1]);
      const t = TIME.exec(line.includes(d) ? line.slice(line.indexOf(d)) : line);
      dated.push([score, -i, day, t ? `${pad(+t[1])}:${t[2]}` : null]);
    }
  });
  if (dated.length) {
    dated.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    [, , f.date, f.time] = dated[0];
  }

  // Amount: total lines first, then check net + VAT.
  const totals = [], payable = [];
  let net = null, vat = null;
  lines.forEach((line, i) => {
    let vals = money(line);
    if (!vals.length && TOTAL_WORDS.some((w) => hasWord(line, w)) && i + 1 < lines.length) {
      // "ΠΛΗΡΩΤΕΟ :" with the amount printed on the line below (big taximeter print)
      const below = lines[i + 1];
      if (!NOT_TOTAL_WORDS.some((w) => hasWord(below, w))) vals = money(below);
    }
    if (!vals.length) return;
    if (NOT_TOTAL_WORDS.some((w) => hasWord(line, w))) {
      if (hasWord(line, "ΚΑΘΑΡΗ")) net = vals.at(-1);
      return;
    }
    if (/Φ\.?\s?Π\.?\s?Α|ΦΠΑ|VAT/.test(fold(line)) && line.includes("%") && !hasWord(line, "ΣΥΝΟΛΟ")) {
      vat = vals.at(-1);
      return;
    }
    if (TOTAL_WORDS.some((w) => hasWord(line, w))) {
      totals.push(vals.at(-1));
      if (["ΠΛΗΡΩΤΕΟ", "ΣΥΝΟΛΟ/TOTAL"].some((w) => hasWord(line, w, 0.8))) payable.push(vals.at(-1));
    }
  });

  const fuel = fuelTotal(lines);
  const summed = net !== null && vat !== null ? round2(net + vat) : null;
  const checks = [fuel, summed].filter((c) => c !== null);
  const agreed = totals.filter((t) => checks.some((c) => Math.abs(t - c) <= 0.011)); // pump rounding: 1 cent
  if (agreed.length) f.amount = agreed[0];
  else if (fuel !== null && summed !== null && Math.abs(fuel - summed) <= 0.011) f.amount = summed;
  else if (summed !== null && (totals.includes(summed) || !totals.length)) f.amount = summed;
  else if (summed !== null) { f.amount = Math.max(...totals); f.candidates.push(summed); }
  else if (payable.length) f.amount = payable.at(-1); // the amount payable is the last word on the bill
  else if (totals.length) f.amount = Math.max(...totals);
  else {
    const euros = lines.filter((l) => l.includes("€") || l.toUpperCase().includes("EUR") || fold(l).includes("ΕΥΡΩ")).flatMap(money);
    if (euros.length) { f.amount = Math.max(...euros); f.guessed = true; }
  }
  // As Python: filtered against the candidates found so far, so a total read twice stays twice.
  f.candidates.push(...[...totals, ...checks].filter((t) => t !== f.amount && !f.candidates.includes(t)));
  return f;
}

// --------------------------------------------------------------------------
// Category (kept for the future; not shown in the UI)
// --------------------------------------------------------------------------

const CATEGORY_RULES = [
  ["fuel", ["UNLEADED", "DIESEL", "ΑΜΟΛΥΒΔ", "ΚΑΥΣΙΜ", "ΠΕΤΡΕΛΑΙΟ", "ΒΕΝΖΙΝ", "ΛΙΤΡΩΝ", "LPG", "ΥΓΡΑΕΡΙΟ"]],
  ["tolls", ["ΔΙΟΔΙ", "ΑΤΤΙΚΗ ΟΔΟΣ", "ΟΛΥΜΠΙΑ ΟΔΟΣ", "ΝΕΑ ΟΔΟΣ", "ΕΓΝΑΤΙΑ", "ΜΩΡΕΑΣ", "ΚΕΝΤΡΙΚΗ ΟΔΟΣ", "TOLL"]],
  ["parking", ["ΣΤΑΘΜΕΥΣ", "PARKING"]],
  ["taxi", ["TAXI", "ΤΑΞΙ", "ΚΤΕΛ", "ΑΚΤΟΠΛΟ", "ΕΙΣΙΤΗΡΙΟ", "FERRY", "ΤΑΡΙΦΑ", "ΣΗΜΑΙΑ", "ΔΙΑΔΡΟΜ",
    "ΑΡ.ΟΧΗΜΑΤΟΣ", "ΑΡ. ΟΧΗΜΑΤΟΣ", "ΚΟΜΙΣΤΡ", "ΤΑΞΙΜΕΤΡ", "ΑΝΑΜΟΝΗ"]],
  ["hotel", ["ΞΕΝΟΔΟΧ", "HOTEL", "ΔΙΑΝΥΚΤΕΡ", "ΔΩΜΑΤΙ"]],
  ["meals", ["ΕΣΤΙΑΤ", "ΤΑΒΕΡΝ", "ΚΑΦΕ", "CAFE", "COFFEE", "ΣΟΥΒΛΑΚ", "ΨΗΤΟΠΩΛ", "ΠΙΤΣΑ", "PIZZA", "RESTAURANT", "ΜΕΖΕΔ", "ΓΕΥΜΑ"]],
];

export function guessCategory(text) {
  const t = fold(text);
  const lines = text.split(/\r?\n/);
  for (const [key, words] of CATEGORY_RULES) {
    for (const w of words) {
      if (t.includes(fold(w))) return key;
      if (!w.includes(" ") && w.length >= 5 && lines.some((l) => hasWord(l, w, 0.8))) return key; // OCR swapped a letter
    }
  }
  return "other";
}

const RECEIPT_WORDS = ["ΑΠΟΔΕΙΞΗ", "ΣΥΝΟΛΟ", "ΦΠΑ", "ΑΦΜ", "ΤΙΜΟΛΟΓΙΟ", "TOTAL", "ΜΕΤΡΗΤΑ", "ΚΑΡΤΑ"];

export function looksLikeReceipt(text) {
  const lines = text.split(/\r?\n/);
  return RECEIPT_WORDS.filter((w) => lines.some((l) => hasWord(l, w, 0.8))).length >= 2;
}
