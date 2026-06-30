import cors from "cors";
import express from "express";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const app = express();
const port = Number(process.env.PORT || 8080);

app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));
app.use(express.json({ limit: "35mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/export", async (req, res) => {
  const project = normalizeProject(req.body || {});
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyj-export-"));
  try {
    const outputPath = await renderProject(project, workDir);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(project.title)}.mp4"`);
    res.sendFile(outputPath);
  } catch (error) {
    console.error(error);
    res.status(500).send(error?.message || "Export failed.");
  } finally {
    setTimeout(() => fs.rm(workDir, { recursive: true, force: true }).catch(() => {}), 5000);
  }
});

function normalizeProject(input) {
  const width = clampInt(input.width, 320, 1280, 640);
  const height = clampInt(input.height, 180, 720, 360);
  const fps = clampInt(input.fps, 8, 24, 12);
  const duration = Math.min(45, Math.max(1, Number(input.duration) || 12));
  const clips = Array.isArray(input.clips) ? input.clips.map((clip, index) => ({
    id: String(clip.id || `clip-${index}`),
    title: String(clip.title || "Clip"),
    kind: clip.kind === "audio" ? "audio" : "visual",
    start: Math.max(0, Number(clip.start) || 0),
    duration: Math.max(.25, Number(clip.duration) || 1),
    src: String(clip.src || ""),
    fileType: String(clip.fileType || ""),
    pattern: String(clip.pattern || ""),
    colors: Array.isArray(clip.colors) ? clip.colors.slice(0, 2) : ["#ff4fa3", "#00d5ff"]
  })).filter((clip) => clip.start < duration) : [];
  return {
    title: String(input.title || "create-your-jam"),
    width,
    height,
    fps,
    duration,
    background: String(input.background || "#f7f3ff"),
    clips
  };
}

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function safeFilename(value) {
  return String(value || "create-your-jam")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64) || "create-your-jam";
}

async function renderProject(project, workDir) {
  const assets = new Map();
  for (const clip of project.clips) {
    if (!clip.src || clip.kind === "audio") continue;
    assets.set(clip.id, await prepareVisualAsset(clip, workDir));
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: project.width, height: project.height }, deviceScaleFactor: 1 });
  const totalFrames = Math.max(1, Math.ceil(project.duration * project.fps));
  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      const time = frame / project.fps;
      const active = project.clips
        .filter((clip) => clip.kind !== "audio" && clip.src && time >= clip.start && time < clip.start + clip.duration)
        .sort((a, b) => b.start - a.start)[0];
      const asset = active ? assets.get(active.id) : null;
      const relative = active ? (time - active.start) % Math.max(.25, active.duration) : 0;
      await page.setContent(frameHtml(project, asset), { waitUntil: "load" });
      if (asset?.type === "svg") {
        await page.evaluate((seconds) => {
          const svg = document.querySelector("svg");
          if (svg && typeof svg.setCurrentTime === "function") svg.setCurrentTime(seconds);
        }, relative);
      }
      if (asset?.type === "video") {
        await page.evaluate((seconds) => new Promise((resolve) => {
          const video = document.querySelector("video");
          if (!video) return resolve();
          const done = () => resolve();
          video.muted = true;
          video.currentTime = Math.max(0, seconds);
          video.addEventListener("seeked", done, { once: true });
          setTimeout(done, 650);
        }), relative);
      }
      await page.screenshot({ path: path.join(workDir, `frame-${String(frame + 1).padStart(6, "0")}.png`) });
    }
  } finally {
    await browser.close();
  }

  const audioPath = await prepareAudio(project, workDir);
  const outputPath = path.join(workDir, "create-your-jam.mp4");
  const args = [
    "-y",
    "-framerate", String(project.fps),
    "-i", path.join(workDir, "frame-%06d.png")
  ];
  if (audioPath) args.push("-i", audioPath);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-vf", "format=yuv420p");
  if (audioPath) args.push("-c:a", "aac", "-b:a", "96k", "-shortest");
  else args.push("-an");
  args.push("-movflags", "+faststart", outputPath);
  await run("ffmpeg", args, workDir);
  return outputPath;
}

