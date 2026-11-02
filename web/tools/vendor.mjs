// Copy the browser libraries and Tesseract language data into web/vendor/ so the page needs no CDN.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(web, "node_modules");
const out = join(web, "vendor");
const files = {
  "tesseract/tesseract.esm.min.js": "tesseract.js/dist/tesseract.esm.min.js",
  "tesseract/worker.min.js": "tesseract.js/dist/worker.min.js",
  "tesseract/core/tesseract-core-lstm.wasm.js": "tesseract.js-core/tesseract-core-lstm.wasm.js",
  "tesseract/core/tesseract-core-simd-lstm.wasm.js": "tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js": "tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "zxing/es/reader/index.js": "zxing-wasm/dist/es/reader/index.js",
  "zxing/es/share.js": "zxing-wasm/dist/es/share.js",
  "zxing/zxing_reader.wasm": "zxing-wasm/dist/reader/zxing_reader.wasm",
  "opencv/opencv.js": "@techstark/opencv-js/dist/opencv.js",
  "heic2any/heic2any.min.js": "heic2any/dist/heic2any.min.js",
};
for (const [to, from] of Object.entries(files)) {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  copyFileSync(join(nm, from), join(out, to));
}
// Same LSTM models the Python version uses (Homebrew tessdata), gzipped as tesseract.js expects.
const tessdata = process.env.TESSDATA || "/opt/homebrew/share/tessdata";
mkdirSync(join(out, "tessdata"), { recursive: true });
for (const lang of ["ell", "eng"]) {
  const gz = gzipSync(readFileSync(join(tessdata, `${lang}.traineddata`)), { level: 9 });
  writeFileSync(join(out, "tessdata", `${lang}.traineddata.gz`), gz); // Node / any web server
  writeFileSync(join(out, "tessdata", `${lang}.traineddata.gz.txt`), gz.toString("base64")); // hosts that serve text only (js/tess-worker.js)
}
// opencv.js embeds its WebAssembly as a raw-byte string (control characters in a text file, which some hosts
// refuse). Split it out: vendor/opencv/opencv.wasm, and opencv.js reads globalThis.__opencvWasm instead.
{
  const file = join(out, "opencv/opencv.js");
  const src = readFileSync(file, "utf8");
  const head = "findWasmBinary(){return binaryDecode(";
  const a = src.indexOf(head);
  if (a < 0) throw new Error("opencv.js layout changed: findWasmBinary not found");
  const q0 = a + head.length, quote = src[q0];
  let i = q0 + 1;
  for (;; i++) { if (src[i] === "\\") { i++; continue; } if (src[i] === quote) break; }
  const literal = src.slice(q0, i + 1);
  const str = Function(`"use strict"; return ${literal};`)();
  const bytes = new Uint8Array(str.length);
  for (let k = 0; k < str.length; k++) { const c = str.charCodeAt(k); bytes[k] = (~c >> 8) & c; }
  if (!WebAssembly.validate(bytes)) throw new Error("extracted opencv wasm is not valid");
  writeFileSync(join(out, "opencv/opencv.wasm"), bytes);
  const end = src.indexOf("}", i);
  const patched = src.slice(0, a) +
    'findWasmBinary(){if(!globalThis.__opencvWasm)throw new Error("opencv.wasm was not preloaded");return globalThis.__opencvWasm' +
    src.slice(end);
  writeFileSync(file, patched);
  console.log(`opencv: ${bytes.length} bytes of wasm split out; opencv.js now ${patched.length} chars`);
}
console.log("vendored into", out);
