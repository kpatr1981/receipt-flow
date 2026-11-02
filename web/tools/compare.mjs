// Run the JS reader on every sample photo and compare with the Python results (test/corpus/py_results.json).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { makeEnv, loadPhoto } from "./nodeenv.mjs";

const root = join(import.meta.dirname, "../..");
const py = JSON.parse(readFileSync(join(import.meta.dirname, "../test/corpus/py_results.json"), "utf8"));
const { cv, detector, pool } = await makeEnv();
const key = (r) => `${r.date ?? "-"} ${r.amount ?? "-"}${r.certain ? " ✓" : ""}`;
let same = 0, total = 0, photosSame = 0;
for (const [rel, expected] of Object.entries(py)) {
  const t = Date.now();
  const mat = await loadPhoto(cv, join(root, rel));
  const recs = await detector.scanPhoto(mat, basename(rel));
  mat.delete();
  recs.forEach((r) => r.crop.delete());
  const a = expected.map(key).sort(), b = recs.map(key).sort();
  const rest = [...b];
  let matched = 0;
  for (const k of a) { const i = rest.indexOf(k); if (i >= 0) { rest.splice(i, 1); matched++; } }
  same += matched; total += Math.max(a.length, b.length);
  const ok = matched === a.length && a.length === b.length;
  if (ok) photosSame++;
  console.log(`${ok ? "SAME" : "DIFF"} ${basename(rel)} (${((Date.now() - t) / 1000).toFixed(0)}s)` +
    (ok ? ` ${a.length} receipts` : `\n   python: ${a.join(" | ")}\n   js:     ${b.join(" | ")}`));
}
console.log(`\nphotos identical: ${photosSame}/${Object.keys(py).length}; receipts matching: ${same}/${total}`);
await pool.close();
