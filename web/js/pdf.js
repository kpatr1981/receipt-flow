// One month's receipt crops on a single numbered A4 page, written as a one-page PDF.
// Port of receiptflow/pdfpage.py. Layout and PDF writing are pure (tested in Node);
// drawing needs a 2D canvas (browser).

export const DPI = 200;
export const A4 = [Math.round((210 / 25.4) * DPI), Math.round((297 / 25.4) * DPI)]; // portrait px
const MARGIN = 50, GAP = 30, TITLE_H = 70;

/** Best grid: same scale for every crop (keeps real proportions), biggest scale wins. */
export function layout(sizes, page) {
  const pw = page[0] - 2 * MARGIN, ph = page[1] - 2 * MARGIN;
  let best = null;
  for (let cols = 1; cols <= sizes.length; cols++) {
    const rows = [];
    for (let i = 0; i < sizes.length; i += cols) rows.push(sizes.slice(i, i + cols));
    const needW = Math.max(...rows.map((r) => r.reduce((t, [w]) => t + w, 0)));
    const needH = rows.reduce((t, r) => t + Math.max(...r.map(([, h]) => h)), 0);
    const scale = Math.min((pw - GAP * (cols - 1)) / needW, (ph - GAP * (rows.length - 1)) / needH);
    if (!best || scale > best.scale) best = { scale, cols, rows };
  }
  return best;
}

/** Portrait or landscape A4, whichever shows the crops bigger; never upscales. */
export function planPage(sizes) {
  const options = [A4, [A4[1], A4[0]]].map((page) => ({ page, lay: layout(sizes, [page[0], page[1] - TITLE_H]) }));
  const pick = options.reduce((a, b) => (b.lay.scale > a.lay.scale ? b : a));
  const scale = Math.min(pick.lay.scale, 1);
  const placed = [];
  let y = MARGIN + TITLE_H, i = 0;
  for (const row of pick.lay.rows) {
    const rowW = row.reduce((t, [w]) => t + w, 0) * scale + GAP * (row.length - 1);
    let x = (pick.page[0] - rowW) / 2;
    const rowH = Math.max(...row.map(([, h]) => h)) * scale;
    for (const [w, h] of row) {
      placed.push({ index: i++, x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) });
      x += w * scale + GAP;
    }
    y += rowH + GAP;
  }
  return { width: pick.page[0], height: pick.page[1], placed };
}

/**
 * Draw the page. `images` are drawable (ImageBitmap/canvas) with width/height.
 * @param {(w: number, h: number) => HTMLCanvasElement|OffscreenCanvas} makeCanvas
 */
export function drawMonthPage(makeCanvas, images, title) {
  const plan = planPage(images.map((im) => [im.width, im.height]));
  const canvas = makeCanvas(plan.width, plan.height);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, plan.width, plan.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.fillStyle = "#000";
  g.font = "bold 40px Arial, Helvetica, sans-serif";
  g.textBaseline = "top";
  g.fillText(title, MARGIN, MARGIN / 2);
  for (const p of plan.placed) {
    g.drawImage(images[p.index], p.x, p.y, p.w, p.h);
    g.strokeStyle = "#999";
    g.lineWidth = 2;
    g.strokeRect(p.x, p.y, p.w, p.h);
    const r = 38, cx = p.x + r + 6, cy = p.y + r + 6;
    g.fillStyle = "#d00000";
    g.beginPath();
    g.arc(cx, cy, r, 0, 2 * Math.PI);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 48px Arial, Helvetica, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(p.index + 1), cx, cy + 2);
    g.textAlign = "start";
    g.textBaseline = "top";
  }
  return canvas;
}

/** A one-page PDF showing one JPEG at `dpi`. Minimal, valid PDF 1.4. */
export function jpegToPdf(jpeg, widthPx, heightPx, dpi = DPI) {
  const W = ((widthPx * 72) / dpi).toFixed(2), H = ((heightPx * 72) / dpi).toFixed(2);
  const enc = new TextEncoder();
  const content = enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`);
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => { const b = typeof chunk === "string" ? enc.encode(chunk) : chunk; parts.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); for (const b of body) push(b); push("\nendobj\n"); };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
  obj(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`]);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
  obj(5, [`<< /Length ${content.length} >>\nstream\n`, content, "endstream"]);
  const xref = length;
  let table = "xref\n0 6\n0000000000 65535 f \n";
  for (let n = 1; n <= 5; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
