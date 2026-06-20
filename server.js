// YouTube Uploader — Step 3 (v0.08): browser -> R2 (direct) -> background R2 ->
// YouTube, plus AI metadata (title/description/chapters). Metadata can come from
// an uploaded transcript, a logline, OR auto-transcription: ffmpeg pulls the audio
// straight out of the R2 object and OpenAI Whisper turns it into a timed transcript.
// Single-channel personal tool. Refresh token held in memory, seeded from
// YT_REFRESH_TOKEN so authorization survives restarts once set.
//
// v0.08 adds CHUNKED (multipart) upload for big files: files over 50MB are cut
// into ~50MB parts that upload with retry + in-session resume, removing the 5GB
// ceiling. Small files keep the proven single-PUT path. The server orchestrates
// the multipart create/complete (where credentials live) and hands the browser a
// fresh presigned URL per part, so only raw part bytes ever touch R2 directly.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { S3Client, GetObjectCommand, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import ffmpegStatic from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_VERSION = "0.08";
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// --- AI metadata (Anthropic) ---
// One key, one model. Swap METADATA_MODEL to a stronger model (e.g.
// "claude-opus-4-8") if you want max-quality titles; Sonnet is the
// cost/speed default and is plenty for this.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const METADATA_MODEL = "claude-sonnet-4-6";
const aiConfigured = Boolean(ANTHROPIC_API_KEY);

// --- Transcription (OpenAI Whisper) ---
// whisper-1 specifically: it returns timestamped SRT, which the metadata step
// turns into chapters. The newer transcribe models don't return timestamps yet.
// Needs ffmpeg (from ffmpeg-static) to extract audio from the video.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const transcribeConfigured = Boolean(OPENAI_API_KEY && ffmpegStatic);

const BASE_URL = (
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/oauth2callback`;

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

// --- R2 (S3-compatible) ---
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const r2Configured = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET
);

const s3 = r2Configured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      // Newer AWS SDK v3 auto-adds a CRC32 checksum that R2 rejects on
      // presigned browser PUTs (CORS/403). Only checksum when truly required.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
  : null;

let refreshToken = process.env.YT_REFRESH_TOKEN || null;

// In-memory transfer jobs (single-user tool; master lives safely in R2, so a
// lost job just means re-running the transfer — no re-upload).
const jobs = new Map();
// In-memory transcription jobs (same deal — master is in R2, so re-run is cheap).
const transcribeJobs = new Map();

function oauthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function safeName(name) {
  return String(name || "video")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
}

// --- Chunked (multipart) upload sizing ---
// Files over MULTIPART_MIN use multipart; smaller ones keep the single-PUT path.
// S3/R2 rule: every part except the last must be >= 5MB, and there can be at most
// 10,000 parts. 50MB parts means a 5GB film is ~100 parts. For absurdly large
// files we grow the part size so we never exceed the part-count cap.
const MULTIPART_MIN = 50 * 1024 * 1024;   // 50MB: at/above this -> multipart
const BASE_PART_SIZE = 50 * 1024 * 1024;  // 50MB target part
const MAX_PARTS = 9000;                    // headroom under the 10,000 hard cap

function planParts(size) {
  const total = Number(size) || 0;
  let partSize = BASE_PART_SIZE;
  if (Math.ceil(total / partSize) > MAX_PARTS) {
    // Grow part size just enough to fit under MAX_PARTS, rounded up to whole MB.
    const needed = Math.ceil(total / MAX_PARTS);
    partSize = Math.ceil(needed / (1024 * 1024)) * (1024 * 1024);
  }
  const partCount = Math.max(1, Math.ceil(total / partSize));
  return { partSize, partCount };
}

// Background transfer: stream the object from R2 straight into a YouTube
// resumable upload. Bytes never sit on Render disk; memory stays flat.
async function transferToYouTube(jobId, key, title, description) {
  const job = jobs.get(jobId);
  try {
    job.state = "fetching";
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    job.total = Number(obj.ContentLength || 0);

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        job.bytesSent += chunk.length;
        cb(null, chunk);
      },
    });
    obj.Body.pipe(counter);

    job.state = "uploading";
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: refreshToken });
    const youtube = google.youtube({ version: "v3", auth });

    const result = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, categoryId: "1" }, // 1 = Film & Animation
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
      },
      media: { body: counter },
    });

    const v = result.data;
    job.state = "done";
    job.videoId = v.id;
    job.privacyStatus = v.status?.privacyStatus;
    job.uploadStatus = v.status?.uploadStatus;
    job.watchUrl = `https://youtu.be/${v.id}`;
    job.studioUrl = `https://studio.youtube.com/video/${v.id}/edit`;
  } catch (err) {
    const reason = err?.errors?.[0]?.reason;
    const msg = err?.response?.data?.error?.message || err?.message || String(err);
    job.state = "error";
    job.error = reason ? `${reason}: ${msg}` : msg;
  }
}

