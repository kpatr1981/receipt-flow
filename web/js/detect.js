// Image side: find receipts in a photo, read their QR codes, OCR them.
// Port of receiptflow/detect.py. Runs in the browser and in Node: the caller passes in
//   cv            - an initialised opencv.js module
//   readBarcodes  - zxing-wasm's readBarcodes({width, height, data: RGBA})
//   ocr           - async (imageBytes: Uint8Array /* BMP */, psm: number) => string
// Images are cv.Mat in RGB order (CV_8UC3). Every function frees the Mats it creates.

import * as parse from "./parse.js";

export const HANDWRITING_DENSITY = 0.3; // tall components sparser than this are handwriting
export const WORK_SIZE = 1600; // long side, px, of the copy used to find receipts
export const LINE_JOIN = 0.0035; // horizontal reach (fraction of photo) that joins letters into a text line
export const AMOUNT_COLUMN = 0.06; // blocks narrower than this (fraction of photo) can be a receipt's amounts column
export const BLOCK_GAP = 0.035; // max vertical gap (fraction of photo size) between parts of one receipt

const RECEIPT_WORDS_FOR_TURN = ["ΑΠΟΔΕΙΞΗ", "ΣΥΝΟΛΟ", "ΦΠΑ", "ΑΦΜ", "ΔΟΥ", "ΤΙΜΗ", "ΠΛΗΡΩΤΕΟ", "ΜΕΤΡΗΤΑ", "ΚΑΡΤΑ", "ΕΥΡΩ",
  "ΑΞΙΑ", "ΠΟΣΟΤΗΤΑ", "ΛΙΤΡΩΝ", "ΤΑΡΙΦΑ", "ΤΗΛ", "TOTAL", "EUR", "ΗΜ", "ΑΡ"];

/** Python's round(): half to even. */
const pyRound = (x) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** numpy.median of uint8 values given as a 256-bin histogram, truncated to an int like astype(uint8). */
function medianFromHist(hist, n) {
  const at = (k) => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c > k) return v; } return 255; };
  return n % 2 ? at((n - 1) / 2) : Math.trunc((at(n / 2 - 1) + at(n / 2)) / 2);
}

