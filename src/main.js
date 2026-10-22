import {
  FORMATS,
  sniff,
  validateInput,
  outputsFor,
  engineFor,
  outputExtension,
  extToFormat,
} from "../shared/detect.js";
import { convertSingle, convertImagePdfBatch } from "./converters.js";
import { makeZip } from "./zip.js";

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  filesPanel: $("filesPanel"),
  fileList: $("fileList"),
  fileCount: $("fileCount"),
  clearBtn: $("clearBtn"),
  convertBtn: $("convertBtn"),
  hint: $("hint"),
  progressPanel: $("progressPanel"),
  progressLabel: $("progressLabel"),
  progressPct: $("progressPct"),
  progressFill: $("progressFill"),
  resultsPanel: $("resultsPanel"),
  resultsList: $("resultsList"),
  downloadAllBtn: $("downloadAllBtn"),
  convertMoreBtn: $("convertMoreBtn"),
  urlInput: $("urlInput"),
  urlBtn: $("urlBtn"),
  toasts: $("toasts"),
};

const state = {
  items: [],
  results: [],
  running: false,
  nextId: 1,
};

const CATEGORY_ORDER = ["video", "audio", "image", "document", "text", "archive"];

// ---------- utils ----------

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function baseName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "youtu.be"]);

function isYouTubeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return YOUTUBE_HOSTS.has(url.hostname.toLowerCase().replace(/^www\./, ""));
}

function fmtDuration(secs) {
  if (!secs) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function toast(message, kind = "error") {
  const el = document.createElement("div");
  el.className = kind === "ok" ? "toast ok" : "toast";
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s ease";
    setTimeout(() => el.remove(), 320);
  }, 6500);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function setProgress(fraction, label) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  els.progressFill.style.width = `${pct}%`;
  els.progressPct.textContent = `${pct}%`;
  if (label != null) els.progressLabel.textContent = label;
}

// ---------- file intake ----------

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    let head = new Uint8Array(0);
    try {
      head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    } catch {
      /* keep empty */
    }
    const det = sniff(head, file.name);
    let inputFmt = det.format || extToFormat(file.name) || "";
    if (!inputFmt && det.text) inputFmt = "txt";
    const outputs = outputsFor(inputFmt);
    state.items.push({
      id: state.nextId++,
      file,
      head,
      detected: det.format,
      inputFmt,
      outputFmt: outputs[0] || "",
      el: null,
    });
  }
  renderAll();
}

async function addYouTubeLink() {
  const url = els.urlInput.value.trim();
  if (!url) return;
  if (!isYouTubeUrl(url)) {
    toast("Only YouTube links are supported");
    return;
  }
  els.urlInput.value = "";

  const item = {
    id: state.nextId++,
    kind: "youtube",
    url,
    title: null,
    duration: null,
    uploader: null,
    pending: true,
    infoError: null,
    head: new Uint8Array(0),
    detected: null,
    inputFmt: "mp4",
    outputFmt: "mp4",
    el: null,
  };
  state.items.push(item);
  renderAll();

  try {
    const res = await fetch("/api/youtube/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Could not fetch video info (HTTP ${res.status})`);
    item.title = data.title || null;
    item.duration = data.duration || null;
    item.uploader = data.uploader || null;
  } catch (err) {
    item.infoError = String(err?.message || err);
  } finally {
    item.pending = false;
    updateRow(item);
    updateActions();
    if (item.infoError) toast(`${item.url}: ${item.infoError}`);
  }
}

// ---------- rendering ----------

function validateItem(item) {
  if (item.kind === "youtube") {
    if (item.pending) return { ok: false, reason: "Fetching video info…" };
    if (item.infoError) return { ok: false, reason: item.infoError };
    if (!item.outputFmt) return { ok: false, reason: "Pick an output format" };
    return { ok: true };
  }
  if (!item.inputFmt) {
    return { ok: false, reason: "Unknown file type — pick the input type manually" };
  }
  return validateInput(item.head, item.file.name, item.inputFmt);
}

function buildInputOptions(selected) {
  const frag = document.createDocumentFragment();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Unknown type…";
  frag.appendChild(placeholder);
  for (const cat of CATEGORY_ORDER) {
    const group = document.createElement("optgroup");
    group.label = cat[0].toUpperCase() + cat.slice(1);
    for (const [key, def] of Object.entries(FORMATS)) {
      if (def.category !== cat) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = def.label + (def.unsupported ? " (unsupported)" : "");
      group.appendChild(opt);
    }
    frag.appendChild(group);
  }
  const select = document.createElement("select");
  select.className = "input-select";
  select.title = "Input type";
  select.appendChild(frag);
  select.value = selected || "";
  return select;
}

function buildOutputOptions(item) {
  const select = document.createElement("select");
  select.className = "output-select";
  select.title = "Convert to";
  const outputs = outputsFor(item.inputFmt);
  if (!outputs.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No conversions";
    select.appendChild(opt);
    select.disabled = true;
    return select;
  }
  for (const key of outputs) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = FORMATS[key].label;
    select.appendChild(opt);
  }
  select.value = outputs.includes(item.outputFmt) ? item.outputFmt : outputs[0];
  item.outputFmt = select.value;
  return select;
}

