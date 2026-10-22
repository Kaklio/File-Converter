import mammoth from "mammoth";
import { marked } from "marked";
import TurndownService from "turndown";
import JSZip from "jszip";
import { FORMATS } from "../shared/detect.js";
import { imagesToPdf, renderHtmlToPdf, textToPdf, htmlToText, wrapDocument, escapeHtml } from "./pdf.js";

const IMAGE_ENTRY_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
const CHUNK = 64 * 1024;

function blobFromText(text, mime) {
  return new Blob([text], { type: mime });
}

function titleOf(file) {
  return file.name.replace(/\.[^.]+$/, "") || "Document";
}

async function readText(file) {
  return await file.text();
}

function turndown(html) {
  const svc = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  svc.remove(["script", "style"]);
  return svc.turndown(html);
}

// ---------- image helpers ----------

async function decodeImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`Could not decode "${file.name}" as an image`);
  }
}

// Minimal 24-bit BMP encoder (browsers can read BMP but not write it).
function encodeBmp(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(0, 0, w, h).data;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const dataSize = rowSize * h;
  const buf = new ArrayBuffer(54 + dataSize);
  const view = new DataView(buf);

  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, 54 + dataSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, dataSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  let off = 54;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      const r = a === 255 ? data[i] : Math.round((data[i] * a + 255 * (255 - a)) / 255);
      const g = a === 255 ? data[i + 1] : Math.round((data[i + 1] * a + 255 * (255 - a)) / 255);
      const b = a === 255 ? data[i + 2] : Math.round((data[i + 2] * a + 255 * (255 - a)) / 255);
      view.setUint8(off++, b);
      view.setUint8(off++, g);
      view.setUint8(off++, r);
    }
    const pad = rowSize - w * 3;
    for (let p = 0; p < pad; p++) view.setUint8(off++, 0);
  }
  return new Blob([buf], { type: "image/bmp" });
}

async function imageToBlob(file, outFmt, onProgress) {
  const bmp = await decodeImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (outFmt === "jpg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  onProgress(0.55);

  if (outFmt === "bmp") {
    const out = encodeBmp(canvas);
    onProgress(1);
    return out;
  }

  const mime = outFmt === "jpg" ? "image/jpeg" : outFmt === "webp" ? "image/webp" : "image/png";
  const quality = outFmt === "jpg" ? 0.92 : undefined;
  const out = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image export failed"))), mime, quality);
  });
  onProgress(1);
  return out;
}

// ---------- zip ----------

async function zipToPdf(file, onProgress) {
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error(`"${file.name}" is not a readable ZIP archive`);
  }
  const entries = [];
  zip.forEach((name, entry) => {
    if (!entry.dir && IMAGE_ENTRY_RE.test(name)) entries.push(entry);
  });
  if (!entries.length) {
    const total = Object.keys(zip.files).length;
    throw new Error(
      `ZIP contains no images (${total} file${total === 1 ? "" : "s"} found — only images → PDF is supported for ZIP input)`
    );
  }
  const images = [];
  for (let i = 0; i < entries.length; i++) {
    const blob = await entries[i].async("blob");
    images.push({ name: entries[i].name, blob });
    onProgress(0.1 + (0.5 * (i + 1)) / entries.length);
    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
  }
  return imagesToPdf(images, (p) => onProgress(0.6 + 0.4 * p));
}

// ---------- docx ----------

async function docxToHtml(file) {
  const buf = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  return result.value;
}

async function docxConvert(file, outFmt, onProgress) {
  const title = titleOf(file);
  if (outFmt === "txt") {
    onProgress(0.3);
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    onProgress(1);
    return blobFromText(result.value, "text/plain; charset=utf-8");
  }
  onProgress(0.2);
  const html = await docxToHtml(file);
  onProgress(0.55);
  if (outFmt === "html") {
    return blobFromText(wrapDocument(title, html), "text/html; charset=utf-8");
  }
  if (outFmt === "md") {
    return blobFromText(turndown(html) + "\n", "text/markdown; charset=utf-8");
  }
  if (outFmt === "pdf") {
    return renderHtmlToPdf(html, (p) => onProgress(0.55 + 0.45 * p));
  }
  throw new Error(`Unsupported docx output: ${outFmt}`);
}

