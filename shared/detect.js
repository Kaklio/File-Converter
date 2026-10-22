// Shared file-format detection + input validation.
// Used by the Bun server (upload validation) and the browser bundle (UI validation).
// Pure JS, no platform APIs except TextDecoder/Uint8Array.

export const FORMATS = {
  // video
  mp4: { category: "video", label: "MP4", ext: ["mp4"], mime: "video/mp4" },
  webm: { category: "video", label: "WebM", ext: ["webm"], mime: "video/webm" },
  mkv: { category: "video", label: "MKV", ext: ["mkv"], mime: "video/x-matroska" },
  mov: { category: "video", label: "MOV", ext: ["mov", "qt"], mime: "video/quicktime" },
  avi: { category: "video", label: "AVI", ext: ["avi"], mime: "video/x-msvideo" },
  flv: { category: "video", label: "FLV", ext: ["flv"], mime: "video/x-flv" },
  wmv: { category: "video", label: "WMV", ext: ["wmv", "asf"], mime: "video/x-ms-wmv" },
  // audio
  mp3: { category: "audio", label: "MP3", ext: ["mp3"], mime: "audio/mpeg" },
  wav: { category: "audio", label: "WAV", ext: ["wav"], mime: "audio/wav" },
  ogg: { category: "audio", label: "OGG", ext: ["ogg", "oga"], mime: "audio/ogg" },
  opus: { category: "audio", label: "Opus", ext: ["opus"], mime: "audio/opus" },
  flac: { category: "audio", label: "FLAC", ext: ["flac"], mime: "audio/flac" },
  m4a: { category: "audio", label: "M4A", ext: ["m4a", "m4b"], mime: "audio/mp4" },
  aac: { category: "audio", label: "AAC", ext: ["aac"], mime: "audio/aac" },
  // image
  png: { category: "image", label: "PNG", ext: ["png"], mime: "image/png" },
  jpg: { category: "image", label: "JPEG", ext: ["jpg", "jpeg", "jpe"], mime: "image/jpeg" },
  webp: { category: "image", label: "WebP", ext: ["webp"], mime: "image/webp" },
  bmp: { category: "image", label: "BMP", ext: ["bmp", "dib"], mime: "image/bmp" },
  gif: { category: "image", label: "GIF", ext: ["gif"], mime: "image/gif" },
  // document
  pdf: { category: "document", label: "PDF", ext: ["pdf"], mime: "application/pdf" },
  docx: { category: "document", label: "Word (docx)", ext: ["docx"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  doc: { category: "document", label: "Word 97 (doc)", ext: ["doc"], mime: "application/msword", unsupported: true },
  odt: { category: "document", label: "ODT", ext: ["odt"], mime: "application/vnd.oasis.opendocument.text", unsupported: true },
  // text
  html: { category: "text", label: "HTML", ext: ["html", "htm"], mime: "text/html" },
  md: { category: "text", label: "Markdown", ext: ["md", "markdown"], mime: "text/markdown" },
  txt: { category: "text", label: "Plain text", ext: ["txt", "text", "log"], mime: "text/plain" },
  csv: { category: "text", label: "CSV", ext: ["csv"], mime: "text/csv" },
  // archive
  zip: { category: "archive", label: "ZIP", ext: ["zip"], mime: "application/zip" },
  rar: { category: "archive", label: "RAR", ext: ["rar"], mime: "application/vnd.rar", unsupported: true },
  sevenzip: { category: "archive", label: "7z", ext: ["7z"], mime: "application/x-7z-compressed", unsupported: true },
  gz: { category: "archive", label: "GZIP", ext: ["gz", "tgz"], mime: "application/gzip", unsupported: true },
};

export const CATEGORIES = {
  video: "video",
  audio: "audio",
  image: "image",
  document: "document",
  text: "text",
  archive: "archive",
};

// Output formats keyed by source *format* first, then by source *category*.
const FORMAT_OUTPUTS = {
  docx: ["pdf", "html", "md", "txt"],
  pdf: [],
  doc: [],
  odt: [],
  html: ["md", "pdf", "txt"],
  md: ["html", "pdf", "txt"],
  txt: ["pdf"],
  csv: ["pdf"],
  zip: ["pdf"],
  rar: [],
  gz: [],
  sevenzip: [],
};

const CATEGORY_OUTPUTS = {
  video: ["mp4", "webm", "mkv", "mov", "avi", "gif", "mp3", "m4a", "wav", "aac", "ogg", "flac", "opus"],
  audio: ["mp3", "m4a", "wav", "aac", "ogg", "flac", "opus"],
  image: ["png", "jpg", "webp", "bmp", "pdf"],
};

// Outputs handled by the server (ffmpeg). Anything else runs in the browser.
const SERVER_FORMATS = new Set([
  "mp4", "webm", "mkv", "mov", "avi", "gif",
  "mp3", "m4a", "wav", "aac", "ogg", "flac", "opus",
]);

export function outputsFor(format) {
  const fmt = FORMATS[format];
  if (!fmt) return [];
  if (Object.prototype.hasOwnProperty.call(FORMAT_OUTPUTS, format)) return FORMAT_OUTPUTS[format].slice();
  return (CATEGORY_OUTPUTS[fmt.category] || []).slice();
}

export function engineFor(outputFormat) {
  return SERVER_FORMATS.has(outputFormat) ? "server" : "client";
}

export function extToFormat(filename) {
  const i = filename.lastIndexOf(".");
  if (i < 0) return null;
  const ext = filename.slice(i + 1).toLowerCase();
  for (const [fmt, def] of Object.entries(FORMATS)) {
    if (def.ext.includes(ext)) return fmt;
    if (ext === "jpeg" && fmt === "jpg") return "jpg";
    if (ext === "htm" && fmt === "html") return "html";
    if (ext === "markdown" && fmt === "md") return "md";
  }
  return null;
}

export function outputExtension(outputFormat) {
  const fmt = FORMATS[outputFormat];
  return fmt ? fmt.ext[0] : "bin";
}

function ascii(bytes, off, len) {
  let s = "";
  for (let i = 0; i < len && off + i < bytes.length; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

function startsWith(bytes, str, off = 0) {
  if (bytes.length < off + str.length) return false;
  for (let i = 0; i < str.length; i++) if (bytes[off + i] !== str.charCodeAt(i)) return false;
  return true;
}

function includesAscii(bytes, str, limit = 8192) {
  const end = Math.min(bytes.length, limit) - str.length;
  for (let i = 0; i <= end; i++) {
    let hit = true;
    for (let j = 0; j < str.length; j++) {
      if (bytes[i + j] !== str.charCodeAt(j)) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

export function looksLikeText(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) return false;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  } catch {
    return false;
  }
  const bad = (text.match(/\uFFFD/g) || []).length;
  return bad <= Math.max(2, Math.floor(text.length * 0.01));
}

function looksLikeHtml(text) {
  return /<(!doctype\s+html|html|head|body|div|span|p|h[1-6]|meta|link|script|style|table|section|article|nav|ul|ol)\b/i.test(text);
}

// sniff(head, filename) -> { format: <key|null>, text: bool }
export function sniff(head, filename = "") {
  const b = head;
  if (!b || b.length < 4) return { format: null, text: false };

  const textCandidate = looksLikeText(b);
  const extFmt = extToFormat(filename);

  // --- binary magic ---
  if (startsWith(b, "\x89PNG\r\n\x1a\n")) return { format: "png", text: false };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: "jpg", text: false };
  if (startsWith(b, "GIF87a") || startsWith(b, "GIF89a")) return { format: "gif", text: false };
  if (startsWith(b, "BM")) return { format: "bmp", text: false };
  if (startsWith(b, "%PDF")) return { format: "pdf", text: false };

  if (startsWith(b, "RIFF")) {
    if (startsWith(b, "WAVE", 8)) return { format: "wav", text: false };
    if (startsWith(b, "WEBP", 8)) return { format: "webp", text: false };
    if (startsWith(b, "AVI ", 8)) return { format: "avi", text: false };
  }

  if (startsWith(b, "fLaC")) return { format: "flac", text: false };

  if (startsWith(b, "OggS")) {
    if (includesAscii(b, "OpusHead", 2048)) return { format: "opus", text: false };
    return { format: "ogg", text: false };
  }

  if (startsWith(b, "ftyp", 4)) {
    const brand = ascii(b, 8, 4);
    if (brand === "M4A " || brand === "M4B ") return { format: "m4a", text: false };
    if (brand.startsWith("qt")) return { format: "mov", text: false };
    return { format: "mp4", text: false };
  }

  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    if (includesAscii(b, "webm", 256)) return { format: "webm", text: false };
    return { format: "mkv", text: false };
  }

  if (startsWith(b, "FLV")) return { format: "flv", text: false };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { format: "wmv", text: false };

  // MP3 (frame sync, layer != reserved) vs AAC/ADTS (frame sync, layer == 0)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08) {
    const layer = (b[1] >> 1) & 0x03;
    if (layer !== 0) return { format: "mp3", text: false };
    return { format: "aac", text: false };
  }
  if (startsWith(b, "ID3")) return { format: "mp3", text: false };

  if (startsWith(b, "Rar!")) return { format: "rar", text: false };
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return { format: "sevenzip", text: false };
  if (b[0] === 0x1f && b[1] === 0x8b) return { format: "gz", text: false };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return { format: "doc", text: false };

  if (startsWith(b, "PK\x03\x04") || startsWith(b, "PK\x05\x06") || startsWith(b, "PK\x07\x08")) {
    if (includesAscii(b, "word/", 16384)) return { format: "docx", text: false };
    if (includesAscii(b, "opendocument", 1024)) return { format: "odt", text: false };
    return { format: "zip", text: false };
  }

  // --- text formats (no reliable magic) ---
  if (textCandidate) {
    const sample = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096));
    if (extFmt && FORMATS[extFmt] && FORMATS[extFmt].category === "text") return { format: extFmt, text: true };
    if (looksLikeHtml(sample)) return { format: "html", text: true };
    return { format: null, text: true };
  }

  return { format: null, text: false };
}

// validateInput(head, filename, selectedFormat) -> { ok, reason?, detected? }
export function validateInput(head, filename, selectedFormat) {
  const det = sniff(head, filename);
  const fmt = FORMATS[selectedFormat];

  if (!fmt) {
    return { ok: false, detected: det.format, reason: "Unknown input type — pick one from the list" };
  }
  if (fmt.unsupported) {
    return { ok: false, detected: det.format, reason: `${fmt.label} input isn't supported yet` };
  }
  if (fmt.category === "text") {
    if (!det.text) {
      return {
        ok: false,
        detected: det.format,
        reason: det.format
          ? `Content is ${FORMATS[det.format]?.label || det.format}, not ${fmt.label} text`
          : "Content is not readable text",
      };
    }
    return { ok: true, detected: det.format };
  }
  if (det.format === selectedFormat) return { ok: true, detected: det.format };

  return {
    ok: false,
    detected: det.format,
    reason: det.format
      ? `Content looks like ${FORMATS[det.format]?.label || det.format}, not ${fmt.label}`
      : `Content doesn't look like a ${fmt.label} file`,
  };
}
