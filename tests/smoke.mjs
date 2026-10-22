// Headless-browser smoke test: drives the real UI in Chrome.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE_URL || "http://localhost:3000";
const FIX = process.env.FIXTURES || "C:\\Users\\Aoun\\AppData\\Local\\Temp\\opencode\\fctest";
const OUT = path.join(FIX, "downloads");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const pass = (n) => { results.push(`PASS ${n}`); console.log(`PASS ${n}`); };
const fail = (n, e) => { results.push(`FAIL ${n}: ${e}`); console.log(`FAIL ${n}: ${e}`); };

const magic = (buf, ...bytes) => bytes.every((b, i) => buf[i] === b);
const head = (file) => [...new Uint8Array(fs.readFileSync(file).subarray(0, 8))];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
});

async function reset() {
  if (await page.$("#resultsPanel:not([hidden])").catch(() => null)) {
    await page.click("#convertMoreBtn").catch(() => {});
  } else if (await page.$("#filesPanel:not([hidden])").catch(() => null)) {
    await page.click("#clearBtn").catch(() => {});
  }
  await page.waitForSelector("#filesPanel[hidden]", { timeout: 5000 }).catch(() => {});
}

async function upload(files) {
  await page.setInputFiles("#fileInput", files);
  await page.waitForSelector(".file-row");
}

async function convertAndDownload(timeout = 45000) {
  await page.waitForSelector("#convertBtn:not([disabled])", { timeout: 10000 });
  const dlPromise = page.waitForEvent("download", { timeout });
  await page.click("#convertBtn");
  const dl = await dlPromise;
  const name = dl.suggestedFilename();
  const dest = path.join(OUT, name);
  await dl.saveAs(dest);
  await page.waitForSelector("#resultsPanel:not([hidden])", { timeout: 30000 });
  return { name, dest };
}

