// Port of tests/test_parse.py: the same cases must give the same answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQr, parseOcr, guessCategory, looksLikeReceipt, similarity } from "../js/parse.js";

const pick = (f, ...keys) => keys.map((k) => f[k]);

test("difflib-compatible similarity", () => {
  assert.equal(similarity("ΤΑΡΙΦΛ", "ΤΑΡΙΦΑ").toFixed(4), (10 / 12).toFixed(4));
  assert.equal(similarity("abcd", "bcde"), 0.75);
  assert.equal(similarity("", ""), 1);
});

test("aade signature url", () => {
  const f = parseQr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DMW25009721000085977D569F78468776A75B03E328C34461261013142850.00");
  assert.deepEqual(pick(f, "date", "time", "amount"), ["2026-10-13", "14:28", 50]);
});

test("aade signature small amount", () => {
  const f = parseQr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DMW250097210000859032591D5B82B946E07C5F5B8BFB35DC26101313015.50");
  assert.deepEqual(pick(f, "date", "amount"), ["2026-10-13", 5.5]);
});

test("semicolon qr", () => {
  const f = parseQr("2;0016831;0438144490643;2026-10-20;17:36:20;A;1350370;A;1;10;2;2,129;9,39;20,00;1118469");
  assert.deepEqual(pick(f, "date", "time", "amount"), ["2026-10-20", "17:36", 20]);
});

test("qr without data", () => {
  assert.equal(parseQr("https://example.com/pay?id=abc"), null);
});

const OCR_SAMPLE = `TIMH ALTPOY 2,129
ΣΥΝΟΛΟ ΛΙΤΡΩΝ 9,390
ΚΑΘΑΡΗ ΑΞΙΑ 16,13€
Φ.Π.Α. 24, 00% — 3,87€
XYNOAO ME ΦΠΑ 20 ,00€
HM/NIA: 20/10/2026 17:36
`;

test("ocr total, date, time", () => {
  assert.deepEqual(pick(parseOcr(OCR_SAMPLE), "date", "time", "amount"), ["2026-10-20", "17:36", 20]);
});

test("ocr net plus vat when total unreadable", () => {
  const f = parseOcr("ΚΑΘΑΡΗ ΑΞΙΑ 40,32€\nΦ.Π.Α. 24,00% 9,68€\nΣΥΝΟΛΟ ΜΕ ΦΠΑ ~~~\nΗΜ/ΝΙΑ:13/10/2026 14:28");
  assert.equal(f.amount, 50);
  assert.equal(f.date, "2026-10-13");
});

test("categories", () => {
  assert.equal(guessCategory("UNLEADED 95\nΤΙΜΗ ΛΙΤΡΟΥ"), "fuel");
  assert.equal(guessCategory("ΑΤΤΙΚΗ ΟΔΟΣ Α.Ε. ΔΙΟΔΙΑ"), "tolls");
  assert.equal(guessCategory("TAXI 1234"), "taxi");
  assert.equal(guessCategory("ΚΑΤΙ ΑΛΛΟ"), "other");
  assert.equal(guessCategory("ΤΑΡΙΦΑ 1 ΧΛΜ ΚΟΣΤΟΣ\nΣΗΜΑΙΑ 1.80"), "taxi");
});

test("handwriting is not a receipt", () => {
  assert.equal(looksLikeReceipt("J. DOE\n10/2026"), false);
  assert.equal(looksLikeReceipt("ΑΠΟΔΕΙΞΗ ΕΣΟΔΟΥ\nΣΥΝΟΛΟ ΜΕ ΦΠΑ 20,00"), true);
});

const SEP_FUEL_OCR = `UNL CRYSTAL NEXT --
| TIMH AITPOY ΄. Coe Pe, 1,730
> ZYNOAO AITPON Mee ο 34,690
{ ΚΑΘΑΡΗ ΑΞΙΑ | we 43,40€
\\ Φ.Π.Α. 24,008 ο τς 11, 61€ |
ΑΣ ΣΥΝΟΝΟ ΝΕ OMA στ 5 60,018
HM/NIA: 02/09/2025 12:44 1: -
`;

test("ocr noisy fuel total (euro read as 8; litres x price confirms)", () => {
  assert.deepEqual(pick(parseOcr(SEP_FUEL_OCR), "date", "time", "amount"), ["2025-09-02", "12:44", 60.01]);
});

