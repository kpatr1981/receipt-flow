// Node environment for the browser code: same libraries and language files, photos decoded with sharp.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createDetector } from "../js/detect.js";
import { createOcrPool } from "../js/ocrpool.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(web, "package.json"));

export async function loadCv() {
  let cv = require("@techstark/opencv-js");
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat) await new Promise((r) => { cv.onRuntimeInitialized = r; });
  return cv;
}

export async function makeEnv({ workers = Math.max(1, Math.min(6, cpus().length - 1)) } = {}) {
  const cv = await loadCv();
  const zx = await import(join(web, "vendor/zxing/es/reader/index.js"));
  zx.prepareZXingModule({
    overrides: { wasmBinary: readFileSync(join(web, "vendor/zxing/zxing_reader.wasm")) },
    fireImmediately: true,
  });
  const { createWorker } = require("tesseract.js");
  const pool = await createOcrPool(createWorker, {
    size: workers,
    options: { langPath: join(web, "vendor/tessdata"), gzip: true, cacheMethod: "none" },
  });
  const detector = createDetector({ cv, readBarcodes: zx.readBarcodes, ocr: pool.ocr, concurrency: workers });
  return { cv, detector, pool };
}

/** Decode a photo file to an RGB cv.Mat with EXIF orientation applied (like Pillow's exif_transpose). */
export async function loadPhoto(cv, path) {
  let input = path;
  if (/\.hei[cf]$/i.test(path)) {
    // sharp builds usually lack HEVC: convert with macOS sips for the test harness.
    const out = join(mkdtempSync(join(tmpdir(), "rf-")), "photo.png");
    execFileSync("sips", ["-s", "format", "png", path, "--out", out], { stdio: "ignore" });
    input = out;
  }
  const { data, info } = await sharp(input).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mat = new cv.Mat(info.height, info.width, cv.CV_8UC3);
  mat.data.set(data);
  return mat;
}
