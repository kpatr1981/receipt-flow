// Page controller: same three steps as the Python app, but everything happens in the browser.
import { loadEngine, sha256 } from "./engine.js";
import { markDuplicates, monthGroups, pdfName, pdfTitle, sortRows, ddmmyyyy } from "./pipeline.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let files = [];
let receipts = [];
let uprights = new Map(); // photo name -> upright JPEG, for receipts added by hand
let previews = {}; // month key -> {url, pdf, name}
let previewTimer = null;
let manualCount = 0;

// ------------------------------------------------------------------ saving files
// As a claude.ai Artifact the page cannot start downloads itself: the viewer's `downloads` capability
// asks the viewer to confirm each file. Served locally (no window.claude), a plain download link works.
const downloadsReady = window.claude?.use ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);

async function savePdf(p) {
  const downloads = await downloadsReady;
  if (downloads) {
    try {
      await downloads.save({ filename: p.name, data: p.pdf });
      return "saved";
    } catch (e) {
      if (e?.code === "declined") return "declined";
      if (e?.code === "rate_limited") return "busy";
      throw new Error(`Saving ${p.name} is not possible here (${e?.code || e?.message || e}).`);
    }
  }
  if (window.claude) throw new Error("Saving files is not available in this view.");
  const a = Object.assign(document.createElement("a"), { href: p.pdfUrl, download: p.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  return "saved";
}

// ------------------------------------------------------------------ engine
const status = $("#status");
const engineReady = loadEngine((text) => { status.textContent = text; })
  .then((engine) => {
    status.textContent = `Ready. Reading happens on this device (${engine.workers} at a time).`;
    status.className = "status ready";
    return engine;
  })
  .catch((e) => {
    status.textContent = `The reader could not load: ${e.message}. Open this page through a web server (not as a file).`;
    status.className = "status bad";
    throw e;
  });

// ------------------------------------------------------------------ step 1
const drop = $("#drop");
["dragover", "dragenter"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (ev) => addFiles(ev.dataTransfer.files));
$("#files").addEventListener("change", (ev) => addFiles(ev.target.files));

function addFiles(list) {
  for (const f of list) if (f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name)) files.push(f);
  const t = $("#thumbs");
  t.innerHTML = "";
  for (const f of files) {
    const img = document.createElement("img");
    img.title = f.name;
    img.src = URL.createObjectURL(f);
    img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { textContent: f.name }));
    t.appendChild(img);
  }
  $("#read").disabled = !files.length;
}

$("#read").onclick = async () => {
  const busy = $("#busy1");
  $("#read").disabled = true;
  busy.classList.remove("hidden");
  $("#err1").textContent = "";
  $("#dupes").innerHTML = "";
  try {
    busy.textContent = "Waiting for the reader to load…";
    const engine = await engineReady;
    // Identical photo files: read once.
    const seen = new Map(), skipped = [], unique = [];
    for (const f of files) {
      const h = await sha256(f);
      if (seen.has(h)) skipped.push({ photo: f.name, same_as: seen.get(h) });
      else { seen.set(h, f.name); unique.push(f); }
    }
    $("#dupes").innerHTML = skipped.map((x) => `<div>Skipped <b>${esc(x.photo)}</b>: the same file as ${esc(x.same_as)}.</div>`).join("");

    const rows = [];
    uprights = new Map();
    for (const [i, f] of unique.entries()) {
      const name = `${String(i).padStart(2, "0")}_${f.name}`;
      const label = `Photo ${i + 1} of ${unique.length} (${f.name})`;
      busy.textContent = `${label}: finding receipts and reading QR codes…`;
      const { receipts: recs, upright } = await engine.scan(f, name, ({ done, total }) => {
        busy.textContent = `${label}: reading receipt ${Math.min(done + 1, total)} of ${total}…`;
      });
      uprights.set(name, upright);
      for (const r of recs) {
        rows.push({
          id: `r${rows.length + 1}`, photo: name, date: r.date || "", time: r.time || "", amount: r.amount,
          source: r.source, certain: r.certain, warnings: r.warnings, qr: r.qr,
          cropUrl: URL.createObjectURL(r.cropBlob), cropBlob: r.cropBlob,
        });
      }
    }
    sortRows(rows);
    markDuplicates(rows);
    receipts = rows.map((x) => ({ ...x, skip: !!x.skip, verified: !!x.certain && !x.skip }));
    $("#addPhoto").innerHTML = [...uprights.keys()].map((n) => `<option value="${esc(n)}">from ${esc(n.replace(/^\d+_/, ""))}</option>`).join("");
    if (!receipts.length) $("#err1").textContent = "No receipts could be read in these photos: add them by hand below.";
    renderRows();
    $("#s2").classList.remove("hidden");
    refreshPreview();
  } catch (e) {
    console.error(e);
    $("#err1").textContent = `Something went wrong: ${e.message}`;
  } finally {
    $("#read").disabled = false;
    busy.classList.add("hidden");
  }
};

