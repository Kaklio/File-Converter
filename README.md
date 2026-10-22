# Convertly — All-Purposes File Converter

A single-page, local-only file converter. No accounts, no storage — files are converted
on your machine and downloaded straight back.

## Run

```bash
bun install
bun run start        # = build frontend + start server → http://localhost:3000
```

Other scripts:

```bash
bun run build  # bundle the frontend only
bun run serve  # start the server only (requires a build)
bun run test   # headless-browser smoke tests (server must be running)
```

## Supported conversions

| Input | Output | Where it runs |
|---|---|---|
| MP4, WebM, MKV, MOV, AVI, FLV, WMV | any video/audio format below, or GIF | server (ffmpeg) |
| MP3, WAV, OGG, Opus, FLAC, M4A, AAC | MP3, WAV, OGG, Opus, FLAC, M4A, AAC | server (ffmpeg) |
| YouTube link | any video/audio format below | server (yt-dlp + ffmpeg) |
| PNG, JPEG, WebP, BMP, GIF | PNG, JPEG, WebP, BMP, PDF | browser |
| Multiple images (or a ZIP of images) | one combined PDF | browser |
| DOCX | PDF, HTML, Markdown, TXT | browser |
| HTML | Markdown, PDF, TXT | browser |
| Markdown | HTML, PDF, TXT | browser |
| TXT, CSV | PDF | browser |

Uploads are validated against the selected input type using magic-byte sniffing —
renaming `malware.exe` to `video.mp4` is rejected before anything runs.

## How it works

- **Server** (`server/`) — Bun HTTP server. Serves the static UI and `/api/jobs`
  for media conversions via the bundled `ffmpeg-static` binary. Jobs report progress
  as a percentage, live in a temp folder, and expire after 30 minutes.
  YouTube links are downloaded with the bundled `yt-dlp` (`server/youtube.js`) and
  then converted with the same ffmpeg targets.
- **Client** (`src/`, `shared/`) — vanilla JS UI, bundled with `bun build`.
  Documents, images, archives and text convert entirely in the browser
  (mammoth, jsPDF, html2canvas, marked, turndown, JSZip).
- A single result downloads directly; multiple results are zipped automatically.

## Adding a conversion

1. Formats and per-format output lists live in `shared/detect.js` (`FORMATS`, `outputsFor`).
2. Media outputs get an ffmpeg arg table in `server/media.js` (`MEDIA_TARGETS`).
3. Browser outputs get a branch in `src/converters.js`.