function frameHtml(project, asset) {
  const media = asset ? mediaHtml(asset) : "";
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: ${escapeHtml(project.background)}; }
          body {
            display: grid;
            place-items: center;
            background:
              radial-gradient(circle at 20% 18%, rgba(0,213,255,.35), transparent 28%),
              radial-gradient(circle at 82% 24%, rgba(255,79,163,.34), transparent 28%),
              linear-gradient(135deg, #fff56a 0%, #ff8bd2 46%, #72f0ff 100%);
          }
          .stage { width: 100vw; height: 100vh; overflow: hidden; display: grid; place-items: center; }
          img, video, svg { width: 100%; height: 100%; object-fit: cover; display: block; }
        </style>
      </head>
      <body><div class="stage">${media}</div></body>
    </html>`;
}

function mediaHtml(asset) {
  if (asset.type === "svg") return asset.svg;
  const src = `file://${asset.path}`;
  if (asset.type === "video") return `<video src="${src}" muted playsinline></video>`;
  return `<img src="${src}" alt="">`;
}

async function prepareVisualAsset(clip, workDir) {
  if (clip.src.startsWith("data:")) {
    const data = decodeDataUrl(clip.src);
    const type = data.mime.includes("svg") ? "svg" : data.mime.startsWith("video/") ? "video" : "image";
    if (type === "svg") return { type, svg: data.buffer.toString("utf8") };
    const filePath = path.join(workDir, `${clip.id}.${extensionForMime(data.mime)}`);
    await fs.writeFile(filePath, data.buffer);
    return { type, path: filePath };
  }
  if (!/^https?:\/\//i.test(clip.src)) throw new Error(`Unsupported media source for ${clip.title}.`);
  const downloaded = await downloadToFile(clip.src, workDir, clip.id);
  const type = downloaded.mime.includes("svg") ? "svg" : downloaded.mime.startsWith("video/") ? "video" : "image";
  if (type === "svg") return { type, svg: await fs.readFile(downloaded.path, "utf8") };
  return { type, path: downloaded.path };
}

async function prepareAudio(project, workDir) {
  const audio = project.clips.find((clip) => clip.kind === "audio");
  if (!audio) return "";
  const out = path.join(workDir, "audio.wav");
  if (audio.src && !audio.src.startsWith("blob:")) {
    const downloaded = audio.src.startsWith("data:")
      ? await writeDataUrl(audio.src, workDir, "source-audio")
      : await downloadToFile(audio.src, workDir, "source-audio");
    await run("ffmpeg", ["-y", "-i", downloaded.path, "-t", String(project.duration), "-ac", "2", "-ar", "44100", out], workDir);
    return out;
  }
  if (!audio.pattern) return "";
  const base = audio.pattern === "action" ? "92" : "146";
  const top = audio.pattern === "action" ? "220" : "330";
  const fadeStart = Math.max(0, project.duration - 2).toFixed(2);
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `sine=frequency=${base}:duration=${project.duration}`,
    "-f", "lavfi", "-i", `sine=frequency=${top}:duration=${project.duration}`,
    "-filter_complex", `[0:a]volume=0.35[a0];[1:a]volume=0.12[a1];[a0][a1]amix=inputs=2:duration=first,afade=t=out:st=${fadeStart}:d=2`,
    "-ac", "2",
    "-ar", "44100",
    out
  ], workDir);
  return out;
}

function decodeDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) throw new Error("Invalid data URL.");
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const body = match[3] || "";
  const buffer = isBase64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  return { mime, buffer };
}

async function writeDataUrl(dataUrl, workDir, name) {
  const data = decodeDataUrl(dataUrl);
  const filePath = path.join(workDir, `${name}.${extensionForMime(data.mime)}`);
  await fs.writeFile(filePath, data.buffer);
  return { path: filePath, mime: data.mime };
}

async function downloadToFile(url, workDir, name) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}`);
  const mime = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(workDir, `${name}-${crypto.randomBytes(4).toString("hex")}.${extensionForMime(mime, url)}`);
  await fs.writeFile(filePath, buffer);
  return { path: filePath, mime };
}

function extensionForMime(mime, url = "") {
  if (mime.includes("svg")) return "svg";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  const clean = String(url).split("?")[0].split("#")[0];
  const ext = clean.includes(".") ? clean.split(".").pop().toLowerCase() : "";
  return ext && ext.length <= 5 ? ext : "bin";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (match) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[match]));
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed: ${stderr.slice(-2000)}`));
    });
  });
}

app.listen(port, () => {
  console.log(`Create-your-jam exporter listening on ${port}`);
});