// ------------------------------------------------------------------ step 2
function renderRows() {
  $("#rows").innerHTML = receipts.map((r, i) => `
    <tr data-i="${i}" class="${r.skip ? "off" : ""} ${r.verified && !r.skip ? "ok" : ""}">
      <td><input type="checkbox" data-f="use" ${r.skip ? "" : "checked"} style="width:auto"></td>
      <td><img src="${r.cropUrl}" alt="receipt ${i + 1}" data-zoom></td>
      <td><input type="date" data-f="date" value="${esc(r.date)}" class="${r.date ? "" : "need"}">
          ${r.date ? "" : '<div class="needmsg">Couldn\'t read: type the date</div>'}</td>
      <td><input type="number" step="0.01" min="0" data-f="amount" value="${r.amount ?? ""}" placeholder="0.00" class="${r.amount == null ? "need" : ""}">
          ${r.amount == null ? '<div class="needmsg">Couldn\'t read: type the amount</div>' : ""}</td>
      <td>${r.duplicate_of ? '<span class="badge dup">Duplicate</span> ' : ""}<span class="badge ${r.source || "none"}">${r.source === "qr" ? "QR code" : r.source === "ocr" ? "Text (OCR)" : r.source === "manual" ? "By hand" : "Not read"}</span>
          ${(r.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join("")}</td>
      <td><label class="verify"><input type="checkbox" data-f="verified" ${r.verified ? "checked" : ""}>Verified</label>
          ${r.certain ? '<div class="sure">Exact from QR</div>' : '<div class="needcheck">Please check</div>'}</td>
    </tr>`).join("");
  updateProgress();
}

$("#rows").addEventListener("input", (ev) => {
  const tr = ev.target.closest("tr"), r = receipts[tr.dataset.i], f = ev.target.dataset.f;
  if (f === "use") { r.skip = !ev.target.checked; tr.classList.toggle("off", r.skip); }
  else if (f === "verified") {
    if (ev.target.checked && (!r.date || r.amount == null || Number.isNaN(r.amount))) {
      ev.target.checked = false;
      tr.querySelectorAll("input.need").forEach((x) => x.focus());
      $("#todo").textContent = "Type the missing date and amount before ticking Verified.";
      return;
    }
    r.verified = ev.target.checked;
  } else if (f === "amount") r.amount = ev.target.value === "" ? null : parseFloat(ev.target.value);
  else r[f] = ev.target.value;
  if (f === "date" || f === "amount") {
    const empty = f === "date" ? !r.date : r.amount == null || Number.isNaN(r.amount);
    ev.target.classList.toggle("need", empty);
    const msg = ev.target.parentElement.querySelector(".needmsg");
    if (msg && !empty) msg.remove();
  }
  tr.classList.toggle("ok", !!r.verified && !r.skip);
  updateProgress();
  renderMonths();
  if (f === "verified") return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 500);
});

document.addEventListener("click", (ev) => {
  if (ev.target.matches("[data-zoom]")) { $("#zoom img").src = ev.target.src; $("#zoom").showModal(); }
  else if (ev.target.closest("dialog")) $("#zoom").close();
});

$("#addBtn").onclick = () => {
  const photo = $("#addPhoto").value, blob = uprights.get(photo);
  if (!blob) return;
  manualCount++;
  receipts.push({
    id: `m${manualCount}`, photo, date: "", time: "", amount: null, source: "manual", certain: false,
    warnings: ["Added by hand: the PDF page shows the whole photo for this one"], qr: [],
    cropUrl: URL.createObjectURL(blob), cropBlob: blob, skip: false, verified: false,
  });
  renderRows();
  renderMonths();
  $('#rows tr:last-child input[data-f="date"]').focus();
};

function updateProgress() {
  const use = receipts.filter((r) => !r.skip);
  const missing = use.filter((x) => !x.date || x.amount == null || Number.isNaN(x.amount)).length;
  const unverified = use.filter((x) => !x.verified).length;
  $("#progress").textContent = `${use.length - unverified} of ${use.length} verified.`;
  const ready = !!use.length && !missing && !unverified;
  $("#save").disabled = !ready;
  // Step 3 appears only once step 2 is finished.
  const wasHidden = $("#s3").classList.contains("hidden");
  $("#s3").classList.toggle("hidden", !ready);
  const todo = $("#todo");
  todo.classList.toggle("done", ready);
  if (!use.length) todo.textContent = "No receipts in use: add one by hand, or tick Use on one above.";
  else if (missing) todo.textContent = `${missing} receipt(s) still need a date or amount typed in (or untick Use). Step 3 appears when every receipt is verified.`;
  else if (unverified) todo.textContent = `Tick Verified on ${unverified} more receipt(s). Step 3 appears when every receipt is verified.`;
  else todo.textContent = "All receipts verified: see the months below.";
  if (ready && wasHidden) { renderMonths(); setTimeout(() => $("#s3").scrollIntoView({ behavior: "smooth", block: "start" }), 50); }
}

// ------------------------------------------------------------------ step 3
let name = "";
try { name = localStorage.getItem("rf-name") || ""; } catch (e) { /* private mode */ }
$("#pdfName").value = name;
$("#pdfName").addEventListener("input", () => {
  name = $("#pdfName").value.trim();
  try { localStorage.setItem("rf-name", name); } catch (e) { /* private mode */ }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 600);
});