// Run the bundled ffmpeg with the given args; resolve on exit 0, else reject
// with the tail of stderr so failures are legible.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegStatic) {
      return reject(new Error("ffmpeg binary not available (ffmpeg-static failed to install)."));
    }
    const proc = spawn(ffmpegStatic, args);
    let tail = "";
    proc.stderr.on("data", (d) => {
      tail += d.toString();
      if (tail.length > 6000) tail = tail.slice(-6000);
    });
    proc.on("error", (e) => reject(new Error("Could not start ffmpeg: " + e.message)));
    proc.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const why = signal ? `was killed by ${signal} (usually means out of memory)` : `exited with code ${code}`;
      reject(new Error(`ffmpeg ${why}: ${tail.slice(-400) || "(no output)"}`));
    });
  });
}

// Background transcription: pull the master from R2 to a local temp file in a steady
// stream (constant memory, no matter the file size), extract a tiny mono 16kHz audio
// track from that local file with ffmpeg (a local file is seek-friendly and keeps
// ffmpeg's memory low — streaming straight off the web made ffmpeg OOM-kill on a small
// Render box), then send the audio to OpenAI Whisper. whisper-1 + response_format=srt
// yields timestamped output, so the metadata step can build real chapters from it.
async function runTranscription(jobId, key) {
  const job = transcribeJobs.get(jobId);
  const tmpVideo = path.join(os.tmpdir(), `yt-vid-${jobId}`);
  const tmpAudio = path.join(os.tmpdir(), `yt-aud-${jobId}.mp3`);
  try {
    job.state = "fetching";
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    await pipeline(obj.Body, fs.createWriteStream(tmpVideo));

    job.state = "extracting";
    await runFfmpeg([
      "-hide_banner", "-loglevel", "warning", "-y",
      "-i", tmpVideo,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3",
      tmpAudio,
    ]);

    const stat = await fs.promises.stat(tmpAudio);
    if (stat.size > 24 * 1024 * 1024) {
      throw new Error(
        `Extracted audio is ${(stat.size / 1048576).toFixed(1)}MB, over Whisper's 25MB limit — this film is too long for one-pass transcription (chunking is a future upgrade). Export an SRT from your editor and use that instead.`
      );
    }

    job.state = "transcribing";
    const audioBuf = await fs.promises.readFile(tmpAudio);
    const form = new FormData();
    form.append("file", new Blob([audioBuf], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "srt");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Whisper request failed (HTTP ${r.status}): ${errText.slice(0, 300)}`);
    }
    const transcript = (await r.text()).trim();
    if (!transcript) throw new Error("Whisper returned an empty transcript (near-silent audio?).");

    job.state = "done";
    job.transcript = transcript;
    job.chars = transcript.length;
  } catch (err) {
    job.state = "error";
    job.error = err?.message || String(err);
  } finally {
    fs.promises.unlink(tmpVideo).catch(() => {});
    fs.promises.unlink(tmpAudio).catch(() => {});
  }
}

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    configured: Boolean(CLIENT_ID && CLIENT_SECRET),
    authorized: Boolean(refreshToken),
    r2Configured,
    aiConfigured,
    transcribeConfigured,
    redirectUri: REDIRECT_URI,
  });
});

app.get("/auth", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res
      .status(500)
      .send("Missing CLIENT_ID / CLIENT_SECRET. Set them in Render -> Environment.");
  }
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing authorization code.");
  try {
    const { tokens } = await oauthClient().getToken(code);
    if (tokens.refresh_token) refreshToken = tokens.refresh_token;
    const token = refreshToken
      ? escapeHtml(refreshToken)
      : "(no refresh token returned - revoke this app at myaccount.google.com/permissions and re-authorize)";
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorized</title>
<style>
  :root { --accent:#2f80ff; }
  body { font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#1d1d1f; background:#f5f5f7; margin:0; padding:32px 20px; }
  .card { max-width:640px; margin:0 auto; background:#fff; border-radius:18px; padding:28px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size:22px; margin:0 0 6px; }
  p { color:#444; }
  code { display:block; word-break:break-all; background:#f0f0f3; border-radius:10px; padding:14px; margin:14px 0; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  a.btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; padding:11px 18px; border-radius:11px; font-weight:600; }
  button { font:inherit; border:0; background:#e8e8ed; border-radius:9px; padding:8px 14px; cursor:pointer; }
  .muted { font-size:13px; color:#86868b; }
</style></head>
<body><div class="card">
  <h1>✅ Authorized</h1>
  <p>You can go back and upload now. To make this permanent (so you never click Authorize again):</p>
  <p class="muted">1. Copy the refresh token below. 2. In Render -> your service -> <b>Environment</b>, add <b>YT_REFRESH_TOKEN</b> with this value. 3. Save (Render redeploys). Keep it secret - it grants upload access to your channel.</p>
  <code id="tok">${token}</code>
  <button onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent).then(()=>{this.textContent='Copied'})">Copy token</button>
  &nbsp;<a class="btn" href="/">Back to uploader</a>
</div></body></html>`);
  } catch (err) {
    res.status(500).send("OAuth error: " + escapeHtml(err?.message || String(err)));
  }
});