test("taximeter sig without date", () => {
  const f = parseQr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=GL125000170000007300A5343330DD4A96948A58351A0BFE3D04B383D0D00010.52");
  assert.equal(f.date, null);
  assert.equal(f.amount, 10.52);
});

test("sig layout without timestamp", () => {
  const f = parseQr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DLD200171390088437748B72ED35F2301678FDB32892B4FE7495D021B9811.99");
  assert.equal(f.amount, 11.99);
  assert.equal(f.date, null);
  assert.deepEqual(f.candidates, []);
});

test("sig layout comma total", () => {
  assert.equal(parseQr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=CCC1800337600577775522E747A6A6A931409188575C073385A76FCD8A813,44").amount, 13.44);
});

test("sig layout with timestamp", () => {
  const f = parseQr("https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=DMK2400468000218726EA86D8163BCEC7F4994F268432F440260602223710.00");
  assert.deepEqual(pick(f, "date", "time", "amount"), ["2026-06-02", "22:37", 10]);
});

test("vat rate after amount is not money", () => {
  const f = parseOcr("ΤΗΛ.ΡΑΝΤΕΒ\n€ 565-13. 88\nΣ.ΠΡΟΣ/ΤΩΝ :\n€5.65-13.08¢\n");
  assert.notEqual(f.amount, 13.88);
  assert.notEqual(f.amount, 13.08);
});

test("payable on the line below", () => {
  const f = parseOcr("ΣΥΝΟΛΙΚΗ ΧΡΕΩΣΗ: 9,35\nΠΛΗΡΩΤΕΟ :\n€ 22,60\nΗΜ/ΝΙΑ: 03/09/2025 12:19");
  assert.deepEqual(pick(f, "amount", "date"), [22.6, "2025-09-03"]);
});

test("guess is flagged", () => {
  const f = parseOcr("ΚΑΤΙ € 5,65\nΑΛΛΟ € 1,80");
  assert.equal(f.amount, 5.65);
  assert.equal(f.guessed, true);
});

test("rate with lost decimal point", () => {
  const f = parseOcr("τς € 565-13. 88\nτος ε.88:19.88/\n");
  assert.ok(![13.88, 19.88].includes(f.amount));
});

test("dates with dashes and dots", () => {
  assert.equal(parseOcr("ΕΝΑΡΞΗ ΔΙΑΔΡΟΜΗΣ:\nΗΜ/ΝΙΑ: 30-05-2023 11:24\nΠΛΗΡΩΤΕΟ: 15,67").date, "2023-05-30");
  assert.equal(parseOcr("ΗΜΕΡΟΜΗΝΙΑ 30.05.2023\nΣΥΝΟΛΟ 15,67").date, "2023-05-30");
  assert.equal(parseQr("x;30-05-2023;11:24;15,67").date, "2023-05-30");
  assert.equal(parseQr("x;30.05.2023;15,67").date, "2023-05-30");
  assert.equal(parseQr("x;2023-05-30;15,67").date, "2023-05-30");
});

test("date under trip start label", () => {
  const text = "ΑΔΕΙΑ ΚΥΚΛΟΦΟΡΙΑΣ 12/01/2019\nΕΝΑΡΞΗ ΔΙΑΔΡΟΜΗΣ:\n03/09/2025 11:54 ΘΘ\nΛΗΞΗ ΔΙΑΔΡΟΜΗΣ:\n03/09/2025 12:19 ΘΘ\nΠΛΗΡΩΤΕΟ :\n€ 22,60";
  assert.deepEqual(pick(parseOcr(text), "date", "time", "amount"), ["2025-09-03", "11:54", 22.6]);
});

test("trip end beats unlabelled", () => {
  assert.deepEqual(pick(parseOcr("ΑΔΕΙΑ 12/01/2019\nΛΗΞΗ ΔΙΑΔΡΟΜΗΣ:\n03/09/2025 12:19\n"), "date", "time"), ["2025-09-03", "12:19"]);
});

test("trip start same line", () => {
  assert.deepEqual(pick(parseOcr("ΕΝΑΡΞΗ: 24/09/2025 11:07\nΛΗΞΗ: 24/09/2025 11:19\n"), "date", "time"), ["2025-09-24", "11:07"]);
});
