import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

export const PAGE = { w: 210, h: 297 }; // mm, A4
const MARGIN_MM = 15;
const PAGE_W_PX = 794; // A4 width at 96dpi
const PAGE_H_PX = 1123;
const MARGIN_PX = Math.round((MARGIN_MM * 96) / 25.4); // 57
const CONTENT_W_PX = PAGE_W_PX - MARGIN_PX * 2; // 680
const CONTENT_H_PX = PAGE_H_PX - MARGIN_PX * 2; // 1009
const CONTENT_W_MM = PAGE.w - MARGIN_MM * 2; // 180
const CONTENT_H_MM = PAGE.h - MARGIN_MM * 2; // 267
const SCALE = 2;

const BASE_CSS = `
* { box-sizing: border-box; }
h1, h2, h3, h4, h5, h6 { margin: 16px 0 8px; line-height: 1.25; font-weight: 700; color: #111111; }
h1 { font-size: 25px; } h2 { font-size: 21px; } h3 { font-size: 17px; } h4 { font-size: 15px; }
p { margin: 0 0 10px; }
ul, ol { margin: 0 0 12px; padding-left: 26px; }
li { margin-bottom: 4px; }
table { border-collapse: collapse; width: 100%; margin: 0 0 14px; }
th, td { border: 1px solid #c9ced9; padding: 6px 9px; font-size: 13.5px; text-align: left; }
th { background: #eef1f6; }
img { max-width: 100%; height: auto; }
pre {
  background: #f3f4f7; border: 1px solid #e2e5ec; border-radius: 6px;
  padding: 11px 13px; font-family: Consolas, Menlo, monospace; font-size: 13px;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word; margin: 0 0 12px;
}
code { font-family: Consolas, Menlo, monospace; font-size: 0.92em; background: #eef0f4; padding: 1px 5px; border-radius: 4px; }
blockquote { border-left: 3px solid #b9c0cf; margin: 0 0 12px; padding: 2px 0 2px 13px; color: #4a5162; }
hr { border: none; border-top: 1px solid #d7dbe4; margin: 18px 0; }
a { color: #2b5fd9; text-decoration: none; }
`;

export function wrapDocument(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Document")}</title><style>${BASE_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<img[^>]*>/gi, "[image]");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|table|ul|ol|figure|figcaption|header|footer)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = new DOMParser().parseFromString(s, "text/html").documentElement.textContent || "";
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim() + "\n";
}

