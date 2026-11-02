// node tools/scan.mjs photo... : run the browser code on photos from the command line.
import { makeEnv, loadPhoto } from "./nodeenv.mjs";
import { basename } from "node:path";

const files = process.argv.slice(2);
const { cv, detector, pool } = await makeEnv();
for (const f of files) {
  const t = Date.now();
  const mat = await loadPhoto(cv, f);
  const recs = await detector.scanPhoto(mat, basename(f));
  console.log(`== ${basename(f)}  ${mat.cols}x${mat.rows} receipts=${recs.length} ${((Date.now() - t) / 1000).toFixed(1)}s`);
  for (const r of recs) {
    console.log(`   ${r.date} ${r.time} ${r.amount} ${r.category.padEnd(7)} ${r.source.padEnd(3)} ${r.certain ? "CERTAIN" : ""} ${r.warnings.join("; ")}`);
    r.crop.delete();
  }
  mat.delete();
}
await pool.close();
