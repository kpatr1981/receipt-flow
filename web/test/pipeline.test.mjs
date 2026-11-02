import { test } from "node:test";
import assert from "node:assert/strict";
import { markDuplicates, monthGroups, pdfName, pdfTitle, surname, sortRows } from "../js/pipeline.js";
import { jpegToPdf, planPage, A4 } from "../js/pdf.js";

const row = (id, photo, date, time, amount, qr = []) => ({ id, photo, date, time, amount, qr, warnings: [] });

test("same QR code: the later copy starts unused", () => {
  const rows = markDuplicates([row("r1", "00_first.jpeg", "2026-10-13", "14:28", 50, ["SIG=A"]), row("r2", "01_second.jpeg", "2026-10-13", "14:28", 50, ["SIG=A"])]);
  assert.equal(rows[0].skip, false);
  assert.equal(rows[1].skip, true);
  assert.equal(rows[1].duplicate_of, "r1");
  assert.match(rows[1].warnings[0], /^Duplicate: same QR code as the 13\/10\/2026, 50\.00 € receipt from first\.jpeg/);
});

test("same date, time and amount: possible duplicate, stays in", () => {
  const rows = markDuplicates([
    row("r1", "00_a.jpg", "2025-07-10", "10:21", 15.48), row("r2", "01_b.jpg", "2025-07-10", "10:21", 15.48), row("r3", "01_b.jpg", "2025-07-10", "18:00", 15.48),
  ]);
  assert.equal(rows[1].skip, false);
  assert.match(rows[1].warnings[0], /^Possible duplicate of the 10\/07\/2025, 15\.48 € receipt from a\.jpg/);
  assert.deepEqual(rows[2].warnings, []);
});

test("months: one group per month, date order, skipped and incomplete rows left out", () => {
  const rows = [row("a", "p", "2026-10-20", "17:36", 20), row("b", "p", "2026-10-13", "13:01", 30), row("c", "p", "2026-11-03", "", 20),
    { ...row("d", "p", "2026-10-01", "", 5), skip: true }, row("e", "p", null, null, 7), row("f", "p", "2026-10-02", "", null)];
  const g = monthGroups(rows);
  assert.deepEqual(g.map((m) => [m.key, m.label, m.rows.map((r) => r.id), m.total]), [
    ["2026-10", "October 2026", ["b", "a"], 50], ["2026-11", "November 2026", ["c"], 20]]);
});

test("optional name in file name and title", () => {
  const [oct] = monthGroups([row("a", "p", "2026-10-20", "", 20)]);
  assert.equal(pdfName(oct, ""), "expenses_oct_2026.pdf");
  assert.equal(pdfName(oct, "  Maria   Papadopoulou "), "expenses_oct_2026_papadopoulou.pdf");
  assert.equal(pdfTitle(oct, ""), "October 2026");
  assert.equal(pdfTitle(oct, " Maria  Papadopoulou"), "Maria Papadopoulou  ·  October 2026");
  assert.equal(surname("Γιώργος Παπαδόπουλος"), "παπαδόπουλος");
});

test("rows sort by date then time, undated last", () => {
  const rows = sortRows([row("a", "p", null, null, 1), row("b", "p", "2026-10-13", "14:28", 1), row("c", "p", "2026-10-13", "13:01", 1)]);
  assert.deepEqual(rows.map((r) => r.id), ["c", "b", "a"]);
});

test("page plan: tall receipts side by side on A4, never upscaled", () => {
  const plan = planPage([[700, 1200], [600, 1100], [750, 1500]]);
  assert.ok((plan.width === A4[0] && plan.height === A4[1]) || (plan.width === A4[1] && plan.height === A4[0]));
  assert.equal(plan.placed.length, 3);
  for (const p of plan.placed) assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= plan.width && p.y + p.h <= plan.height);
  const tiny = planPage([[100, 200]]);
  assert.deepEqual([tiny.placed[0].w, tiny.placed[0].h], [100, 200]);
});

test("PDF: one page, xref offsets point at their objects", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = jpegToPdf(jpeg, 1654, 2339);
  const text = new TextDecoder("latin1").decode(pdf);
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 1);
  assert.match(text, /\/MediaBox \[0 0 595\.44 842\.04\]/);
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.slice(xref).startsWith("xref"));
  const offsets = text.slice(xref).split("\n").slice(3, 8).map((l) => Number(l.slice(0, 10)));
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
});
