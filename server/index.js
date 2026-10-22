import fs from "node:fs";
import path from "node:path";
import { validateInput, FORMATS } from "../shared/detect.js";
import { MEDIA_TARGETS, convertMedia } from "./media.js";
import { isYouTubeUrl, ytdlpAvailable, getVideoInfo, downloadVideo } from "./youtube.js";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(import.meta.dir, "..", "public");
const TMP_DIR = path.resolve(import.meta.dir, ".tmp");
const JOB_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Targets that make no sense for audio-only sources.
const VIDEO_ONLY_TARGETS = new Set(["mp4", "webm", "mkv", "mov", "avi", "gif"]);

fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function createJob(req) {
  const isJson = (req.headers.get("content-type") || "").includes("application/json");
  if (isJson) return createYouTubeJob(req);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "Invalid form data" });
  }

  const file = form.get("file");
  const target = String(form.get("format") || "");
  const sourceFormat = String(form.get("sourceFormat") || "");

  if (!(file instanceof File)) return json(400, { error: "Missing file" });

  const fmt = FORMATS[sourceFormat];
  if (!fmt || (fmt.category !== "video" && fmt.category !== "audio")) {
    return json(400, { error: "sourceFormat must be a video or audio format" });
  }
  const def = MEDIA_TARGETS[target];
  if (!def) return json(400, { error: `Unsupported output format: ${target}` });
  if (fmt.category === "audio" && VIDEO_ONLY_TARGETS.has(target)) {
    return json(400, { error: `Audio input cannot be converted to ${target.toUpperCase()}` });
  }

  let head;
  try {
    head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  } catch {
    return json(400, { error: "Could not read file" });
  }

  const check = validateInput(head, file.name, sourceFormat);
  if (!check.ok) {
    return json(400, { error: `Input check failed: ${check.reason}` });
  }

  const id = crypto.randomUUID();
  const dir = path.join(TMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const inExt = (path.extname(file.name) || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  const inPath = path.join(dir, `input${inExt || ".bin"}`);
  const outPath = path.join(dir, `output.${def.ext}`);
  await Bun.write(inPath, file);

  const base = path.basename(file.name, path.extname(file.name)) || "converted";
  const job = {
    id,
    status: "running",
    progress: 0,
    createdAt: Date.now(),
    outPath,
    mime: def.mime,
    outName: `${base}.${def.ext}`,
    error: null,
  };
  jobs.set(id, job);

  runJob(job, inPath, target);
  return json(200, { id });
}

async function createYouTubeJob(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const url = String(body?.url || "").trim();
  const target = String(body?.format || "mp4");

  if (!isYouTubeUrl(url)) return json(400, { error: "Only YouTube links are supported" });
  if (!ytdlpAvailable()) return json(500, { error: "yt-dlp binary not found in 'Video Downloader/'" });

  const def = MEDIA_TARGETS[target];
  if (!def) return json(400, { error: `Unsupported output format: ${target}` });

  const id = crypto.randomUUID();
  const dir = path.join(TMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id,
    kind: "youtube",
    phase: "downloading",
    url,
    status: "running",
    progress: 0,
    createdAt: Date.now(),
    outPath: path.join(dir, `output.${def.ext}`),
    mime: def.mime,
    outName: `video.${def.ext}`,
    error: null,
  };
  jobs.set(id, job);

  runYouTubeJob(job, target);
  return json(200, { id });
}

async function runYouTubeJob(job, target) {
  try {
    const dir = path.dirname(job.outPath);
    const { sourcePath, title } = await downloadVideo({
      url: job.url,
      dir,
      target,
      onProgress: (p) => {
        job.phase = "downloading";
        job.progress = 0.45 * p;
      },
    });

    job.phase = "converting";
    job.title = title;
    job.outName = `${title}.${MEDIA_TARGETS[target].ext}`;
    job.progress = 0.45;

    await convertMedia({
      input: sourcePath,
      output: job.outPath,
      target,
      onProgress: (p) => {
        job.progress = 0.45 + 0.55 * p;
      },
    });

    job.progress = 1;
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = String(err?.message || err);
    console.error(`[job ${job.id}] ${job.error}`);
  }
}

async function runJob(job, inPath, target) {
  try {
    await convertMedia({
      input: inPath,
      output: job.outPath,
      target,
      onProgress: (p) => {
        job.progress = p;
      },
    });
    job.progress = 1;
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = String(err?.message || err);
    console.error(`[job ${job.id}] ${job.error}`);
  }
}

function jobStatus(job) {
  if (job.status === "done") {
    return { status: "done", progress: 1, filename: job.outName, title: job.title || null };
  }
  if (job.status === "error") {
    return { status: "error", error: job.error };
  }
  return { status: "running", progress: job.progress, phase: job.phase || null, title: job.title || null };
}

async function serveStatic(pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  if (rel.includes("..") || rel.includes("\0")) return json(403, { error: "forbidden" });
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return json(403, { error: "forbidden" });
  }
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }
  return null;
}

function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "running") continue;
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
      fs.rm(path.join(TMP_DIR, id), { recursive: true, force: true }, () => {});
    }
  }
}
setInterval(cleanup, CLEANUP_INTERVAL_MS).unref?.();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    try {
      if (req.method === "POST" && p === "/api/jobs") return await createJob(req);

      if (req.method === "POST" && p === "/api/youtube/info") {
        let body;
        try {
          body = await req.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }
        const url = String(body?.url || "").trim();
        if (!isYouTubeUrl(url)) return json(400, { error: "Only YouTube links are supported" });
        if (!ytdlpAvailable()) return json(500, { error: "yt-dlp binary not found in 'Video Downloader/'" });
        try {
          return json(200, await getVideoInfo(url));
        } catch (err) {
          return json(422, { error: String(err?.message || err) });
        }
      }

      if (req.method === "GET" && p.startsWith("/api/jobs/")) {
        const parts = p.split("/").filter(Boolean); // ["api","jobs",id,(file)]
        const id = parts[2] || "";
        if (!UUID_RE.test(id)) return json(400, { error: "bad job id" });
        const job = jobs.get(id);
        if (!job) return json(404, { error: "job not found (it may have expired)" });

        if (parts[3] === "file") {
          if (job.status !== "done") return json(409, { error: "job is not finished" });
          const out = Bun.file(job.outPath);
          if (!(await out.exists())) return json(410, { error: "output file expired" });
          return new Response(out, {
            headers: {
              "Content-Type": job.mime,
              "Content-Disposition": contentDisposition(job.outName),
              "Cache-Control": "no-store",
            },
          });
        }
        return json(200, jobStatus(job));
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const res = await serveStatic(p);
        if (res) return res;
      }
      return json(404, { error: "not found" });
    } catch (err) {
      console.error("[server]", err);
      return json(500, { error: String(err?.message || err) });
    }
  },
});

console.log(`All-Purposes File Converter running at http://localhost:${server.port}`);