function updateRow(item) {
  const row = item.el;
  if (!row) return;
  const badge = row.querySelector(".type-badge");
  const sub = row.querySelector(".file-sub");
  const err = row.querySelector(".row-error");

  if (item.kind === "youtube") {
    badge.textContent = "YT";
    badge.className = "type-badge youtube";
    const name = row.querySelector(".file-name");
    if (name) name.textContent = item.title || item.url;
    const bits = [item.duration ? fmtDuration(item.duration) : null, item.uploader, item.pending ? "fetching info…" : null].filter(Boolean);
    sub.textContent = bits.join(" · ") || "YouTube video";
    row.classList.toggle("pending", !!item.pending);
  } else {
    const fmtDef = FORMATS[item.inputFmt];
    badge.textContent = fmtDef ? formatShort(item.inputFmt) : "???";
    badge.className = `type-badge ${fmtDef ? fmtDef.category : ""}`;
    const detLabel = item.detected && item.detected !== item.inputFmt
      ? ` · detected: ${FORMATS[item.detected]?.label || item.detected}`
      : "";
    sub.textContent = `${fmtSize(item.file.size)}${detLabel}`;
  }

  const v = validateItem(item);
  if (!v.ok) {
    row.classList.add("invalid");
    err.textContent = v.reason;
    err.hidden = false;
  } else {
    row.classList.remove("invalid");
    err.hidden = true;
  }
}

function formatShort(key) {
  const SHORT = {
    docx: "DOCX", doc: "DOC", odt: "ODT",
    html: "HTML", md: "MD", txt: "TXT", csv: "CSV",
    zip: "ZIP", rar: "RAR", sevenzip: "7Z", gz: "GZ",
    pdf: "PDF",
  };
  if (SHORT[key]) return SHORT[key];
  return FORMATS[key]?.label || "???";
}

function renderAll() {
  els.fileList.innerHTML = "";
  for (const item of state.items) {
    const row = document.createElement("li");
    row.className = "file-row";
    item.el = row;

    const main = document.createElement("div");
    main.className = "file-main";
    const badge = document.createElement("span");
    badge.className = "type-badge";
    const meta = document.createElement("div");
    meta.className = "file-meta";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = item.kind === "youtube" ? item.title || item.url : item.file.name;
    name.title = item.kind === "youtube" ? item.url : item.file.name;
    const sub = document.createElement("span");
    sub.className = "file-sub";
    meta.append(name, sub);
    main.append(badge, meta);

    const controls = document.createElement("div");
    controls.className = "file-controls";
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    const outputSelect = buildOutputOptions(item);
    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.type = "button";
    remove.title = "Remove";
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      state.items = state.items.filter((x) => x.id !== item.id);
      renderAll();
    });

    if (item.kind === "youtube") {
      const label = document.createElement("span");
      label.className = "input-static";
      label.textContent = "YouTube";
      controls.append(label, arrow, outputSelect, remove);
    } else {
      const inputSelect = buildInputOptions(item.inputFmt);
      inputSelect.addEventListener("change", () => {
        item.inputFmt = inputSelect.value;
        const fresh = buildOutputOptions(item);
        outputSelect.replaceWith(fresh);
        wireOutput(item, fresh);
        updateRow(item);
        updateActions();
      });
      controls.append(inputSelect, arrow, outputSelect, remove);
    }
    wireOutput(item, outputSelect);

    const err = document.createElement("div");
    err.className = "row-error";
    err.hidden = true;

    row.append(main, controls, err);
    els.fileList.appendChild(row);
    updateRow(item);
  }
  updateActions();
}

function wireOutput(item, select) {
  select.addEventListener("change", () => {
    item.outputFmt = select.value;
    updateActions();
  });
}