// Step A: hand the browser a signed URL to upload the master straight to R2.
app.post("/api/presign", async (req, res) => {
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured (set R2_* env vars)." });
  if (!refreshToken) return res.status(401).json({ error: "Not authorized yet - click Authorize first." });
  const { filename, contentType, size } = req.body || {};
  if (!filename) return res.status(400).json({ error: "Missing filename." });

  const ct = contentType || "application/octet-stream";
  const key = `uploads/${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safeName(filename)}`;
  try {
    // Sign host only (no content-type), so there's no header for the browser
    // to mismatch against. Content-type still rides along unsigned -> stored fine.
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: 3600 }
    );
    res.json({ key, url, contentType: ct, size: size || 0 });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --- Chunked upload (multipart), browser-driven ----------------------------
// The browser uploads each part to a presigned URL; the server owns the
// create/complete calls (which need credentials). Same R2 client, so the same
// checksum settings that fixed single-PUT 403s apply to part PUTs too.

// MP-1: start a multipart upload. Returns the key, an uploadId, and the part
// plan (size + count) the browser should slice the file into.
app.post("/api/multipart/create", async (req, res) => {
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured (set R2_* env vars)." });
  if (!refreshToken) return res.status(401).json({ error: "Not authorized yet - click Authorize first." });
  const { filename, contentType, size } = req.body || {};
  if (!filename) return res.status(400).json({ error: "Missing filename." });

  const ct = contentType || "application/octet-stream";
  const key = `uploads/${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safeName(filename)}`;
  const { partSize, partCount } = planParts(size);
  try {
    const out = await s3.send(new CreateMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: ct,
    }));
    res.json({ key, uploadId: out.UploadId, partSize, partCount });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// MP-2: sign one part for upload. Signed fresh per part so a long upload never
// hits URL expiry, and so resuming just signs whatever parts are still missing.
app.post("/api/multipart/sign-part", async (req, res) => {
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured." });
  if (!refreshToken) return res.status(401).json({ error: "Not authorized yet." });
  const { key, uploadId, partNumber } = req.body || {};
  const n = Number(partNumber);
  if (!key || !uploadId || !Number.isInteger(n) || n < 1) {
    return res.status(400).json({ error: "Missing key, uploadId, or partNumber." });
  }
  try {
    const url = await getSignedUrl(
      s3,
      new UploadPartCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId, PartNumber: n }),
      { expiresIn: 3600 }
    );
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// MP-3: finish the upload. The browser sends every part's number + ETag; R2
// stitches them into the final object. Parts must be sorted ascending.
app.post("/api/multipart/complete", async (req, res) => {
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured." });
  if (!refreshToken) return res.status(401).json({ error: "Not authorized yet." });
  const { key, uploadId, parts } = req.body || {};
  if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: "Missing key, uploadId, or parts." });
  }
  const sorted = parts
    .map((p) => ({ PartNumber: Number(p.PartNumber), ETag: String(p.ETag || "") }))
    .filter((p) => Number.isInteger(p.PartNumber) && p.ETag)
    .sort((a, b) => a.PartNumber - b.PartNumber);
  if (sorted.length !== parts.length) {
    return res.status(400).json({ error: "Some parts were missing a number or ETag." });
  }
  try {
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted },
    }));
    res.json({ ok: true, key });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// MP-4: abort an in-progress multipart upload (user cancel / cleanup) so R2