function raf() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function waitForImages(root, timeoutMs = 4000) {
  const imgs = Array.from(root.querySelectorAll("img"));
  const waits = imgs.map(
    (img) =>
      new Promise((res) => {
        if (img.complete) return res();
        img.addEventListener("load", res, { once: true });
        img.addEventListener("error", res, { once: true });
      })
  );
  if (!waits.length) return Promise.resolve();
  return Promise.race([
    Promise.all(waits),
    new Promise((res) => setTimeout(res, timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------
// Images (or a batch of images / zip entries) -> single PDF, one per page.
// ---------------------------------------------------------------------------
export async function imagesToPdf(images, onProgress = () => {}) {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  let hasPage = false;

  for (let i = 0; i < images.length; i++) {
    const bmp = await createImageBitmap(images[i].blob).catch(() => null);
    if (!bmp) throw new Error(`Could not decode image: ${images[i].name || i + 1}`);

    const w = bmp.width;
    const h = bmp.height;
    const MAX = 3500;
    const shrink = Math.min(1, MAX / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * shrink));
    const ch = Math.max(1, Math.round(h * shrink));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(bmp, 0, 0, cw, ch);
    bmp.close?.();

    const scale = Math.min(CONTENT_W_MM / cw, CONTENT_H_MM / ch);
    const drawW = cw * scale;
    const drawH = ch * scale;
    const x = (PAGE.w - drawW) / 2;
    const y = (PAGE.h - drawH) / 2;

    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    if (hasPage) doc.addPage();
    hasPage = true;
    doc.addImage(dataUrl, "JPEG", x, y, drawW, drawH);
    onProgress((i + 1) / images.length);
    await raf();
  }

  return doc.output("blob");
}

// ---------------------------------------------------------------------------
// HTML (mammoth output / marked output / raw page) -> paginated PDF.
// Renders top-level blocks group-by-group so long documents never blow up
// canvas memory, then slices any over-sized block across pages.
// ---------------------------------------------------------------------------
export async function renderHtmlToPdf(bodyHtml, onProgress = () => {}) {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: CONTENT_W_PX + "px",
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    color: "#111111",
    fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    fontSize: "15px",
    lineHeight: "1.5",
    padding: "0",
    margin: "0",
  });
  host.innerHTML = `<style>${BASE_CSS}</style>${bodyHtml}`;
  document.body.appendChild(host);

  host.querySelectorAll("script, iframe, object, embed, video, audio, link, base").forEach((el) => el.remove());

  try {
    await Promise.all([raf(), waitForImages(host)]);
    if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
  } catch {
    /* keep going */
  }

  const children = Array.from(host.children).filter((el) => el.tagName !== "STYLE");
  const measure = (el) => {
    const cs = getComputedStyle(el);
    return el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  };

  const groups = [];
  let cur = [];
  let curH = 0;
  for (const el of children) {
    const h = measure(el);
    if (cur.length && curH + h > CONTENT_H_PX) {
      groups.push(cur);
      cur = [el];
      curH = h;
    } else {
      cur.push(el);
      curH += h;
    }
  }
  if (cur.length) groups.push(cur);
  if (!groups.length) groups.push([]);

  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  let hasPage = false;

  const addCanvasPages = (canvas) => {
    const pageSrcPx = (CONTENT_H_MM / CONTENT_W_MM) * CONTENT_W_PX * SCALE;
    let y = 0;
    while (y < canvas.height) {
      const sliceH = Math.min(pageSrcPx, canvas.height - y);
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = Math.ceil(sliceH);
      const ctx = tmp.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      const hMm = (sliceH / SCALE / CONTENT_W_PX) * CONTENT_W_MM;
      if (hasPage) doc.addPage();
      hasPage = true;
      doc.addImage(tmp.toDataURL("image/jpeg", 0.9), "JPEG", MARGIN_MM, MARGIN_MM, CONTENT_W_MM, hMm);
      y += sliceH;
    }
  };

  try {
    for (let gi = 0; gi < groups.length; gi++) {
      const group = new Set(groups[gi]);
      children.forEach((el) => {
        el.style.display = group.has(el) ? "" : "none";
      });
      await raf();

      let canvas;
      try {
        canvas = await html2canvas(host, {
          scale: SCALE,
          backgroundColor: "#ffffff",
          logging: false,
          useCORS: true,
          windowWidth: PAGE_W_PX,
        });
      } catch (err) {
        throw new Error(
          `PDF rendering failed (${err?.message || err}). The HTML may use unsupported CSS.`
        );
      }
      addCanvasPages(canvas);
      onProgress(((gi + 1) / groups.length) * 0.97);
    }
    onProgress(1);
  } finally {
    host.remove();
  }

  return doc.output("blob");
}

// ---------------------------------------------------------------------------
// Plain text -> selectable-text PDF (raster fallback for non-Latin scripts).
// ---------------------------------------------------------------------------
const NEEDS_RASTER = /[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/;

export async function textToPdf(text, onProgress = () => {}) {
  if (NEEDS_RASTER.test(text)) {
    const pre = `<pre style="font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#111111">${escapeHtml(text)}</pre>`;
    return renderHtmlToPdf(pre, onProgress);
  }

  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);

  const lines = [];
  for (const para of String(text).split("\n")) {
    const wrapped = doc.splitTextToSize(para, CONTENT_W_MM);
    if (Array.isArray(wrapped)) lines.push(...wrapped);
    else lines.push(wrapped);
  }

  let y = MARGIN_MM;
  let drawn = 0;
  for (const line of lines) {
    if (y > PAGE.h - MARGIN_MM) {
      doc.addPage();
      y = MARGIN_MM;
    }
    if (line) doc.text(String(line), MARGIN_MM, y);
    y += 4.9;
    if (++drawn % 60 === 0) {
      onProgress(Math.min(0.96, drawn / Math.max(lines.length, 1)));
      await raf();
    }
  }
  onProgress(1);
  return doc.output("blob");
}