function updateActions() {
  const count = state.items.length;
  els.filesPanel.hidden = count === 0;
  els.fileCount.textContent = count ? String(count) : "";

  const invalid = state.items.filter((it) => !validateItem(it).ok);
  const ready = count > 0 && invalid.length === 0 && !state.running;
  els.convertBtn.disabled = !ready;
  els.convertBtn.textContent = count > 1 ? `Convert ${count} files` : "Convert";

  if (count === 0) els.hint.textContent = "";
  else if (invalid.length) {
    els.hint.textContent = `${invalid.length} file${invalid.length === 1 ? "" : "s"} need attention`;
  } else {
    const engines = new Set(state.items.map((it) => engineFor(it.outputFmt)));
    els.hint.textContent = engines.has("server") ? "Media files convert on this machine (ffmpeg)" : "Everything runs in your browser";
  }
}

// ---------- conversion ----------

function buildPlan(items) {
  // Batch only real images (they share one combined PDF). ZIP inputs convert
  // individually — converters.js unpacks their image entries.
  const batch = items.filter(
    (it) => it.outputFmt === "pdf" && FORMATS[it.inputFmt]?.category === "image"
  );
  const batchIds = new Set(batch.map((it) => it.id));
  const plan = [];
  if (batch.length) plan.push({ kind: "batch", items: batch });
  for (const it of items) if (!batchIds.has(it.id)) plan.push({ kind: "single", item: it });
  return plan;
}

function jobLabel(job) {
  if (job.kind === "batch") {
    const n = job.items.length;
    const what = job.items[0].inputFmt === "zip" ? "images in ZIP" : "image";
    return `${n} × ${what} → PDF`;
  }
  const it = job.item;
  const target = FORMATS[it.outputFmt]?.label || it.outputFmt;
  if (it.kind === "youtube") return `${it.title || it.url} → ${target}`;
  return `${it.file.name} → ${target}`;
}

function outputNameFor(item) {
  const base = item.kind === "youtube" ? baseName(item.title || "video") : baseName(item.file.name);
  return `${base}.${outputExtension(item.outputFmt)}`;
}

function batchName(items) {
  const bases = new Set(items.map((it) => baseName(it.file.name)));
  const base = bases.size === 1 ? [...bases][0] : "converted";
  return `${base}.pdf`;
}

function runServerJob(item, onProgress, onPhase) {
  const isYT = item.kind === "youtube";
  const span = isYT ? { base: 0, span: 0.97 } : { base: 0.2, span: 0.7 };

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs");
    xhr.onload = () => {
      let res = null;
      try {
        res = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status !== 200 || !res?.id) {
        reject(new Error(res?.error || `Request failed (HTTP ${xhr.status})`));
        return;
      }
      pollJob(res.id, { onProgress, onPhase, ...span }).then(resolve, reject);
    };
    xhr.onerror = () => reject(new Error("Request failed — is the local server running?"));

    if (isYT) {
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify({ url: item.url, format: item.outputFmt }));
    } else {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(0.2 * (e.loaded / e.total));
      };
      const fd = new FormData();
      fd.append("file", item.file, item.file.name);
      fd.append("format", item.outputFmt);
      fd.append("sourceFormat", item.inputFmt);
      xhr.send(fd);
    }
  });
}

async function pollJob(id, { onProgress, onPhase, base, span }) {
  for (;;) {
    await sleep(250);
    let res;
    try {
      res = await fetch(`/api/jobs/${id}`).then((r) => r.json());
    } catch {
      continue;
    }
    if (res.status === "running") {
      if (res.phase && onPhase) onPhase(res.phase === "downloading" ? "Downloading video…" : "Converting…");
      onProgress(base + span * Math.min(1, res.progress || 0));
    } else if (res.status === "done") {
      onProgress(base + span);
      const resp = await fetch(`/api/jobs/${id}/file`);
      if (!resp.ok) throw new Error("Could not download the converted file (job expired?)");
      const blob = await resp.blob();
      onProgress(1);
      return { name: res.filename || null, blob };
    } else if (res.status === "error") {
      throw new Error(res.error || "Conversion failed");
    } else {
      throw new Error("Job not found");
    }
  }
}

async function runJob(job, onProgress, onPhase) {
  if (job.kind === "batch") {
    const blob = await convertImagePdfBatch(job.items, onProgress);
    return [{ name: batchName(job.items), blob }];
  }
  const item = job.item;
  if (engineFor(item.outputFmt) === "server") {
    const out = await runServerJob(item, onProgress, onPhase);
    if (!out.name || typeof out.name !== "string") out.name = outputNameFor(item);
    return [out];
  }
  const blob = await convertSingle(item.file, item.inputFmt, item.outputFmt, (p) => onProgress(0.1 + 0.9 * p));
  return [{ name: outputNameFor(item), blob }];
}