// doesn't keep orphaned parts around.
app.post("/api/multipart/abort", async (req, res) => {
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured." });
  const { key, uploadId } = req.body || {};
  if (!key || !uploadId) return res.status(400).json({ error: "Missing key or uploadId." });
  try {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Step B: kick off the background R2 -> YouTube transfer, return immediately.
app.post("/api/transfer", (req, res) => {
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured." });
  if (!refreshToken) return res.status(401).json({ error: "Not authorized yet." });
  const { key, title, description } = req.body || {};
  if (!key) return res.status(400).json({ error: "Missing key." });

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { state: "starting", key, bytesSent: 0, total: 0, createdAt: Date.now() });
  transferToYouTube(
    jobId,
    key,
    (title || "API upload").slice(0, 100),
    description || "Uploaded via the YouTube Data API."
  );
  res.json({ jobId });
});

// Step C: the browser polls this for transfer progress + result.
app.get("/api/transfer/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json(job);
});

// Step T1: kick off background transcription of an already-uploaded R2 object.
app.post("/api/transcribe", (req, res) => {
  if (!transcribeConfigured) return res.status(500).json({ error: "Transcription not configured (set OPENAI_API_KEY in Render)." });
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured." });
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "Missing key." });

  const jobId = crypto.randomUUID();
  transcribeJobs.set(jobId, { state: "fetching", createdAt: Date.now() });
  runTranscription(jobId, key);
  res.json({ jobId });
});

// Step T2: the browser polls this for transcription progress + the transcript.
app.get("/api/transcribe/:jobId", (req, res) => {
  const job = transcribeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json(job);
});