let dec = ",";
try { dec = localStorage.getItem("rf-dec") || ","; } catch (e) { /* private mode */ }
document.querySelector(`input[name=dec][value="${dec}"]`).checked = true;
document.querySelectorAll("input[name=dec]").forEach((x) => {
  x.onchange = () => { dec = x.value; try { localStorage.setItem("rf-dec", dec); } catch (e) { /* */ } renderMonths(); };
});
const money = (v) => v.toFixed(2).replace(".", dec);

function renderMonths() {
  const groups = monthGroups(receipts);
  $("#months").innerHTML = groups.map((g) => {
    const unv = g.rows.filter((r) => !r.verified).length;
    const pv = previews[g.key];
    return `<div class="month" data-key="${g.key}">
      ${pv ? `<div class="pv"><img src="${pv.url}" alt="PDF page for ${g.label}" data-zoom><button class="ghost dl" data-save="${g.key}">Save ${esc(pv.name)}</button></div>` : "<div></div>"}
      <div>
        <h3>${g.label}</h3>
        <p class="meta">${g.rows.length} receipt${g.rows.length > 1 ? "s" : ""} · total ${money(g.total)} €</p>
        <div class="scroll"><table class="copy">
          <thead><tr><th>No.</th><th>Date</th><th>Amount</th></tr></thead>
          <tbody>${g.rows.map((r, i) => `<tr class="${r.verified ? "" : "unv"}" title="${r.verified ? "" : "Not verified yet"}">
            <td>${i + 1}</td><td>${ddmmyyyy(r.date)}</td><td class="num">${money(r.amount)}</td></tr>`).join("")}</tbody>
        </table></div>
        <div class="copybar">
          <button class="ghost" data-copy="dates" data-key="${g.key}" ${unv ? "disabled" : ""}>Copy dates</button>
          <button class="ghost" data-copy="amounts" data-key="${g.key}" ${unv ? "disabled" : ""}>Copy amounts</button>
          <span class="${unv ? "needcheck" : "copied"}" data-msg="${g.key}">${unv ? `Verify ${unv} more receipt${unv > 1 ? "s" : ""} to copy` : ""}</span>
        </div>
      </div></div>`;
  }).join("") || '<p class="sub">Nothing to show yet: type the dates and amounts above.</p>';
}

async function copyText(text, key, label) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const msg = document.querySelector(`[data-msg="${key}"]`);
  if (msg) { msg.className = "copied"; msg.textContent = `${label} copied: paste them where you need them`; }
}

$("#months").addEventListener("click", async (ev) => {
  const saveKey = ev.target.dataset.save;
  if (saveKey && previews[saveKey]) {
    const msg = document.querySelector(`[data-msg="${saveKey}"]`);
    try {
      const r = await savePdf(previews[saveKey]);
      if (msg) { msg.className = r === "saved" ? "copied" : "needcheck"; msg.textContent = r === "saved" ? `Saved ${previews[saveKey].name}` : r === "busy" ? "A save prompt is already open" : "Not saved"; }
    } catch (e) { $("#err3").textContent = e.message; }
    return;
  }
  const what = ev.target.dataset.copy, key = ev.target.dataset.key;
  if (!what || !key) return;
  const rows = monthGroups(receipts).find((g) => g.key === key).rows;
  // One value per line, in receipt-number order: paste into any column, one cell per receipt.
  const lines = rows.map((r) => (what === "dates" ? ddmmyyyy(r.date) : money(r.amount)));
  copyText(lines.join("\n"), key, what === "dates" ? `${rows.length} dates copied` : `${rows.length} amounts copied`);
});

let previewRun = 0;
async function refreshPreview() {
  renderMonths();
  const run = ++previewRun;
  const engine = await engineReady;
  const next = {};
  for (const g of monthGroups(receipts)) {
    const { pdf, preview } = await engine.monthPdf(g.rows.map((r) => r.cropBlob), pdfTitle(g, name));
    if (run !== previewRun) return; // a newer edit started over
    next[g.key] = { url: URL.createObjectURL(preview), pdfUrl: URL.createObjectURL(pdf), pdf, name: pdfName(g, name) };
  }
  for (const p of Object.values(previews)) { URL.revokeObjectURL(p.url); URL.revokeObjectURL(p.pdfUrl); }
  previews = next;
  renderMonths();
}

$("#save").onclick = async () => {
  $("#save").disabled = true;
  $("#busy3").classList.remove("hidden");
  try {
    clearTimeout(previewTimer);
    await refreshPreview();
    // One file at a time: each one is confirmed (as an Artifact) or downloaded (locally).
    for (const p of Object.values(previews)) {
      const r = await savePdf(p);
      if (r === "busy") break;
      await new Promise((res) => setTimeout(res, 400)); // browsers drop rapid-fire downloads
    }
  } catch (e) {
    $("#err3").textContent = e.message;
  } finally {
    $("#save").disabled = false;
    $("#busy3").classList.add("hidden");
  }
};
