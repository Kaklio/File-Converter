import fs from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { forEachLine } from "./media.js";

const YTDLP = path.resolve(import.meta.dir, "..", "Video Downloader", "yt-dlp.exe");
const FFMPEG_DIR = path.dirname(ffmpegPath);

// Targets that only need the audio stream (much smaller / faster download).
export const YT_AUDIO_TARGETS = new Set(["mp3", "m4a", "wav", "aac", "ogg", "flac", "opus"]);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

export function isYouTubeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return YOUTUBE_HOSTS.has(host);
}

export function ytdlpAvailable() {
  return fs.existsSync(YTDLP);
}

export function safeTitle(title, fallback = "video") {
  const clean = String(title || "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

function cleanError(text) {
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"));
  const last = lines.length ? lines[lines.length - 1] : String(text).trim().split("\n").pop();
  return (last || "yt-dlp failed").replace(/^ERROR:\s*/, "");
}

async function runYtdlp(args, { onLine } = {}) {
  const proc = Bun.spawn([YTDLP, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  let err = "";
  const t1 = forEachLine(proc.stdout, (line) => {
    out += line + "\n";
    onLine?.(line);
  }).catch(() => {});
  const t2 = forEachLine(proc.stderr, (line) => {
    err += line + "\n";
    onLine?.(line);
  }).catch(() => {});
  const [code] = await Promise.all([proc.exited, t1, t2]);
  return { code, out, err };
}

export async function getVideoInfo(url) {
  const { code, out, err } = await runYtdlp([
    "--no-playlist",
    "--skip-download",
    "--js-runtimes", "bun",
    "--print", "%(title)s\t%(duration)s\t%(uploader)s\t%(is_live)s",
    url,
  ]);
  if (code !== 0) throw new Error(cleanError(err || out));

  const line = out
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.includes("\t"));
  if (!line) throw new Error("Could not read video metadata");

  const [title, duration, uploader, isLive] = line.split("\t");
  if (String(isLive).toLowerCase() === "true") throw new Error("Live streams aren't supported");

  return {
    title: safeTitle(title, "video"),
    duration: Number(duration) > 0 ? Number(duration) : null,
    uploader: uploader?.trim() || null,
  };
}

// Downloads into `dir` as source.<ext>. onProgress covers the download phase only.
export async function downloadVideo({ url, dir, target, onProgress }) {
  const audioOnly = YT_AUDIO_TARGETS.has(target);
  const expectedSegments = audioOnly ? 1 : 2;

  let segments = 0;
  let title = null;
  let lastP = 0;

  const { code, out, err } = await runYtdlp(
    [
      "--no-playlist",
      "--newline",
      "--no-simulate",
      "--js-runtimes", "bun",
      "--ffmpeg-location", FFMPEG_DIR,
      "-f", audioOnly ? "ba/b" : "bv*+ba/b",
      "--print", "FC_TITLE:%(title)s",
      "-o", path.join(dir, "source.%(ext)s"),
      url,
    ],
    {
      onLine(line) {
        if (line.startsWith("FC_TITLE:")) {
          title = line.slice("FC_TITLE:".length).trim();
          return;
        }
        if (line.startsWith("[download] Destination:")) {
          segments++;
          return;
        }
        const m = line.match(/^\[download\]\s+([\d.]+)%/);
        if (m) {
          const pct = Number(m[1]) / 100;
          const seg = Math.max(segments, 1);
          const p = Math.min(0.999, (seg - 1 + pct) / expectedSegments);
          if (p > lastP) {
            lastP = p;
            onProgress?.(p);
          }
        } else if (line.includes("[Merger]") || line.includes("has already been downloaded")) {
          onProgress?.(Math.max(lastP, 0.999));
        }
      },
    }
  );

  if (code !== 0) throw new Error(cleanError(err || out));

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("source.") && !f.endsWith(".part") && !f.endsWith(".ytdl"));
  if (!files.length) throw new Error("Downloaded video file was not found");

  // Prefer the final merged file over per-format intermediates (source.f137.mp4).
  const file = files.find((f) => !/\.f\d+\./.test(f)) || files[0];
  return { sourcePath: path.join(dir, file), title: safeTitle(title, "video") };
}
