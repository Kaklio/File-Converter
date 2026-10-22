import ffmpegPath from "ffmpeg-static";

export const MEDIA_TARGETS = {
  mp3: { ext: "mp3", mime: "audio/mpeg", args: ["-vn", "-c:a", "libmp3lame", "-q:a", "2"] },
  wav: { ext: "wav", mime: "audio/wav", args: ["-vn", "-c:a", "pcm_s16le"] },
  m4a: { ext: "m4a", mime: "audio/mp4", args: ["-vn", "-c:a", "aac", "-b:a", "192k"] },
  aac: { ext: "aac", mime: "audio/aac", args: ["-vn", "-c:a", "aac", "-b:a", "192k", "-f", "adts"] },
  ogg: { ext: "ogg", mime: "audio/ogg", args: ["-vn", "-c:a", "libvorbis", "-q:a", "5"] },
  flac: { ext: "flac", mime: "audio/flac", args: ["-vn", "-c:a", "flac"] },
  opus: { ext: "opus", mime: "audio/opus", args: ["-vn", "-c:a", "libopus", "-b:a", "128k"] },
  mp4: { ext: "mp4", mime: "video/mp4", args: ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"] },
  mov: { ext: "mov", mime: "video/quicktime", args: ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"] },
  mkv: { ext: "mkv", mime: "video/x-matroska", args: ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"] },
  avi: { ext: "avi", mime: "video/x-msvideo", args: ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame", "-q:a", "3"] },
  webm: { ext: "webm", mime: "video/webm", args: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "160k"] },
  gif: { ext: "gif", mime: "image/gif", args: ["-an", "-vf", "fps=12,scale=640:-2:flags=lanczos", "-loop", "0", "-f", "gif"] },
};

function toBuffer(stream) {
  return new Response(stream).text();
}

export async function probeDuration(inputPath) {
  const proc = Bun.spawn([ffmpegPath, "-hide_banner", "-i", inputPath], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await toBuffer(proc.stderr);
  await proc.exited;
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(secs) && secs > 0 ? secs : null;
}

export async function forEachLine(stream, onLine) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = carry.indexOf("\n")) >= 0) {
      onLine(carry.slice(0, idx).trim());
      carry = carry.slice(idx + 1);
    }
  }
  if (carry.trim()) onLine(carry.trim());
}

export async function convertMedia({ input, output, target, onProgress }) {
  const def = MEDIA_TARGETS[target];
  if (!def) throw new Error(`Unsupported output format: ${target}`);

  const duration = await probeDuration(input).catch(() => null);
  const totalUs = duration ? duration * 1e6 : null;

  const args = [
    "-y", "-hide_banner", "-i", input,
    ...def.args,
    "-progress", "pipe:1", "-nostats",
    output,
  ];

  const proc = Bun.spawn([ffmpegPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  onProgress?.(0.01);

  let stderrText = "";
  let lastP = 0.01;
  let sawEnd = false;

  const stderrTask = forEachLine(proc.stderr, (line) => {
    if (stderrText.length < 8000) stderrText += line + "\n";
  }).catch(() => {});

  const stdoutTask = forEachLine(proc.stdout, (line) => {
    const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
    if (m && totalUs) {
      const p = Math.min(0.995, Number(m[1]) / totalUs);
      if (p > lastP) {
        lastP = p;
        onProgress?.(p);
      }
    } else if (line === "progress=end") {
      sawEnd = true;
      onProgress?.(1);
    }
  }).catch(() => {});

  const [code] = await Promise.all([proc.exited, stdoutTask, stderrTask]);

  if (code !== 0) {
    const tail = stderrText.split("\n").filter(Boolean).slice(-6).join(" | ");
    throw new Error(`ffmpeg failed (exit ${code})${tail ? `: ${tail}` : ""}`);
  }
  if (!sawEnd) onProgress?.(1);
}