try {
  // ---------- 1. page loads ----------
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#dropzone");
  const bundleStatus = await page.evaluate(async () => (await fetch("/dist/app.js")).status);
  if (bundleStatus !== 200) throw new Error(`bundle status ${bundleStatus}`);
  pass("page loads");

  // ---------- 2. image PNG -> JPEG ----------
  await upload(path.join(FIX, "pic.png"));
  const badge1 = (await page.textContent(".type-badge")).trim();
  if (badge1 !== "PNG") throw new Error(`badge=${badge1}`);
  const outOpts = await page.$$eval(".output-select option", (o) => o.map((x) => x.value));
  if (JSON.stringify(outOpts) !== JSON.stringify(["png", "jpg", "webp", "bmp", "pdf"]))
    throw new Error(`outputs=${outOpts}`);
  await page.selectOption(".output-select", "jpg");
  let dl = await convertAndDownload();
  if (dl.name !== "pic.jpg") throw new Error(`name=${dl.name}`);
  if (!magic(head(dl.dest), 0xff, 0xd8, 0xff)) throw new Error("not jpeg bytes");
  pass(`image PNG -> JPEG (${dl.name})`);

  // ---------- 3. input-type validation ----------
  await reset();
  await upload(path.join(FIX, "pic.png"));
  await page.selectOption(".input-select", "mp4");
  await page.waitForSelector(".file-row.invalid", { timeout: 3000 });
  const errText = (await page.textContent(".row-error")).trim();
  if (!/looks like PNG, not MP4/i.test(errText)) throw new Error(`err=${errText}`);
  const disabled = await page.$eval("#convertBtn", (b) => b.disabled);
  if (!disabled) throw new Error("convert should be disabled");
  pass(`validation rejects mismatched input type (${errText})`);

  // ---------- 4. media via server: mp4 -> mp3 ----------
  await reset();
  await upload(path.join(FIX, "sample.mp4"));
  const badge2 = (await page.textContent(".type-badge")).trim();
  if (badge2 !== "MP4") throw new Error(`badge=${badge2}`);
  await page.selectOption(".output-select", "mp3");
  await page.waitForSelector("#progressPanel:not([hidden])", { timeout: 5000 }).catch(() => {});
  dl = await convertAndDownload(60000);
  if (dl.name !== "sample.mp3") throw new Error(`name=${dl.name}`);
  const b = head(dl.dest);
  const isMp3 = magic(b, 0x49, 0x44, 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  if (!isMp3) throw new Error(`not mp3 bytes: ${b.map((x) => x.toString(16))}`);
  pass(`mp4 -> mp3 via server ffmpeg (${dl.name})`);

  // ---------- 5. mixed batch -> ZIP ----------
  await reset();
  await page.setInputFiles("#fileInput", [path.join(FIX, "pic.png"), path.join(FIX, "tone.wav")]);
  await page.waitForSelector(".file-row:nth-child(2)");
  const selects = await page.$$(".output-select");
  await selects[0].selectOption("webp");
  await selects[1].selectOption("ogg");
  dl = await convertAndDownload(60000);
  if (!dl.name.endsWith(".zip")) throw new Error(`name=${dl.name}`);
  if (!magic(head(dl.dest), 0x50, 0x4b)) throw new Error("not a zip");
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(fs.readFileSync(dl.dest));
  const zipNames = Object.keys(zip.files);
  if (zipNames.length !== 2) throw new Error(`zip contents: ${zipNames}`);
  pass(`2 files -> single ZIP (${dl.name}: ${zipNames.join(", ")})`);

  // ---------- 6. html -> md ----------
  await reset();
  await upload(path.join(FIX, "page.html"));
  await page.selectOption(".output-select", "md");
  dl = await convertAndDownload();
  const md = fs.readFileSync(dl.dest, "utf8");
  if (!md.includes("# Report Title") || !md.includes("sample")) throw new Error(`md=${JSON.stringify(md.slice(0, 120))}`);
  pass("html -> markdown");

  // ---------- 7. docx -> pdf ----------
  await reset();
  await upload(path.join(FIX, "sample.docx"));
  const badge3 = (await page.textContent(".type-badge")).trim();
  if (badge3 !== "DOCX") throw new Error(`badge=${badge3}`);
  await page.selectOption(".output-select", "pdf");
  dl = await convertAndDownload(60000);
  if (!magic(head(dl.dest), 0x25, 0x50, 0x44, 0x46)) throw new Error("not a pdf");
  if (fs.statSync(dl.dest).size < 1000) throw new Error("pdf too small");
  pass(`docx -> pdf (${fs.statSync(dl.dest).size} bytes)`);

  // ---------- 8. docx -> md ----------
  await reset();
  await upload(path.join(FIX, "sample.docx"));
  await page.selectOption(".output-select", "md");
  dl = await convertAndDownload();
  const docMd = fs.readFileSync(dl.dest, "utf8");
  if (!docMd.includes("Quarterly Report")) throw new Error(`md=${JSON.stringify(docMd.slice(0, 120))}`);
  pass("docx -> markdown");

  // ---------- 9. zip of images -> pdf ----------
  await reset();
  await upload(path.join(FIX, "images.zip"));
  const badge4 = (await page.textContent(".type-badge")).trim();
  if (badge4 !== "ZIP") throw new Error(`badge=${badge4}`);
  dl = await convertAndDownload(60000);
  if (!magic(head(dl.dest), 0x25, 0x50, 0x44, 0x46)) throw new Error("not a pdf");
  pass(`zip(images) -> pdf (${dl.name})`);

  // ---------- 10. md -> pdf ----------
  fs.writeFileSync(path.join(FIX, "readme.md"), "# Title\n\nSome **bold** text and a list:\n\n- a\n- b\n");
  await reset();
  await upload(path.join(FIX, "readme.md"));
  const badge5 = (await page.textContent(".type-badge")).trim();
  if (badge5 !== "MD") throw new Error(`badge=${badge5}`);
  await page.selectOption(".output-select", "pdf");
  dl = await convertAndDownload(60000);
  if (!magic(head(dl.dest), 0x25, 0x50, 0x44, 0x46)) throw new Error("not a pdf");
  pass("markdown -> pdf");

  // ---------- 11. youtube link -> mp3 ----------
  await reset();
  await page.fill("#urlInput", "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await page.click("#urlBtn");
  await page.waitForSelector(".file-row .type-badge.youtube", { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector(".file-row.pending"), null, { timeout: 30000 });
  const ytName = (await page.textContent(".file-name")).trim();
  if (!/me at the zoo/i.test(ytName)) throw new Error(`title=${ytName}`);
  await page.selectOption(".output-select", "mp3");
  dl = await convertAndDownload(120000);
  if (!/\.mp3$/i.test(dl.name)) throw new Error(`name=${dl.name}`);
  const yb = head(dl.dest);
  const ytMp3 = magic(yb, 0x49, 0x44, 0x33) || (yb[0] === 0xff && (yb[1] & 0xe0) === 0xe0);
  if (!ytMp3) throw new Error(`not mp3 bytes: ${yb.map((x) => x.toString(16))}`);
  if (fs.statSync(dl.dest).size < 10000) throw new Error("mp3 too small");
  pass(`youtube link -> mp3 via yt-dlp+ffmpeg (${dl.name})`);

  // ---------- console/page errors ----------
  if (pageErrors.length) throw new Error(pageErrors.join(" | "));
  pass("no console/page errors");
} catch (e) {
  fail("suite", e?.message || e);
} finally {
  await browser.close();
}

console.log("\n--- summary ---");
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILURE(S)` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