function median(values) {
  const v = Float64Array.from(values).sort();
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

export function createDetector({ cv, readBarcodes, ocr, concurrency = 2 }) {
  // ---------------------------------------------------------------- helpers
  const P = (x, y) => new cv.Point(x, y);
  const S = (w, h) => new cv.Size(w, h);

  function resize(src, fx, fy, interp) {
    const dst = new cv.Mat();
    cv.resize(src, dst, S(0, 0), fx, fy, interp);
    return dst;
  }
  function resizeTo(src, w, h, interp) {
    const dst = new cv.Mat();
    cv.resize(src, dst, S(w, h), 0, 0, interp);
    return dst;
  }
  function gray(src) {
    const dst = new cv.Mat();
    cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY);
    return dst;
  }
  function ones(rows, cols) {
    return cv.Mat.ones(rows, cols, cv.CV_8U);
  }
  function dilate(src, kernel) {
    const dst = new cv.Mat();
    cv.dilate(src, dst, kernel, P(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    return dst;
  }

  const ROTATE = { 90: cv.ROTATE_90_COUNTERCLOCKWISE, 180: cv.ROTATE_180, [-90]: cv.ROTATE_90_CLOCKWISE };
  /** Quarter turn: 0, 90 (counter-clockwise), 180, -90 (clockwise). Always returns a new Mat. */
  function turn(src, quarter) {
    if (!quarter) return src.clone();
    const dst = new cv.Mat();
    cv.rotate(src, dst, ROTATE[quarter]);
    return dst;
  }

  /** 8-bit grayscale BMP: lossless, and both Tesseract builds read it. */
  function grayBmp(mat) {
    const w = mat.cols, h = mat.rows, stride = (w + 3) & ~3;
    const header = 14 + 40 + 1024, size = header + stride * h;
    const buf = new Uint8Array(size), dv = new DataView(buf.buffer);
    buf[0] = 0x42; buf[1] = 0x4d;
    dv.setUint32(2, size, true); dv.setUint32(10, header, true);
    dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, 8, true); dv.setUint32(34, stride * h, true);
    dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true); dv.setUint32(46, 256, true);
    for (let i = 0; i < 256; i++) { const o = 54 + i * 4; buf[o] = buf[o + 1] = buf[o + 2] = i; }
    const src = mat.data;
    for (let y = 0; y < h; y++) buf.set(src.subarray((h - 1 - y) * w, (h - y) * w), header + y * stride);
    return buf;
  }

  const runOcr = (grayMat, psm) => ocr(grayBmp(grayMat), psm);

  // ------------------------------------------------------- finding receipts
  /** Dark printed ink only: coloured stamps and pen are ignored; long straight paper edges dropped. */
  function ink(small) {
    const g = gray(small);
    const hsv = new cv.Mat();
    cv.cvtColor(small, hsv, cv.COLOR_RGB2HSV);
    const px = small.data, hv = hsv.data, gd = g.data;
    for (let i = 0, n = g.rows * g.cols; i < n; i++) {
      const r = px[3 * i], b = px[3 * i + 2];
      if (b - r > 18 || r - b > 30 || hv[3 * i + 1] > 70) gd[i] = 255;
    }
    hsv.delete();
    const out = new cv.Mat();
    cv.adaptiveThreshold(g, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 18);
    g.delete();

    const M = Math.max(out.rows, out.cols);
    const L = Math.max(15, Math.trunc(0.025 * M));
    const k13 = ones(1, 3), k31 = ones(3, 1), kL1 = ones(L, 1), k1L = ones(1, 3 * L), k33 = ones(3, 3);
    const fatX = dilate(out, k13), fatY = dilate(out, k31);
    const vertical = new cv.Mat(), horizontal = new cv.Mat();
    cv.morphologyEx(fatX, vertical, cv.MORPH_OPEN, kL1, P(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    cv.morphologyEx(fatY, horizontal, cv.MORPH_OPEN, k1L, P(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const both = new cv.Mat();
    cv.bitwise_or(vertical, horizontal, both);
    const edges = dilate(both, k33);
    const notEdges = new cv.Mat();
    cv.bitwise_not(edges, notEdges);
    const result = new cv.Mat();
    cv.bitwise_and(out, notEdges, result);
    for (const m of [out, k13, k31, kL1, k1L, k33, fatX, fatY, vertical, horizontal, both, edges, notEdges]) m.delete();
    return result;
  }

  /** Receipts in an upright photo, left to right: [{bbox:[x,y,w,h], foreign: Uint8Array|null}] */
  function findReceipts(img) {
    const h = img.rows, w = img.cols;
    const s = Math.min(1, WORK_SIZE / Math.max(h, w));
    const small = resize(img, s, s, cv.INTER_AREA);
    const sh = small.rows, sw = small.cols, M = Math.max(sh, sw);
    const inkMat = ink(small);
    small.delete();
    const kLine = cv.getStructuringElement(cv.MORPH_RECT, S(Math.max(3, Math.trunc(LINE_JOIN * M)), 3));
    const lines = dilate(inkMat, kLine);
    inkMat.delete(); kLine.delete();
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const n = cv.connectedComponentsWithStats(lines, labels, stats, cents, 8, cv.CV_32S);
    lines.delete(); cents.delete();
    const sd = stats.data32S;
    const st = (i) => [sd[i * 5], sd[i * 5 + 1], sd[i * 5 + 2], sd[i * 5 + 3], sd[i * 5 + 4]];

    const keep = [];
    for (let i = 1; i < n; i++) {
      const [x, y, bw, bh, area] = st(i);
      if (area < 30 || bh < 0.005 * M) continue; // specks, hairlines, dashed separators
      if (bh > 0.35 * M || bw > 0.45 * sw) continue; // desk, big shadows
      if (bh > 0.03 * M && area / (bw * bh) < HANDWRITING_DENSITY) continue; // handwriting
      if (bh > 2.5 * bw) continue; // paper edges
      if (x === 0 || y === 0 || x + bw >= sw || y + bh >= sh) continue; // cut by the photo border
      keep.push(i);
    }

    // Lines -> blocks: horizontal overlap and a small vertical gap.
    const parent = new Map(keep.map((i) => [i, i]));
    const root = (i) => {
      while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); }
      return i;
    };
    const byTop = [...keep].sort((a, b) => sd[a * 5 + 1] - sd[b * 5 + 1]);
    for (let k = 0; k < byTop.length; k++) {
      const [ax, ay, aw, ah] = st(byTop[k]);
      for (let j = k + 1; j < byTop.length; j++) {
        const [bx, by, bw2] = st(byTop[j]);
        if (by - (ay + ah) > 0.03 * M) break;
        if (Math.min(ax + aw, bx + bw2) - Math.max(ax, bx) > 0.3 * Math.min(aw, bw2)) parent.set(root(byTop[k]), root(byTop[j]));
      }
    }
    const groups = new Map();
    for (const i of keep) { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }

    const span = (members) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of members) {
        const [x, y, bw, bh] = st(i);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + bw); y1 = Math.max(y1, y + bh);
      }
      return [x0, y0, x1, y1];
    };

    // Blocks -> receipts: amount columns join their labels (leftwards) first, then stacked blocks join.
    const stacked = (A, B) => {
      const overlap = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
      const gap = Math.max(A[1], B[1]) - Math.min(A[3], B[3]);
      return overlap > 0.5 * Math.min(A[2] - A[0], B[2] - B[0]) && gap < BLOCK_GAP * M;
    };
    const beside = (A, B) => {
      const vOverlap = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
      const [wide, thin] = A[2] - A[0] >= B[2] - B[0] ? [A, B] : [B, A];
      return thin[2] - thin[0] < AMOUNT_COLUMN * M && wide[0] < thin[0]
        && -0.02 * M < thin[0] - wide[2] && thin[0] - wide[2] < 0.04 * M
        && vOverlap > 0.6 * (thin[3] - thin[1]);
    };
    let blocks = [...groups.values()];
    for (const rule of [beside, stacked]) {
      let merged = true;
      while (merged) {
        merged = false;
        outer: for (let a = 0; a < blocks.length; a++) {
          const A = span(blocks[a]);
          for (let b = a + 1; b < blocks.length; b++) {
            if (rule(A, span(blocks[b]))) {
              blocks[a] = blocks[a].concat(blocks.splice(b, 1)[0]);
              merged = true;
              break outer;
            }
          }
        }
      }
    }

    const splitColumns = (members) => {
      const [x0, , x1] = span(members);
      const width = x1 - x0;
      if (width < 0.15 * M || members.length < 6) return [members];
      const cover = new Int32Array(width);
      for (const i of members) {
        const [x, , bw] = st(i);
        for (let c = x - x0; c < x - x0 + bw; c++) cover[c] += 1;
      }
      const busy = median([...cover].filter((v) => v > 0));
      const margin = Math.trunc(0.06 * M);
      let best = null, bestX = null;
      for (let x = margin; x < width - margin; x++) {
        if (cover[x] <= Math.max(1, 0.12 * busy) && (best === null || cover[x] < best)) { best = cover[x]; bestX = x; }
      }
      if (bestX === null) return [members];
      const cut = x0 + bestX;
      const left = members.filter((i) => sd[i * 5] + sd[i * 5 + 2] / 2 < cut);
      const right = members.filter((i) => sd[i * 5] + sd[i * 5 + 2] / 2 >= cut);
      if (left.length < 3 || right.length < 3) return [members];
      return [...splitColumns(left), ...splitColumns(right)];
    };

    blocks = blocks.flatMap(splitColumns);
    blocks = blocks.filter((m) => m.length >= 3 && span(m)[3] - span(m)[1] >= 0.06 * M);
    const owner = new Int32Array(n);
    blocks.forEach((members, k) => { for (const i of members) owner[i] = k + 1; });
    const lab = labels.data32S;

    const regions = [];
    const pad = Math.trunc(0.012 * M);
    blocks.forEach((members, idx) => {
      const k = idx + 1;
      let [x0, y0, x1, y1] = span(members);
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(sw, x1 + pad); y1 = Math.min(sh, y1 + pad);
      const box = [Math.trunc(x0 / s), Math.trunc(y0 / s), Math.trunc((x1 - x0) / s), Math.trunc((y1 - y0) / s)];
      const other = new cv.Mat(y1 - y0, x1 - x0, cv.CV_8U);
      const od = other.data;
      let any = false;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = owner[lab[y * sw + x]];
          const v = o !== 0 && o !== k ? 1 : 0;
          od[(y - y0) * (x1 - x0) + (x - x0)] = v;
          if (v) any = true;
        }
      }
      let foreign = null;
      if (any) {
        const big = resizeTo(other, box[2], box[3], cv.INTER_NEAREST);
        foreign = { data: big.data.slice(), width: box[2], height: box[3] };
        big.delete();
      }
      other.delete();
      regions.push({ bbox: box, foreign });
    });
    labels.delete(); stats.delete();
    regions.sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
    return regions.length ? regions : [{ bbox: [0, 0, w, h], foreign: null }];
  }

  /** The receipt cut out, with ink from neighbouring receipts painted paper-white. */
  function cropRegion(img, region) {
    const [x, y, w, h] = region.bbox;
    const rect = new cv.Rect(x, y, Math.min(w, img.cols - x), Math.min(h, img.rows - y));
    const view = img.roi(rect);
    const crop = view.clone();
    view.delete();
    if (region.foreign) {
      const paper = paperColour(crop);
      const d = crop.data, f = region.foreign;
      for (let yy = 0; yy < crop.rows && yy < f.height; yy++) {
        for (let xx = 0; xx < crop.cols && xx < f.width; xx++) {
          if (f.data[yy * f.width + xx]) {
            const o = 3 * (yy * crop.cols + xx);
            d[o] = paper[0]; d[o + 1] = paper[1]; d[o + 2] = paper[2];
          }
        }
      }
    }
    return crop;
  }

  /** Median colour of an RGB Mat (numpy-compatible). */
  function paperColour(mat) {
    const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    const d = mat.data;
    for (let i = 0; i < d.length; i += 3) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; }
    const n = d.length / 3;
    return hist.map((h) => medianFromHist(h, n));
  }

  // --------------------------------------------------------------------- QR
  function quarter(deg) {
    let q = ((pyRound(deg / 90) * 90 + 180) % 360 + 360) % 360 - 180;
    return q === -180 ? 180 : q;
  }

  function rgbaOf(mat) {
    const rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
    const out = { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
    rgba.delete();
    return out;
  }

  /** [{centre:[x,y], text, turn}] for every QR/PDF417/DataMatrix that reads (not shop EAN codes). */
  async function readQrs(mat) {
    const results = await readBarcodes(rgbaOf(mat), { maxNumberOfSymbols: 255 });
    const out = [];
    for (const r of results) {
      if (!r.isValid && r.isValid !== undefined) continue;
      if (r.format === "EAN-13" || r.format === "EAN-8") continue; // loyalty/product barcodes
      const p = r.position;
      const cx = (p.topLeft.x + p.topRight.x + p.bottomLeft.x + p.bottomRight.x) / 4;
      const cy = (p.topLeft.y + p.topRight.y + p.bottomLeft.y + p.bottomRight.y) / 4;
      out.push({ centre: [cx, cy], text: r.text, turn: quarter(r.orientation) });
    }
    return out;
  }

  /** Small or soft QR codes: try bigger and higher-contrast copies. */
  async function readQrsHard(crop) {
    const g = gray(crop);
    try {
      for (const f of [2, 3, 1.5]) {
        const big = resize(g, f, f, cv.INTER_CUBIC);
        const otsu = new cv.Mat(), adapt = new cv.Mat();
        cv.threshold(big, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        cv.adaptiveThreshold(big, adapt, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, 10);
        try {
          for (const variant of [big, otsu, adapt]) {
            const found = await readQrs(variant);
            if (found.length) return found;
          }
        } finally { big.delete(); otsu.delete(); adapt.delete(); }
      }
      return [];
    } finally { g.delete(); }
  }

  // ------------------------------------------------------------ orientation
  async function readability(grayMat) {
    const text = await runOcr(grayMat, 11);
    const folded = parse.fold(text);
    let score = 3 * (text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || []).length;
    score += 2 * (text.match(/\d+[.,]\d{2}(?!\d)/g) || []).length;
    for (const w of RECEIPT_WORDS_FOR_TURN) score += 3 * (folded.split(w).length - 1);
    return score;
  }

  /** No QR to go by: read a small copy each way round and keep the most readable. */
  async function textTurn(img, candidates = [0, 90, 180, -90]) {
    const f = Math.min(1, 1400 / Math.max(img.rows, img.cols));
    const small = resize(img, f, f, cv.INTER_AREA);
    const g = gray(small);
    small.delete();
    const scores = new Map();
    await Promise.all(candidates.map(async (q) => {
      const t = turn(g, q);
      try { scores.set(q, await readability(t)); } finally { t.delete(); }
    }));
    g.delete();
    let best = candidates[0];
    for (const q of candidates) if (scores.get(q) > scores.get(best)) best = q;
    if (best !== 0 && scores.get(best) < Math.max(6, 1.3 * (scores.get(0) ?? 0))) return 0;
    return best;
  }

  function mostCommonTurn(qrs) {
    const counts = new Map();
    for (const q of qrs) counts.set(q.turn, (counts.get(q.turn) || 0) + 1);
    let best = null;
    for (const [k, v] of counts) if (best === null || v > counts.get(best)) best = k;
    return best;
  }

  async function uprightTurn(img, qrs) {
    return qrs.length ? mostCommonTurn(qrs) : textTurn(img);
  }

  // -------------------------------------------------------------------- OCR
  function upscaledGray(crop) {
    const g = gray(crop);
    const f = Math.min(3, Math.max(1, 1600 / crop.cols));
    const out = resize(g, f, f, cv.INTER_CUBIC);
    g.delete();
    return out;
  }

  /** OCR texts from gentlest to most aggressive preparation; the caller stops when it has enough. */
  async function* ocrPasses(crop) {
    const g = upscaledGray(crop);
    try {
      yield await runOcr(g, 6);

      const hsv = new cv.Mat();
      cv.cvtColor(crop, hsv, cv.COLOR_RGB2HSV);
      const stamp = new cv.Mat(crop.rows, crop.cols, cv.CV_8U);
      const px = crop.data, hv = hsv.data, sm = stamp.data;
      let count = 0;
      for (let i = 0, n = crop.rows * crop.cols; i < n; i++) {
        const v = hv[3 * i + 1] > 60 && px[3 * i + 2] - px[3 * i] > 25 ? 1 : 0;
        sm[i] = v; count += v;
      }
      hsv.delete();
      if (count / (crop.rows * crop.cols) > 0.002) {
        const mask = resizeTo(stamp, g.cols, g.rows, cv.INTER_NEAREST);
        const noStamp = g.clone();
        const nd = noStamp.data, md = mask.data;
        for (let i = 0; i < nd.length; i++) if (md[i]) nd[i] = 255;
        mask.delete();
        stamp.delete();
        try { yield await runOcr(noStamp, 6); } finally { noStamp.delete(); }
      } else stamp.delete();

      const darkSmall = new cv.Mat(crop.rows, crop.cols, cv.CV_8U);
      const dd = darkSmall.data;
      for (let i = 0, n = crop.rows * crop.cols; i < n; i++) dd[i] = Math.min(px[3 * i], px[3 * i + 1], px[3 * i + 2]);
      const dark = resizeTo(darkSmall, g.cols, g.rows, cv.INTER_CUBIC);
      darkSmall.delete();
      const stretched = new cv.Mat();
      cv.normalize(dark, stretched, 0, 255, cv.NORM_MINMAX);
      dark.delete();
      try { yield await runOcr(stretched, 6); } finally { stretched.delete(); }
      yield await runOcr(g, 4);
    } finally { g.delete(); }
  }

  // ----------------------------------------------------------------- deskew
  /** Straighten a receipt lying a few degrees off: pick the angle whose text rows are sharpest. */
  function deskew(crop, maxAngle = 12) {
    const f = Math.min(1, 700 / crop.cols);
    const small = resize(crop, f, f, cv.INTER_AREA);
    const inkMat = ink(small);
    small.delete();
    const w = inkMat.cols, h = inkMat.rows;
    const centre = P(w / 2, h / 2);
    const warped = new cv.Mat(), rows = new cv.Mat();
    const score = (angle) => {
      const m = cv.getRotationMatrix2D(centre, angle, 1);
      cv.warpAffine(inkMat, warped, m, S(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
      m.delete();
      cv.reduce(warped, rows, 1, cv.REDUCE_SUM, cv.CV_64F);
      const r = rows.data64F;
      let s = 0;
      for (let i = 1; i < r.length; i++) s += (r[i] - r[i - 1]) ** 2;
      return s;
    };
    const argmax = (angles) => {
      let best = angles[0], bestS = -Infinity;
      for (const a of angles) { const sc = score(a); if (sc > bestS) { bestS = sc; best = a; } }
      return best;
    };
    const coarseAngles = [];
    for (let a = -maxAngle; a < maxAngle + 0.1; a += 1) coarseAngles.push(a);
    const coarse = argmax(coarseAngles);
    const fine = [];
    for (let k = 0; coarse - 1 + k * 0.25 < coarse + 1.01; k++) fine.push(coarse - 1 + k * 0.25);
    const best = argmax(fine);
    inkMat.delete(); warped.delete(); rows.delete();
    if (Math.abs(best) < 0.5) return crop.clone();

    const H = crop.rows, W = crop.cols;
    const m = cv.getRotationMatrix2D(P(W / 2, H / 2), best, 1);
    const md = m.data64F;
    const cos = Math.abs(md[0]), sin = Math.abs(md[1]);
    const nw = Math.trunc(H * sin + W * cos), nh = Math.trunc(H * cos + W * sin);
    md[2] += nw / 2 - W / 2;
    md[5] += nh / 2 - H / 2;
    const paper = paperColour(crop);
    const out = new cv.Mat();
    cv.warpAffine(crop, out, m, S(nw, nh), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(paper[0], paper[1], paper[2], 255));
    m.delete();
    return out;
  }

  // ----------------------------------------------------- whole photo -> receipts
  const inside = ([px, py], [x, y, w, h]) => x <= px && px <= x + w && y <= py && py <= y + h;
  const foreignAt = (region, [px, py]) => {
    const f = region.foreign;
    if (!f) return false;
    const fy = Math.trunc(py - region.bbox[1]), fx = Math.trunc(px - region.bbox[0]);
    return fy >= 0 && fy < f.height && fx >= 0 && fx < f.width && !!f.data[fy * f.width + fx];
  };

  /**
   * Upright the photo, find the receipts, read each one.
   * @param {cv.Mat} photo RGB Mat (EXIF orientation already applied); not freed here
   * @param {string} name photo name, for messages
   * @param {(p: {done: number, total: number}) => void} [onProgress]
   * @param {(upright: cv.Mat) => Promise<void>} [onUpright] gets the turned photo before it is freed
   */
  async function scanPhoto(photo, name, onProgress, onUpright) {
    let qrs = await readQrs(photo);
    const q = await uprightTurn(photo, qrs);
    const img = turn(photo, q);
    if (q) qrs = await readQrs(img);
    if (onUpright) await onUpright(img);
    const receipts = [];
    try {
      const regions = findReceipts(img);
      let done = 0;
      onProgress?.({ done, total: regions.length });
      const results = new Array(regions.length).fill(null);
      let next = 0;
      const lane = async () => {
        while (next < regions.length) {
          const idx = next++;
          results[idx] = await readRegion(img, regions[idx], qrs, name);
          onProgress?.({ done: ++done, total: regions.length });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
      for (const r of results) if (r) receipts.push(r);
    } finally { img.delete(); }
    return receipts;
  }

  /** One receipt: straighten, read QR, OCR until date and total are found. Returns null for non-receipts. */
  async function readRegion(img, region, qrs, name) {
        const box = region.bbox;
        let crop = cropRegion(img, region);
        let mine = qrs.filter((r) => inside(r.centre, box) && !foreignAt(region, r.centre));
        const ownTurn = mine.length ? mostCommonTurn(mine) : await textTurn(crop, [0, 180]);
        if (ownTurn) { const t = turn(crop, ownTurn); crop.delete(); crop = t; }
        const straight = deskew(crop);
        crop.delete();
        crop = straight;
        if (!mine.length) mine = await readQrsHard(crop);
        const qrTexts = mine.map((r) => r.text);
        const qrFound = qrTexts.map(parse.parseQr).filter(Boolean);
        const qrHasDate = qrFound.some((f) => f.date);
        const qrHasAmount = qrFound.some((f) => f.amount !== null);

        const texts = [];
        const ocrFound = parse.found();
        for await (const text of ocrPasses(crop)) {
          texts.push(text);
          const got = parse.parseOcr(text);
          ocrFound.date = ocrFound.date || got.date;
          ocrFound.time = ocrFound.time || got.time;
          if (ocrFound.amount === null || (ocrFound.guessed && got.amount !== null && !got.guessed)) {
            ocrFound.amount = got.amount;
            ocrFound.guessed = got.guessed;
          }
          for (const c of [got.amount, ...got.candidates]) if (c !== null && !ocrFound.candidates.includes(c)) ocrFound.candidates.push(c);
          if ((qrHasDate || ocrFound.date) && (qrHasAmount || (ocrFound.amount !== null && !ocrFound.guessed))) break;
        }
        const rec = {
          photo: name, bbox: box, date: null, time: null, amount: null, category: "other", source: "",
          certain: false, warnings: [], text: texts.join("\n"), crop, qr: qrTexts.filter((t) => t.trim()),
        };
        if (!qrFound.length && !parse.looksLikeReceipt(rec.text) && ocrFound.amount === null) {
          // Handwriting, a sticker, a stray mark: little text. A crumpled receipt still has lots of text.
          if ((texts[0].match(/[\p{L}\p{N}_]/gu) || []).length < 150) { crop.delete(); return null; }
        }
        merge(rec, qrFound, ocrFound);
        rec.category = parse.guessCategory(rec.text + "\n" + qrTexts.join("\n"));
        return rec;
  }

  return { findReceipts, cropRegion, readQrs, readQrsHard, uprightTurn, textTurn, turn, deskew, ocrPasses, scanPhoto, grayBmp, quarter };
}

export function merge(rec, qrFound, ocrFound) {
  for (const f of qrFound) {
    // An ambiguous AADE split: let the printed total pick.
    if (ocrFound.amount !== null && f.candidates.includes(ocrFound.amount)) f.amount = ocrFound.amount;
  }
  let bestQr = qrFound.find((f) => f.date && f.amount) || qrFound[0] || null;

  if (bestQr && bestQr.amount !== null) {
    rec.amount = bestQr.amount;
    rec.source = "qr";
    rec.certain = bestQr.date !== null && (!bestQr.candidates.length || ocrFound.amount === bestQr.amount);
    rec.date = bestQr.date || ocrFound.date;
    rec.time = bestQr.time || ocrFound.time;
    if (bestQr.candidates.length && ocrFound.amount !== bestQr.amount) {
      rec.warnings.push(`QR total is ambiguous (${[bestQr.amount, ...bestQr.candidates].map((c) => c.toFixed(2)).join(", ")}): check it`);
    }
  } else {
    rec.amount = ocrFound.amount; rec.date = ocrFound.date; rec.time = ocrFound.time;
    rec.source = rec.amount !== null || rec.date ? "ocr" : "";
    if (rec.source === "ocr") rec.warnings.push("No QR code read: check the amount and date");
    if (ocrFound.guessed && rec.amount !== null) {
      rec.warnings.push(`No total line found (largest € amount seen: ${rec.amount.toFixed(2)})`);
      rec.amount = null;
    }
  }
  if (rec.amount === null) rec.warnings.push("Amount not found");
  if (rec.date === null) rec.warnings.push("Date not found");
}
