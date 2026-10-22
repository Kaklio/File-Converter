import JSZip from "jszip";

const COMPRESSIBLE = /\.(txt|md|markdown|html?|csv|json|xml|css|js|log|svg|yaml|yml|tsv)$/i;

function uniqueName(name, used) {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  let candidate;
  do {
    candidate = `${base} (${i})${ext}`;
    i++;
  } while (used.has(candidate));
  return candidate;
}

export async function makeZip(entries, onProgress = () => {}) {
  const zip = new JSZip();
  const used = new Set();
  for (const entry of entries) {
    const name = uniqueName(entry.name, used);
    used.add(name);
    zip.file(name, entry.blob, {
      compression: COMPRESSIBLE.test(name) ? "DEFLATE" : "STORE",
      compressionOptions: { level: 6 },
    });
  }
  return zip.generateAsync({ type: "blob" }, (meta) => onProgress(meta.percent / 100));
}
