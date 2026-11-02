// Browser side: load the bundled libraries, decode photos, scan them, build PDFs. Nothing leaves the page.
import { createDetector } from "./detect.js";
import { createOcrPool } from "./ocrpool.js";
import { drawMonthPage, jpegToPdf } from "./pdf.js";
import { MAX_SIDE } from "./pipeline.js";

const base = new URL("../", import.meta.url); // the web/ folder
const asset = (path) => new URL(path, base).href;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadOpenCv() {
  // opencv.js expects its WebAssembly preloaded (tools/vendor.mjs split it out of the script).
  const res = await fetch(asset("vendor/opencv/opencv.wasm"));
  if (!res.ok) throw new Error(`Could not load opencv.wasm (${res.status})`);
  globalThis.__opencvWasm = new Uint8Array(await res.arrayBuffer());
  await loadScript(asset("vendor/opencv/opencv.js"));
  let cv = window.cv;
  if (cv instanceof Promise) cv = await cv;
  else if (!cv.Mat) await new Promise((r) => { cv.onRuntimeInitialized = r; });
  return cv;
}

const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement("canvas"), { width: w, height: h });
};

const toBlob = (canvas, type, quality) =>
  canvas.convertToBlob ? canvas.convertToBlob({ type, quality }) : new Promise((r) => canvas.toBlob(r, type, quality));

/** Load everything once. `onStatus(text)` reports progress. */
export async function loadEngine(onStatus = () => {}) {
  onStatus("Loading the image tools…");
  const cv = await loadOpenCv();

  onStatus("Loading the QR reader…");
  const zx = await import(asset("vendor/zxing/es/reader/index.js"));
  await zx.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? asset("vendor/zxing/zxing_reader.wasm") : prefix + path) },
    fireImmediately: true,
  });

  onStatus("Loading the text reader (Greek + English)…");
  const tess = await import(asset("vendor/tesseract/tesseract.esm.min.js"));
  const createWorker = tess.createWorker || tess.default.createWorker;
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const pool = await createOcrPool(createWorker, {
    size,
    options: {
      workerPath: asset("js/tess-worker.js"), // wraps vendor/tesseract/worker.min.js (language files as text)
      workerBlobURL: false,
      corePath: asset("vendor/tesseract/core"),
      langPath: asset("vendor/tessdata").replace(/\/$/, ""),
      gzip: true,
    },
  });
  const detector = createDetector({ cv, readBarcodes: zx.readBarcodes, ocr: pool.ocr, concurrency: size });

  // ------------------------------------------------------------ photos
  async function bitmapOf(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      if (!/\.hei[cf]$/i.test(file.name) && !/hei[cf]/i.test(file.type)) throw e;
      // Browsers without HEIC support: convert in the page with libheif (bundled).
      if (!window.heic2any) await loadScript(asset("vendor/heic2any/heic2any.min.js"));
      const jpeg = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 });
      return createImageBitmap(Array.isArray(jpeg) ? jpeg[0] : jpeg, { imageOrientation: "from-image" });
    }
  }

  /** File -> RGB cv.Mat (upright per EXIF, long side at most MAX_SIDE). */
  async function decode(file) {
    const bitmap = await bitmapOf(file);
    const s = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
    const canvas = makeCanvas(w, h);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const rgba = cv.matFromImageData(g.getImageData(0, 0, w, h));
    const rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    rgba.delete();
    return rgb;
  }

  /** RGB Mat -> JPEG Blob (optionally scaled so the long side is at most `maxSide`). */
  async function jpegOf(mat, quality = 0.9, maxSide = Infinity) {
    let src = mat;
    const s = Math.min(1, maxSide / Math.max(mat.rows, mat.cols));
    if (s < 1) {
      src = new cv.Mat();
      cv.resize(mat, src, new cv.Size(0, 0), s, s, cv.INTER_AREA);
    }
    const rgba = new cv.Mat();
    cv.cvtColor(src, rgba, cv.COLOR_RGB2RGBA);
    const canvas = makeCanvas(rgba.cols, rgba.rows);
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows), 0, 0);
    rgba.delete();
    if (src !== mat) src.delete();
    return toBlob(canvas, "image/jpeg", quality);
  }

  /**
   * Read every receipt in a photo. Returns receipts with `cropBlob` (JPEG) and the upright photo
   * as a JPEG (for receipts added by hand).
   */
  async function scan(file, name, onProgress) {
    const photo = await decode(file);
    let upright = null;
    try {
      const recs = await detector.scanPhoto(photo, name, onProgress, async (img) => { upright = await jpegOf(img, 0.88, 2000); });
      for (const r of recs) {
        r.cropBlob = await jpegOf(r.crop, 0.9);
        r.crop.delete();
        delete r.crop;
      }
      return { receipts: recs, upright };
    } finally {
      photo.delete();
    }
  }

  /** One month's PDF: numbered crops on one A4 page. Returns {pdf: Blob, preview: Blob}. */
  async function monthPdf(cropBlobs, title) {
    const images = await Promise.all(cropBlobs.map((b) => createImageBitmap(b)));
    const page = drawMonthPage(makeCanvas, images, title);
    images.forEach((im) => im.close?.());
    const jpeg = await toBlob(page, "image/jpeg", 0.85);
    const bytes = new Uint8Array(await jpeg.arrayBuffer());
    return { pdf: new Blob([jpegToPdf(bytes, page.width, page.height)], { type: "application/pdf" }), preview: jpeg };
  }

  return { scan, monthPdf, workers: size };
}

export async function sha256(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // crypto.subtle exists only on https or localhost; served over plain http (an intranet host) use our own.
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) : sha256Bytes(bytes);
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Plain SHA-256 (FIPS 180-4), for pages without crypto.subtle. */
export function sha256Bytes(data) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length, total = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(data);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000), false);
  view.setUint32(total - 4, (len << 3) >>> 0, false);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + 4 * t, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  H.forEach((v, i) => ov.setUint32(4 * i, v, false));
  return out;
}