// ---------- html ----------

function extractUserHtml(htmlString, title) {
  const parsed = new DOMParser().parseFromString(htmlString, "text/html");
  parsed.querySelectorAll("script, iframe, object, embed, link[rel=stylesheet], base").forEach((el) => el.remove());
  const styles = Array.from(parsed.head?.querySelectorAll("style") || []).map((s) => s.outerHTML).join("");
  const body = parsed.body ? parsed.body.innerHTML : htmlString;
  return styles + body;
}

async function htmlConvert(file, outFmt, onProgress) {
  const raw = await readText(file);
  onProgress(0.25);
  const parsed = new DOMParser().parseFromString(raw, "text/html");
  parsed.querySelectorAll("script, iframe, object, embed").forEach((el) => el.remove());
  const bodyHtml = parsed.body ? parsed.body.innerHTML : raw;
  onProgress(0.5);

  if (outFmt === "md") {
    return blobFromText(turndown(bodyHtml) + "\n", "text/markdown; charset=utf-8");
  }
  if (outFmt === "txt") {
    return blobFromText(htmlToText(raw), "text/plain; charset=utf-8");
  }
  if (outFmt === "pdf") {
    return renderHtmlToPdf(extractUserHtml(raw, titleOf(file)), (p) => onProgress(0.5 + 0.5 * p));
  }
  throw new Error(`Unsupported HTML output: ${outFmt}`);
}

// ---------- markdown ----------

async function mdConvert(file, outFmt, onProgress) {
  const raw = await readText(file);
  onProgress(0.3);
  marked.setOptions({ gfm: true, breaks: false });
  const html = marked.parse(raw);
  onProgress(0.6);

  if (outFmt === "html") {
    return blobFromText(wrapDocument(titleOf(file), html), "text/html; charset=utf-8");
  }
  if (outFmt === "txt") {
    return blobFromText(htmlToText(html), "text/plain; charset=utf-8");
  }
  if (outFmt === "pdf") {
    return renderHtmlToPdf(html, (p) => onProgress(0.6 + 0.4 * p));
  }
  throw new Error(`Unsupported Markdown output: ${outFmt}`);
}

// ---------- plain text / csv ----------

async function textConvert(file, outFmt, onProgress) {
  const raw = await readText(file);
  onProgress(0.3);
  if (outFmt === "pdf") {
    return textToPdf(raw, (p) => onProgress(0.3 + 0.7 * p));
  }
  if (outFmt === "txt") {
    return blobFromText(raw, "text/plain; charset=utf-8");
  }
  throw new Error(`Unsupported text output: ${outFmt}`);
}

// ---------- entry point ----------

export async function convertSingle(file, inputFmt, outputFmt, onProgress = () => {}) {
  const category = FORMATS[inputFmt]?.category;
  onProgress(0.05);

  let blob;
  if (category === "image" && outputFmt === "pdf") {
    blob = await imagesToPdf([{ name: file.name, blob: file }], (p) => onProgress(p));
  } else if (category === "image") {
    blob = await imageToBlob(file, outputFmt, (p) => onProgress(p));
  } else if (inputFmt === "zip") {
    blob = await zipToPdf(file, (p) => onProgress(p));
  } else if (inputFmt === "docx") {
    blob = await docxConvert(file, outputFmt, (p) => onProgress(p));
  } else if (inputFmt === "html") {
    blob = await htmlConvert(file, outputFmt, (p) => onProgress(p));
  } else if (inputFmt === "md") {
    blob = await mdConvert(file, outputFmt, (p) => onProgress(p));
  } else if (inputFmt === "txt" || inputFmt === "csv") {
    blob = await textConvert(file, outputFmt, (p) => onProgress(p));
  } else {
    throw new Error(`No browser converter for ${inputFmt} → ${outputFmt}`);
  }

  onProgress(1);
  return blob;
}

export async function convertImagePdfBatch(items, onProgress = () => {}) {
  const images = [];
  for (let i = 0; i < items.length; i++) {
    images.push({ name: items[i].file.name, blob: items[i].file });
    onProgress((0.3 * (i + 1)) / items.length);
  }
  return imagesToPdf(images, (p) => onProgress(0.3 + 0.7 * p));
}