// AI metadata: turn a transcript (+ optional logline) into a YouTube title,
// description, and — if the transcript carries timestamps — chapter markers.
// Calls Anthropic directly with native fetch (no extra dependency).
app.post("/api/metadata", async (req, res) => {
  if (!aiConfigured) {
    return res.status(500).json({ error: "AI not configured (set ANTHROPIC_API_KEY in Render)." });
  }
  const { transcript, logline, filename } = req.body || {};
  const text = String(transcript || "").slice(0, 120000); // cap input size
  const line = String(logline || "").slice(0, 500);
  if (!text.trim() && !line.trim()) {
    return res.status(400).json({ error: "Need a transcript or a logline to work from." });
  }

  const system = [
    "You write YouTube metadata for an independent filmmaker's FICTIONAL narrative short films (channel: Isaiah Jeremiah).",
    "You receive a transcript of one short film (it may include timestamps if exported as SRT/VTT, or be plain text with none) and possibly a one-line logline.",
    "",
    'Respond with a SINGLE JSON object with exactly two string fields: "title" and "description". No other keys.',
    "",
    "Rules:",
    "- title: a compelling, human title for a narrative short film, under 100 characters. No clickbait, no emoji spam, no SEO keyword stuffing. It should read like a real film title.",
    "- description: 1-3 short paragraphs describing the film in an engaging, spoiler-light way (set premise and tone; do not reveal the ending).",
    '- CHAPTERS: ONLY if the transcript includes timestamps, append a blank line after the paragraphs, then chapter markers one per line in the format "M:SS Label" (use "H:MM:SS Label" for films over an hour). The FIRST chapter MUST be "0:00". Provide at least 3 chapters, each at least 10 seconds after the previous one, anchored to real shifts in the transcript (scene/beat changes). If the transcript has NO timestamps, do not invent chapters — omit them entirely.',
    "- If the transcript is empty or nearly silent (little/no dialogue), rely on the logline. Do not fabricate plot or dialogue that the inputs don't support.",
    "- Output ONLY the JSON object — no markdown code fences, no commentary before or after.",
  ].join("\n");

  const userContent = [
    "Transcript:",
    text.trim() || "(none provided)",
    "",
    "Logline (optional context): " + (line.trim() || "(none provided)"),
    "Filename (optional hint): " + (String(filename || "").trim() || "(none)"),
  ].join("\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: METADATA_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: `AI request failed (HTTP ${r.status}): ${errText.slice(0, 300)}` });
    }

    const data = await r.json();
    const raw = (data.content || [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // Robust extraction: pull the outermost {...} so stray fences/preamble
    // can't break JSON.parse. String slicing only — clipboard-safe, no regex.
    let jsonSlice = raw;
    const open = jsonSlice.indexOf("{");
    const close = jsonSlice.lastIndexOf("}");
    if (open !== -1 && close !== -1 && close > open) {
      jsonSlice = jsonSlice.slice(open, close + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch {
      return res.status(502).json({ error: "AI returned unparseable output.", raw: raw.slice(0, 500) });
    }

    const title = String(parsed.title || "").slice(0, 100);
    const description = String(parsed.description || "").slice(0, 4900); // < YouTube 5000 cap
    if (!title && !description) {
      return res.status(502).json({ error: "AI returned empty metadata." });
    }
    res.json({ title, description });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Diagnostic: write a tiny object to R2 from the server (bypasses the browser
// + CORS entirely). If this succeeds, keys + bucket + permissions are good and
// any upload failure is browser/CORS-side. If it fails, the error names why.
app.get("/api/r2test", async (req, res) => {
  if (!r2Configured) return res.status(500).json({ ok: false, error: "R2 not configured." });
  const key = `uploads/_r2test-${Date.now()}.txt`;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: "r2 write test",
      ContentType: "text/plain",
    }));
    res.json({ ok: true, key, message: "Server-side write to R2 succeeded — keys, bucket, and permissions are good." });
  } catch (err) {
    res.status(500).json({ ok: false, name: err?.name || "", error: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`YouTube uploader v${APP_VERSION} listening on ${BASE_URL}`);
  console.log(`Redirect URI to register in Google Cloud: ${REDIRECT_URI}`);
  console.log(`R2 configured: ${r2Configured}`);
  console.log(`AI metadata configured: ${aiConfigured}`);
  console.log(`Transcription configured: ${transcribeConfigured}`);
});
