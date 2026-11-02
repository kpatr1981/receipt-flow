// Receipts across photos: duplicates, months, file names. Port of receiptflow/pipeline.py (pure parts).

export const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Photos larger than this (long side, px) are scaled down on load: keeps phone browsers within memory. */
export const MAX_SIDE = 4200;

export const ddmmyyyy = (iso) => iso.split("-").reverse().join("/");

/** Rows in date order (undated last), as the Python version sorts them. */
export function sortRows(rows) {
  return rows.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.time || "").localeCompare(b.time || ""));
}

function shown(photo) {
  return /^\d\d_/.test(photo) ? photo.slice(3) : photo;
}

function describe(r) {
  const when = r.date ? ddmmyyyy(r.date) : "no date";
  const amount = r.amount !== null && r.amount !== undefined ? `${r.amount.toFixed(2)} €` : "no amount";
  return `the ${when}, ${amount} receipt from ${shown(r.photo)}`;
}

/** Same QR code = same receipt: the later copy starts unused. Same date, time and amount = maybe. */
export function markDuplicates(rows) {
  const byQr = new Map(), byStamp = new Map();
  for (const r of rows) {
    r.skip ??= false;
    const first = (r.qr || []).map((q) => byQr.get(q)).find(Boolean);
    if (first) {
      r.skip = true;
      r.duplicate_of = first.id;
      r.warnings.unshift(`Duplicate: same QR code as ${describe(first)}. Left out; tick Use to keep it.`);
      continue;
    }
    for (const q of r.qr || []) byQr.set(q, r);
    if (r.date && r.time && r.amount !== null && r.amount !== undefined) {
      const stamp = `${r.date}|${r.time}|${r.amount}`;
      if (byStamp.has(stamp)) r.warnings.unshift(`Possible duplicate of ${describe(byStamp.get(stamp))}: same date, time and amount.`);
      else byStamp.set(stamp, r);
    }
  }
  return rows;
}

/** Last word of the name, safe for a file name ("" when there is no name). */
export function surname(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.at(-1).replace(/[^\p{L}\p{N}_]+/gu, "").toLowerCase() : "";
}

/** Usable receipts grouped by month, each month's rows in date/time order. */
export function monthGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.skip || !r.date || r.amount === null || r.amount === undefined || Number.isNaN(r.amount)) continue;
    const key = r.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.keys()].sort().map((key) => {
    const items = groups.get(key).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    const [y, m] = key.split("-").map(Number);
    return { key, year: y, month: m, label: `${MONTHS[m - 1]} ${y}`, rows: items, total: Math.round(items.reduce((t, r) => t + r.amount, 0) * 100) / 100 };
  });
}

export function pdfName(group, name) {
  const s = surname(name);
  return `expenses_${MONTH_ABBR[group.month - 1]}_${group.year}${s ? `_${s}` : ""}.pdf`;
}

export function pdfTitle(group, name) {
  const n = name.trim().split(/\s+/).join(" ").slice(0, 80);
  return n ? `${n}  ·  ${group.label}` : group.label;
}