async function startConvert() {
  if (state.running) return;

  const items = state.items;
  let bad = 0;
  for (const it of items) {
    const v = validateItem(it);
    updateRow(it);
    if (!v.ok) bad++;
  }
  if (bad) {
    toast(`Fix ${bad} invalid file${bad === 1 ? "" : "s"} before converting`);
    return;
  }

  const plan = buildPlan(items);
  if (!plan.length) return;

  state.running = true;
  updateActions();
  els.resultsPanel.hidden = true;
  els.progressPanel.hidden = false;
  setProgress(0, "Starting…");

  const outputs = [];
  const errors = [];
  let done = 0;

  for (let i = 0; i < plan.length; i++) {
    const job = plan[i];
    let label = `${i + 1}/${plan.length} — ${jobLabel(job)}`;
    setProgress(i / plan.length, label);
    const onProg = (p) => setProgress((i + Math.min(1, p)) / plan.length, label);
    try {
      const produced = await runJob(job, onProg, (phase) => {
        label = `${i + 1}/${plan.length} — ${phase}`;
        onProg(0);
      });
      outputs.push(...produced);
    } catch (err) {
      errors.push(`${jobLabel(job)}: ${err?.message || err}`);
    }
    done = i + 1;
    setProgress(done / plan.length, label);
  }

  state.running = false;
  updateActions();

  if (!outputs.length) {
    els.progressPanel.hidden = true;
    errors.forEach((e) => toast(e));
    if (!errors.length) toast("Conversion failed");
    return;
  }

  let finalOutputs = outputs;
  if (outputs.length > 1) {
    els.progressFill.style.width = "100%";
    els.progressPct.textContent = "100%";
    els.progressLabel.textContent = `Packaging ${outputs.length} files into a ZIP…`;
    const zipBlob = await makeZip(outputs);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    finalOutputs = [{ name: `converted-${stamp}.zip`, blob: zipBlob, contents: outputs.map((o) => o.name) }];
  }

  state.results = finalOutputs;
  errors.forEach((e) => toast(e));
  showResults();
  setProgress(1, "Done");
  els.progressPanel.hidden = true;
  saveBlob(finalOutputs[0].blob, finalOutputs[0].name);
}

function showResults() {
  els.resultsList.innerHTML = "";
  for (const res of state.results) {
    const li = document.createElement("li");
    li.className = "result-item";
    const info = document.createElement("div");
    info.className = "result-info";
    const name = document.createElement("span");
    name.className = "result-name";
    name.textContent = res.name;
    name.title = res.name;
    const sub = document.createElement("span");
    sub.className = "result-sub";
    sub.textContent = fmtSize(res.blob.size);
    info.append(name, sub);
    if (res.contents) {
      const contents = document.createElement("div");
      contents.className = "result-contents";
      for (const c of res.contents.slice(0, 8)) {
        const chip = document.createElement("span");
        chip.textContent = c;
        contents.appendChild(chip);
      }
      if (res.contents.length > 8) {
        contents.appendChild(document.createTextNode(`+${res.contents.length - 8} more`));
      }
      info.appendChild(contents);
    }
    const dl = document.createElement("button");
    dl.className = "btn ghost";
    dl.type = "button";
    dl.textContent = "Save";
    dl.addEventListener("click", () => saveBlob(res.blob, res.name));
    li.append(info, dl);
    els.resultsList.appendChild(li);
  }
  els.resultsPanel.hidden = false;
}

// ---------- events ----------

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.remove("dragover");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  addFiles(e.dataTransfer?.files);
});

// Prevent the browser from opening files dropped outside the dropzone.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

els.clearBtn.addEventListener("click", () => {
  if (state.running) return;
  state.items = [];
  state.results = [];
  els.resultsPanel.hidden = true;
  renderAll();
});

els.convertMoreBtn.addEventListener("click", () => {
  if (state.running) return;
  state.items = [];
  state.results = [];
  els.resultsPanel.hidden = true;
  els.progressPanel.hidden = true;
  renderAll();
});

els.convertBtn.addEventListener("click", () => {
  startConvert().catch((err) => {
    state.running = false;
    updateActions();
    els.progressPanel.hidden = true;
    toast(String(err?.message || err));
  });
});

els.downloadAllBtn.addEventListener("click", () => {
  if (state.results.length) saveBlob(state.results[0].blob, state.results[0].name);
});

els.urlBtn.addEventListener("click", () => addYouTubeLink());
els.urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addYouTubeLink();
  }
});

renderAll();
