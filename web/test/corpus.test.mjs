// The JS parser must agree with the Python parser on every real OCR text and QR code from samples/.
// Corpus built by tools/make_corpus.py (skipped when absent: it holds personal receipt text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseQr, parseOcr, guessCategory, looksLikeReceipt } from "../js/parse.js";

const file = new URL("./corpus/parse_corpus.json", import.meta.url);
const corpus = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;

test("QR payloads match Python", { skip: !corpus }, () => {
  for (const { text, expect } of corpus.qr) {
    const f = parseQr(text);
    const got = f && { date: f.date, time: f.time, amount: f.amount, candidates: f.candidates };
    assert.deepEqual(got, expect, text);
  }
});

test("OCR texts match Python", { skip: !corpus }, () => {
  let n = 0;
  for (const { text, expect, photo } of corpus.ocr) {
    const f = parseOcr(text);
    const got = { date: f.date, time: f.time, amount: f.amount, candidates: f.candidates, guessed: f.guessed,
      category: guessCategory(text), receipt: looksLikeReceipt(text) };
    assert.deepEqual(got, expect, `${photo}:\n${text}`);
    n++;
  }
  assert.ok(n > 100);
});
