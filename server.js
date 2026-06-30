// YouTube Uploader — Step 3 (v0.09): browser -> R2 (direct) -> background R2 ->
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
//
// v0.09 adds CHUNKED transcription for long films. Whisper accepts ~25MB of audio
// per request (~65 min of film at our compressed settings). Films under that still
// transcribe in one shot (unchanged). Longer films: the extracted audio is split
// into ~15-min segments, each transcribed separately, then the SRT pieces are
// stitched back into one transcript with timestamps shifted to their true position
// (exact offsets read from ffmpeg's segment list), so chapters span the whole film.
//
// v0.10 adds a TEMPLATE system backed by Neon Postgres (yt_settings table in the
// shared DB). The user saves a permanent title + description scaffold with {{TOKEN}}
// slots. On each generate, the AI returns title/synopsis/chapters as separate
// pieces; the server fills {{TITLE}}, {{SYNOPSIS}}, {{CHAPTERS}} automatically and
// any other {{NAME}} from saved defaults, then composes the final title +
// description. AI drives everything; the user overrides any field afterward.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { S3Client, GetObjectCommand, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import ffmpegStatic from "ffmpeg-static";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_VERSION = "0.40";
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

// --- AI image enhance (OpenAI GPT Image) ---
// gpt-image-1.5 is the current flagship and handles BOTH generate and edit.
// Swap IMAGE_MODEL (e.g. "gpt-image-2", or "gpt-image-1-mini" for cheaper) in
// Render without a code change. NOTE: GPT Image models require a one-time
// OpenAI organization verification — the same key that does Whisper may still
// need that before image calls work.
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1.5";
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || "medium"; // low | medium | high
const IMAGE_SIZE = "1536x1024"; // landscape, closest to a 16:9 thumbnail
const imageConfigured = Boolean(OPENAI_API_KEY);
// Magic Story Maker bridge: read crew/cast for a project from MSM's export door.
const MSM_BASE_URL = (function () { let u = process.env.MSM_BASE_URL || ""; while (u.endsWith("/")) u = u.slice(0, -1); return u; })();
const MSM_EXPORT_KEY = process.env.MSM_EXPORT_KEY || "";
const msmConfigured = Boolean(MSM_BASE_URL && MSM_EXPORT_KEY);

// ===================== Magic Suite SSO (Phase 3) =====================
// Marquee now lives at marquee.isaiahsmithfilms.com and trusts Magic Story
// Maker as the identity owner. MSM signs an `msm_auth` cookie scoped to the
// parent domain (.isaiahsmithfilms.com) with the shared SESSION_SECRET, so it
// rides along to this subdomain automatically. We verify it with the SAME
// secret and scheme MSM/Reel use; a valid, unexpired, non-guest token means the
// owner is logged in. This is Marquee's first auth gate — before it, anyone with
// the URL could use the app, so this also closes that hole.
//   - SESSION_SECRET unset (e.g. local dev) => gate OFF, no lockout.
//   - /oauth2callback stays public so Google's redirect always lands.
//   - page loads => redirect to MSM login; API calls => 401 JSON.
// (regexes use [+] [/] char-classes, not backslashes, to survive .gitattributes.)
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MSM_AUTH_COOKIE = "msm_auth";
const MSM_LOGIN_URL = (MSM_BASE_URL || "https://app.isaiahsmithfilms.com") + "/login";
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
function b64urlMsm(buf) {
  return Buffer.from(buf).toString("base64").replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
}
function validMsmToken(tok) {
  if (!SESSION_SECRET || !tok || tok.indexOf(".") === -1) return null;
  const parts = tok.split(".");
  const expected = b64urlMsm(crypto.createHmac("sha256", SESSION_SECRET).update(parts[0]).digest());
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return payload.exp > Date.now() ? payload : null;
  } catch (e) {
    return null;
  }
}
// True when a valid MSM session cookie for the OWNER (admin, not a guest) is present.
function msmAuthed(req) {
  const payload = validMsmToken(parseCookies(req)[MSM_AUTH_COOKIE]);
  return !!payload && payload.role !== "guest";
}
// Public paths that must work without a login: Google's OAuth return + status.
function isPublicSuitePath(pth) {
  return pth === "/oauth2callback" || pth === "/api/status" || pth === "/api/client-error";
}
function suiteAuthGate(req, res, next) {
  if (!SESSION_SECRET) return next();              // SSO not configured -> don't lock anyone out
  if (isPublicSuitePath(req.path)) return next();
  if (msmAuthed(req)) return next();
  const wantsHtml = req.method === "GET" && String(req.headers.accept || "").indexOf("text/html") !== -1;
  if (wantsHtml) return res.redirect(MSM_LOGIN_URL);
  return res.status(401).json({ error: "Not signed in. Log in at " + MSM_LOGIN_URL });
}
// ===================================================================

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

// --- Neon Postgres (shared DB; yt_-prefixed tables) ---
// Holds the permanent template + saved field defaults. If DATABASE_URL is unset
// the app still runs — it just uses a built-in default template and the Template
// tab can't save. Neon always uses SSL; local connections don't.
const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const dbConfigured = Boolean(DATABASE_URL);
const isLocalDb = dbConfigured && (DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1"));
const pool = dbConfigured
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocalDb ? undefined : { rejectUnauthorized: false },
    })
  : null;

let refreshToken = process.env.YT_REFRESH_TOKEN || null;

// In-memory transfer jobs (single-user tool; master lives safely in R2, so a
// lost job just means re-running the transfer — no re-upload).
const jobs = new Map();
// In-memory transcription jobs (same deal — master is in R2, so re-run is cheap).
const transcribeJobs = new Map();
// In-memory thumbnail frame-extraction jobs (master in R2, so re-run is cheap).
const thumbJobs = new Map();

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

// --- Template system -------------------------------------------------------
// AUTO_TOKENS fill themselves on each generate. Any other {{NAME}} in a template
// is a "field" whose value comes from saved defaults (and, later, the MSM project).
const AUTO_TOKENS = ["TITLE", "SYNOPSIS", "CHAPTERS"];

const DEFAULT_TITLE_TEMPLATE = "{{TITLE}} | Isaiah Jeremiah";

const DEFAULT_DESCRIPTION_TEMPLATE = [
  "{{SYNOPSIS}}",
  "",
  "***Don't forget to SUBSCRIBE to my channel by clicking here \u279e \u279e https://www.youtube.com/channel/UCa0wyHu46RdbzDRJV88mq8A",
  "",
  "***Make sure you CLICK THE BELL ICON so you can get notifications when my next video goes up so you don't miss anything!",
  "",
  "CONNECT WITH ME",
  "Instagram - instagram.com/isaiahjeremiahsmith",
  "Facebook - facebook.com/isaiahsmith",
  "TikTok - tiktok.com/@isaiahjeremiahsmith",
  "Website - isaiahsmithfilms.com",
  "",
  "",
  "CREW",
  "{{CREW}}",
  "",
  "",
  "CAST",
  "{{CAST}}",
  "",
  "",
  "Chapter Markers",
  "{{CHAPTERS}}",
].join("\n");

// In-memory copy of the saved template so /api/metadata doesn't hit the DB each
// generate. Seeded with the built-in default; replaced by the DB row at startup
// and after every save.
let templateCache = {
  title_template: DEFAULT_TITLE_TEMPLATE,
  description_template: DEFAULT_DESCRIPTION_TEMPLATE,
  defaults: {},
};

// Find unique {{TOKEN}} names in a string (uppercased). String-only, no regex.
function scanTokens(text) {
  const s = String(text || "");
  const out = [];
  let i = 0;
  while (true) {
    const a = s.indexOf("{{", i);
    if (a === -1) break;
    const b = s.indexOf("}}", a + 2);
    if (b === -1) break;
    const name = s.slice(a + 2, b).trim().toUpperCase();
    if (name && out.indexOf(name) === -1) out.push(name);
    i = b + 2;
  }
  return out;
}

// Collapse runs of 3+ blank lines down to 2 (keeps intentional double-blank
// section spacing, only trims gaps an empty token would create), strip trailing
// spaces, trim ends.
function tidyText(text) {
  const trimmed = String(text).split("\n").map((l) => {
    let x = l;
    while (x.endsWith(" ") || x.endsWith("\t")) x = x.slice(0, -1);
    return x;
  });
  const out = [];
  let blankRun = 0;
  for (const l of trimmed) {
    if (l.trim() === "") {
      blankRun++;
      if (blankRun <= 2) out.push("");
    } else {
      blankRun = 0;
      out.push(l);
    }
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

// Replace every {{TOKEN}} with values[TOKEN] (missing -> ""), then tidy. No regex.
function applyTemplate(str, values) {
  const s = String(str || "");
  let out = "";
  let i = 0;
  while (true) {
    const a = s.indexOf("{{", i);
    if (a === -1) { out += s.slice(i); break; }
    const b = s.indexOf("}}", a + 2);
    if (b === -1) { out += s.slice(i); break; }
    out += s.slice(i, a);
    const name = s.slice(a + 2, b).trim().toUpperCase();
    out += Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? "") : "";
    i = b + 2;
  }
  return tidyText(out);
}

// Recover one string field from possibly-broken JSON (e.g. a reply cut off
// mid-way). Scans for "key": "..." and reads the value, unescaping as it goes;
// if the closing quote is missing (truncated), returns what was read. String
// scanning only — no regex, clipboard-safe.
function salvageField(raw, key) {
  const marker = '"' + key + '"';
  let i = raw.indexOf(marker);
  if (i === -1) return "";
  i = raw.indexOf(":", i + marker.length);
  if (i === -1) return "";
  i++;
  while (i < raw.length && (raw[i] === " " || raw[i] === "\t" || raw[i] === "\n" || raw[i] === "\r")) i++;
  if (raw[i] !== '"') return "";
  i++;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      const n = raw[i + 1];
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === '"') out += '"';
      else if (n === "\\") out += "\\";
      else if (n === "/") out += "/";
      else out += n || "";
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  return out.trim();
}

// Build final title + description from the AI's pieces and the saved template.
// Optional castText/crewText fill the {{CAST}}/{{CREW}} slots (from an MSM
// project); when omitted they fall back to the template defaults (blank).
function composeMetadata({ aiTitle, synopsis, chapters, castText, crewText }) {
  const tpl = templateCache;
  const titleTpl = tpl.title_template || "{{TITLE}}";
  const descTpl = tpl.description_template || "{{SYNOPSIS}}\n\n{{CHAPTERS}}";

  const values = Object.assign({}, tpl.defaults || {});
  values.SYNOPSIS = String(synopsis || "");
  values.CHAPTERS = String(chapters || "");
  if (castText != null) values.CAST = String(castText);
  if (crewText != null) values.CREW = String(crewText);

  // Reserve room so the composed title (with suffix) stays under YouTube's 100.
  const reserve = applyTemplate(titleTpl, Object.assign({}, values, { TITLE: "" })).length;
  const titleCap = Math.max(10, 100 - reserve);
  values.TITLE = String(aiTitle || "").slice(0, titleCap);

  const title = applyTemplate(titleTpl, values).slice(0, 100);
  const description = applyTemplate(descTpl, values).slice(0, 4900);
  return { title, description };
}

// Create the table, seed the default row once, and load the cache.
async function initDb() {
  if (!dbConfigured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yt_settings (
      id INTEGER PRIMARY KEY,
      title_template TEXT NOT NULL,
      description_template TEXT NOT NULL,
      defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT yt_settings_singleton CHECK (id = 1)
    )
  `);
  await pool.query(
    `INSERT INTO yt_settings (id, title_template, description_template, defaults)
     VALUES (1, $1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_TITLE_TEMPLATE, DEFAULT_DESCRIPTION_TEMPLATE]
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yt_logos (
      id BIGSERIAL PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'me',
      name TEXT NOT NULL DEFAULT 'Logo',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      img_key TEXT,
      img_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yt_thumbs (
      id BIGSERIAL PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'me',
      name TEXT NOT NULL DEFAULT 'Thumbnail',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      photo_key TEXT,
      photo_type TEXT,
      logo_key TEXT,
      logo_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await refreshTemplateCache();
}

async function refreshTemplateCache() {
  if (!dbConfigured) return;
  const { rows } = await pool.query(
    `SELECT title_template, description_template, defaults FROM yt_settings WHERE id = 1`
  );
  if (rows[0]) {
    templateCache = {
      title_template: rows[0].title_template || DEFAULT_TITLE_TEMPLATE,
      description_template: rows[0].description_template || DEFAULT_DESCRIPTION_TEMPLATE,
      defaults: rows[0].defaults || {},
    };
  }
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

// --- Chunked transcription sizing ---
// Whisper accepts ~25MB per request; we gate at 24MB for headroom. Audio over
// that gets split into CHUNK_SECONDS segments. At mono/16kHz/48kbps, 15 minutes
// is ~5MB — far under the cap, with few seams.
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
const CHUNK_SECONDS = 900; // 15 minutes per segment

// Send one audio file to Whisper, return its SRT (timestamped) transcript.
// Retry a transient/flaky step (dropped connection, timeout, 5xx, rate limit)
// a few times with backoff. Genuine client errors (HTTP 4xx other than 429) are
// NOT retried. This keeps a momentary blip during the R2 download or a Whisper
// request from failing the whole transcription.
function isRetryable(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.indexOf("http 4") !== -1 && m.indexOf("http 429") === -1) return false; // real client error
  return true; // connection drops, timeouts, aborts, 5xx, 429, etc.
}
async function withRetry(label, fn, attempts) {
  attempts = attempts || 3;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!isRetryable(e && e.message) || i === attempts) throw e;
      console.warn(`[transcribe] ${label} attempt ${i} failed (${(e && e.message) || e}); retrying...`);
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr;
}

// Reused by both the one-shot path and each chunk of the long-film path.
async function whisperSrt(filePath) {
  const audioBuf = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([audioBuf], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "srt");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000); // fail fast on a stalled request so withRetry can re-try
  try {
    const r = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Whisper request failed (HTTP ${r.status}): ${errText.slice(0, 300)}`);
    }
    return (await r.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

// --- SRT timestamp helpers (pure, string-based, no regex) ---
// Parse "HH:MM:SS,mmm" -> milliseconds. Tolerates "." for "," and trailing junk
// after the timestamp (parseInt stops at the first non-digit).
function srtTimeToMs(t) {
  const s = String(t).trim();
  const parts = (s.indexOf(",") !== -1 ? s.split(",") : s.split("."));
  const hms = (parts[0] || "").split(":");
  const h = parseInt(hms[0] || "0", 10) || 0;
  const m = parseInt(hms[1] || "0", 10) || 0;
  const sec = parseInt(hms[2] || "0", 10) || 0;
  const ms = parseInt(parts[1] || "0", 10) || 0;
  return (h * 3600 + m * 60 + sec) * 1000 + ms;
}

// Milliseconds -> "HH:MM:SS,mmm".
function msToSrtTime(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const msPart = ms % 1000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return `${p2(h)}:${p2(m)}:${p2(sec)},${p3(msPart)}`;
}

// Shift every cue in an SRT block by offsetSec and renumber cues from startIndex.
// Returns the rewritten block plus the next free index. A near-silent chunk that
// Whisper returns empty for yields "" and leaves the index untouched.
function shiftSrt(srt, offsetSec, startIndex) {
  const norm = String(srt).split("\r\n").join("\n").split("\r").join("\n").trim();
  if (!norm) return { text: "", nextIndex: startIndex };
  const blocks = norm.split("\n\n");
  const offMs = Math.round(offsetSec * 1000);
  const out = [];
  let idx = startIndex;
  for (const block of blocks) {
    const lines = block.split("\n");
    let tIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("-->") !== -1) { tIdx = i; break; }
    }
    if (tIdx === -1) continue; // not a real cue, skip
    const timeLine = lines[tIdx];
    const arrow = timeLine.indexOf("-->");
    const startStr = timeLine.slice(0, arrow).trim();
    const endStr = timeLine.slice(arrow + 3).trim();
    const newStart = msToSrtTime(srtTimeToMs(startStr) + offMs);
    const newEnd = msToSrtTime(srtTimeToMs(endStr) + offMs);
    const textLines = lines.slice(tIdx + 1);
    out.push(`${idx}\n${newStart} --> ${newEnd}\n${textLines.join("\n")}`.trimEnd());
    idx++;
  }
  return { text: out.join("\n\n"), nextIndex: idx };
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
  const segDir = path.join(os.tmpdir(), `yt-seg-${jobId}`);
  try {
    job.state = "fetching";
    await withRetry("R2 download", async () => {
      const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      await pipeline(obj.Body, fs.createWriteStream(tmpVideo));
    });

    job.state = "extracting";
    await runFfmpeg([
      "-hide_banner", "-loglevel", "warning", "-y",
      "-i", tmpVideo,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3",
      tmpAudio,
    ]);
    // Video isn't needed past audio extraction — free the disk now. The finally
    // unlink stays as a backstop.
    await fs.promises.unlink(tmpVideo).catch(() => {});

    const stat = await fs.promises.stat(tmpAudio);
    let transcript;

    if (stat.size <= WHISPER_MAX_BYTES) {
      // Short enough for one request — the original, proven path.
      job.state = "transcribing";
      transcript = await withRetry("Whisper", () => whisperSrt(tmpAudio));
      if (!transcript) throw new Error("Whisper returned an empty transcript (near-silent audio?).");
    } else {
      // Too long for one request — split the audio into time segments, transcribe
      // each, then stitch the SRTs using each segment's true start offset.
      job.state = "segmenting";
      await fs.promises.mkdir(segDir, { recursive: true });
      const listPath = path.join(segDir, "segments.csv");
      await runFfmpeg([
        "-hide_banner", "-loglevel", "warning", "-y",
        "-i", tmpAudio,
        "-f", "segment",
        "-segment_time", String(CHUNK_SECONDS),
        "-reset_timestamps", "1",
        "-segment_list", listPath,
        "-segment_list_type", "csv",
        "-c", "copy",
        path.join(segDir, "chunk-%03d.mp3"),
      ]);

      // Ordered segment files; exact start offsets come from the CSV rows
      // (filename,start,end). Fall back to index*CHUNK_SECONDS if the CSV is
      // missing or a row can't be parsed.
      const dirFiles = (await fs.promises.readdir(segDir))
        .filter((f) => f.startsWith("chunk-") && f.endsWith(".mp3"))
        .sort();
      if (dirFiles.length === 0) throw new Error("Audio split produced no segments.");

      const startByName = {};
      try {
        const csv = await fs.promises.readFile(listPath, "utf8");
        for (const lineRaw of csv.split("\n")) {
          const line = lineRaw.trim();
          if (!line) continue;
          const cols = line.split(",");
          const name = (cols[0] || "").trim();
          const start = parseFloat(cols[1]);
          if (name) startByName[name] = Number.isFinite(start) ? start : undefined;
        }
      } catch { /* fall back to index spacing below */ }

      job.state = "transcribing";
      job.chunkTotal = dirFiles.length;
      const pieces = [];
      let nextIndex = 1;
      for (let k = 0; k < dirFiles.length; k++) {
        job.chunkIndex = k + 1;
        const name = dirFiles[k];
        const offsetSec = Number.isFinite(startByName[name]) ? startByName[name] : k * CHUNK_SECONDS;
        const srt = await withRetry("Whisper", () => whisperSrt(path.join(segDir, name)));
        const shifted = shiftSrt(srt, offsetSec, nextIndex);
        if (shifted.text) {
          pieces.push(shifted.text);
          nextIndex = shifted.nextIndex;
        }
      }
      transcript = pieces.join("\n\n").trim();
      if (!transcript) throw new Error("Whisper returned empty transcripts for every segment (near-silent film?).");
    }

    job.state = "done";
    job.transcript = transcript;
    job.chars = transcript.length;
  } catch (err) {
    job.state = "error";
    job.error = err?.message || String(err);
  } finally {
    fs.promises.unlink(tmpVideo).catch(() => {});
    fs.promises.unlink(tmpAudio).catch(() => {});
    fs.promises.rm(segDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Scrape the video's duration (seconds) from ffmpeg's "Duration:" banner. Returns
// 0 if it can't be read (callers fall back to fixed early offsets).
function ffmpegProbeDuration(file) {
  return new Promise((resolve) => {
    if (!ffmpegStatic) return resolve(0);
    const proc = spawn(ffmpegStatic, ["-hide_banner", "-i", file]);
    let err = "";
    proc.stderr.on("data", (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    proc.on("error", () => resolve(0));
    proc.on("close", () => {
      const i = err.indexOf("Duration:");
      if (i === -1) return resolve(0);
      const t = err.slice(i + 9, i + 30).split(",")[0].trim(); // "HH:MM:SS.ms"
      const p = t.split(":");
      if (p.length < 3) return resolve(0);
      const h = parseFloat(p[0]) || 0, m = parseFloat(p[1]) || 0, s = parseFloat(p[2]) || 0;
      resolve(h * 3600 + m * 60 + s);
    });
  });
}

// Background: pull the master from R2, then grab evenly-spaced candidate frames
// (each fit within 1280x720, preserving aspect so portraits keep their shape) as base64 JPEGs. One bad
// timestamp is skipped rather than failing the whole job.
async function runFrameExtraction(jobId, key, round) {
  const job = thumbJobs.get(jobId);
  const tmpVideo = path.join(os.tmpdir(), `yt-thumbvid-${jobId}`);
  const framePaths = [];
  const frames = [];
  try {
    job.state = "fetching";
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    await pipeline(obj.Body, fs.createWriteStream(tmpVideo));

    job.state = "extracting";
    const dur = await ffmpegProbeDuration(tmpVideo);
    // 15 candidate frames evenly spread across the film (skipping the very
    // start/end). More choices to pick the best thumbnail moment from.
    const FRAME_COUNT = 15;
    // Each "round" interleaves new sample points between the previous ones, so
    // "more frame choices" returns genuinely different stills (round 0 = base).
    const gap = (0.93 - 0.05) / (FRAME_COUNT - 1);
    const phase = ((Number(round) || 0) % 4) * (gap / 4);
    const pcts = Array.from({ length: FRAME_COUNT }, (_, i) => Math.min(0.97, Math.max(0.03, 0.05 + gap * i + phase)));
    let idx = 0;
    for (const p of pcts) {
      const t = dur > 0 ? dur * p : (idx * 1.2 + 0.4); // fallback: early offsets
      const out = path.join(os.tmpdir(), `yt-thumbf-${jobId}-${idx}.jpg`);
      framePaths.push(out);
      idx++;
      try {
        await runFfmpeg([
          "-hide_banner", "-loglevel", "error", "-y",
          "-ss", t.toFixed(2),
          "-i", tmpVideo,
          "-frames:v", "1",
          "-vf", "scale=1280:720:force_original_aspect_ratio=decrease",
          "-q:v", "3",
          out,
        ]);
        const buf = await fs.promises.readFile(out);
        if (buf.length) frames.push("data:image/jpeg;base64," + buf.toString("base64"));
      } catch { /* skip this timestamp */ }
    }
    if (frames.length === 0) throw new Error("Couldn't extract any frames from this video.");
    job.state = "done";
    job.frames = frames;
  } catch (err) {
    job.state = "error";
    job.error = err?.message || String(err);
  } finally {
    fs.promises.unlink(tmpVideo).catch(() => {});
    for (const fp of framePaths) fs.promises.unlink(fp).catch(() => {});
  }
}

const app = express();

// ===================== Bulletproofing: async route wrapper =====================
// express-async-errors style. Wrap every route/middleware handler so a thrown
// error OR a rejected promise is forwarded to the error-handling middleware
// instead of crashing the process or hanging the request. Arity is preserved
// (3-arg handlers vs 4-arg error handlers) so Express still routes correctly.
// Installed before any route is registered so all of them are covered.
function wrapHandler(fn) {
  if (typeof fn !== "function") return fn;
  if (fn.length >= 4) {
    return function (err, req, res, next) {
      try { return Promise.resolve(fn.call(this, err, req, res, next)).catch(next); }
      catch (e) { return next(e); }
    };
  }
  return function (req, res, next) {
    try { return Promise.resolve(fn.call(this, req, res, next)).catch(next); }
    catch (e) { return next(e); }
  };
}
["get", "post", "put", "delete", "patch", "options", "head", "all", "use"].forEach(function (m) {
  const orig = app[m].bind(app);
  app[m] = function (...args) { return orig.apply(this, args.map((a) => (typeof a === "function" ? wrapHandler(a) : a))); };
});

// ---- Network resilience: fetch with a hard timeout (and optional one retry) ----
// A generous default ceiling (120s) so a hung upstream can never wedge a request
// forever, yet long-but-valid AI / image-generation calls are never cut short.
// retryIdempotent retries ONCE on network failure/abort — only ever passed for the
// idempotent MSM bridge GET (never for AI calls, email, or uploads). R2 (AWS SDK)
// and YouTube (googleapis) calls keep their own SDK timeouts/retries.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 120000, retryIdempotent = false) {
  const once = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  };
  try { return await once(); }
  catch (e) { if (retryIdempotent) return await once(); throw e; }
}

app.use(suiteAuthGate); // Magic Suite SSO — verify MSM's shared login before any route or body parsing
app.use(express.json({ limit: "12mb" })); // base64 thumbnail images can be a few MB

// ---------- In-app feedback (emails the team via Resend, like MSM) ----------
// Needs RESEND_API_KEY + CALLSHEET_FROM in Render. FEEDBACK_TO routes it to a
// specific inbox (else it goes to the FROM address). No-ops if not configured.
function fbEsc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
async function sendFeedbackEmail(note, room){
  const key = process.env.RESEND_API_KEY || "", from = process.env.CALLSHEET_FROM || "";
  if (!key || !from) { console.warn("[feedback] skipped — Resend not configured (need RESEND_API_KEY + CALLSHEET_FROM)"); return { ok:false }; }
  const ownerEmail = from.replace(/^.*<([^>]+)>.*$/, "$1");
  const to = (process.env.FEEDBACK_TO || ownerEmail || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { console.warn("[feedback] skipped — no valid recipient; set FEEDBACK_TO"); return { ok:false }; }
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1c;line-height:1.5;">' +
    '<p><strong>New feedback</strong> from Magic Marquee.</p>' +
    '<p style="color:#555;font-size:13px;">Room: <strong>' + fbEsc(room || "—") + '</strong></p>' +
    '<div style="background:#eef4ff;border-left:3px solid #2f80ff;padding:12px 14px;border-radius:4px;white-space:pre-wrap;font-size:14px;">' + fbEsc(note) + '</div></div>';
  try {
    const r = await fetchWithTimeout("https://api.resend.com/emails", { method:"POST", headers:{ "Authorization":"Bearer " + key, "Content-Type":"application/json" }, body: JSON.stringify({ from, to: [to], subject: "Magic Marquee feedback — " + (room || "app"), html }) }, 8000);
    if (!r.ok) { console.warn("[feedback] rejected by Resend:", r.status); return { ok:false }; }
    return { ok:true };
  } catch(e){ console.warn("[feedback] send failed:", e && e.message); return { ok:false }; }
}
app.post("/api/feedback", async (req, res) => {
  try {
    const note = String((req.body && req.body.note) || "").trim().slice(0, 4000);
    const room = String((req.body && req.body.room) || "").trim().slice(0, 80);
    if (!note) return res.status(400).json({ ok:false, error:"Write a note first." });
    const out = await sendFeedbackEmail(note, room);
    res.json({ ok:true, emailed: !!(out && out.ok) });
  } catch(e){ console.warn("[feedback] handler error:", e && e.message); res.status(500).json({ ok:false }); }
});

// ---------- Error logging + email alerts (the practical "health" layer) ----------
// Every server-side error is console-logged; a brief alert is emailed to Isaiah via
// the existing Resend setup, rate-limited so an error storm can't spam the inbox or
// burn the API quota. Fully best-effort — alerting NEVER throws.
let _lastAlertAt = 0;
const ALERT_MIN_GAP_MS = 5 * 60 * 1000; // at most one email alert per 5 minutes
async function sendErrorAlert(subject, detail) {
  try {
    const key = process.env.RESEND_API_KEY || "", from = process.env.CALLSHEET_FROM || "";
    if (!key || !from) return;
    const now = Date.now();
    if (now - _lastAlertAt < ALERT_MIN_GAP_MS) return;
    _lastAlertAt = now;
    const ownerEmail = from.replace(/^.*<([^>]+)>.*$/, "$1");
    const to = (process.env.FEEDBACK_TO || ownerEmail || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;
    const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1c;line-height:1.5;">' +
      '<p><strong>Magic Marquee — server error</strong></p>' +
      '<div style="background:#fdecea;border-left:3px solid #d9483b;padding:12px 14px;border-radius:4px;white-space:pre-wrap;font-size:13px;">' +
      fbEsc(subject) + "\n\n" + fbEsc(String(detail)).slice(0, 2000) + '</div></div>';
    await fetchWithTimeout("https://api.resend.com/emails", { method:"POST", headers:{ "Authorization":"Bearer " + key, "Content-Type":"application/json" }, body: JSON.stringify({ from, to:[to], subject: "⚠️ Magic Marquee — " + subject, html }) }, 8000);
  } catch (e) { /* never let alerting throw */ }
}
function logError(where, err) {
  const msg = (err && err.stack) || (err && err.message) || String(err);
  console.error("[error] " + where + ": " + msg);
  sendErrorAlert(where, msg);
}

// Capture client-side errors too (best-effort; never fails the page). Public
// (exempt from the SSO gate) so it works even if the session cookie has lapsed.
app.post("/api/client-error", (req, res) => {
  try {
    const b = req.body || {};
    const msg = String(b.message || "").slice(0, 500);
    const src = String(b.source || "").slice(0, 300);
    if (msg) console.error("[client-error] " + msg + (src ? " @ " + src : ""));
  } catch (e) {}
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/tabs.html", (req, res) => {
  res.redirect("/"); // studio moved to the main page; keep old links/bookmarks working
});

app.get("/api/status", (req, res) => {
  res.json({
    configured: Boolean(CLIENT_ID && CLIENT_SECRET),
    authorized: Boolean(refreshToken),
    r2Configured,
    aiConfigured,
    transcribeConfigured,
    imageConfigured,
    dbConfigured,
    msmConfigured,
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
  :root { --accent:#7c4dff; color-scheme:dark; }
  body { font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#f0f0f3; background:#0d0d10; margin:0; padding:32px 20px; }
  .card { max-width:640px; margin:0 auto; background:#16161b; border:1px solid #23232b; border-radius:18px; padding:28px; box-shadow:0 1px 3px rgba(0,0,0,.4); }
  h1 { font-size:22px; margin:0 0 6px; }
  p { color:#b6b6bf; }
  code { display:block; word-break:break-all; background:#101014; border:1px solid #2c2c34; border-radius:10px; padding:14px; margin:14px 0; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  a.btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; padding:11px 18px; border-radius:11px; font-weight:600; }
  button { font:inherit; border:0; background:#26262e; color:#f0f0f3; border-radius:9px; padding:8px 14px; cursor:pointer; }
  .muted { font-size:13px; color:#9a9aa4; }
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
    'Provide the metadata by calling the emit_metadata tool with its three fields: "title", "synopsis", and "chapters".',
    "",
    "Rules:",
    "- title: a CATCHY, attention-grabbing title in the style of viral YouTube short films — a punchy, present-tense hook that captures the central conflict, the surprising turn, or the emotional stakes and makes someone want to click. Under 90 characters, Title Case, no emoji. It must stay TRUE to the film: create intrigue, never deceive, and never reveal the ending. Match the dramatic, curiosity-driven style of this channel's real titles, e.g. \"Boss Lady Shocks Co-worker With Unexpected Act of Kindness\", \"Woman Vows To Never Forgive Her Sister Again\", \"Man Blames Himself For Wife's Death, Contemplates Suicide\". Do NOT add the channel name or any '| ...' suffix — that is added separately.",
    "- synopsis: just 1-2 short, punchy sentences. Hook the viewer with the premise, tone, or central question — make them want to click — without giving away the plot or the ending. No chapter timestamps, no calls to subscribe. Short and sweet.",
    '- chapters: ONLY if the transcript includes timestamps, a newline-separated list of chapter markers, one per line, in the format "M:SS Label" (use "H:MM:SS Label" for films over an hour). The FIRST line MUST start at "0:00". Provide at least 3 chapters, each at least 10 seconds after the previous one, anchored to real shifts in the transcript (scene/beat changes). If the transcript has NO timestamps, return an empty string "" — do not invent chapters.',
    "- If the transcript is empty or nearly silent (little/no dialogue), base the synopsis on the logline. If there is ALSO no logline, infer a short, plausible title and synopsis from the filename; if even that gives nothing, use a simple generic title and a one-line placeholder synopsis. Keep it modest — don't invent specific plot or dialogue the inputs don't support — but ALWAYS fill the fields.",
    "- CRITICAL: Always call the emit_metadata tool, and always fill all three fields. Even when inputs are thin, provide a best-effort title and synopsis (inferred from the filename, or a simple placeholder) rather than refusing. chapters may be an empty string when there are no timestamps.",
  ].join("\n");

  const userContent = [
    "Transcript:",
    text.trim() || "(none provided)",
    "",
    "Logline (optional context): " + (line.trim() || "(none provided)"),
    "Filename (optional hint): " + (String(filename || "").trim() || "(none)"),
  ].join("\n");

  try {
    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: METADATA_MODEL,
        max_tokens: 4000,
        system,
        // Force the model to return its answer through this tool. The API then
        // hands the fields back already structured (no JSON string to parse),
        // and the model cannot wander into prose. Works on all current models.
        tools: [{
          name: "emit_metadata",
          description: "Return the finished YouTube metadata for this one film.",
          input_schema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Catchy title, under 90 chars, Title Case, no emoji, no channel suffix." },
              synopsis: { type: "string", description: "1-2 short, punchy, spoiler-light sentences that hook the viewer." },
              chapters: { type: "string", description: "Newline-separated 'M:SS Label' lines if the transcript has timestamps; otherwise an empty string." },
            },
            required: ["title", "synopsis", "chapters"],
          },
        }],
        tool_choice: { type: "tool", name: "emit_metadata" },
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: `AI request failed (HTTP ${r.status}): ${errText.slice(0, 300)}` });
    }

    const data = await r.json();
    // tool_choice forces a tool call, so the answer arrives already structured
    // in a tool_use block — no JSON string to parse in the normal path.
    const toolBlock = (data.content || []).find((b) => b && b.type === "tool_use" && b.input);
    let parsed;
    if (toolBlock) {
      parsed = toolBlock.input;
    } else {
      // Fallback (shouldn't happen with forced tool_choice): rescue from any text.
      const raw = (data.content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
      let jsonSlice = raw;
      const open = jsonSlice.indexOf("{"), close = jsonSlice.lastIndexOf("}");
      if (open !== -1 && close !== -1 && close > open) jsonSlice = jsonSlice.slice(open, close + 1);
      try {
        parsed = JSON.parse(jsonSlice);
      } catch {
        parsed = { title: salvageField(raw, "title"), synopsis: salvageField(raw, "synopsis"), chapters: salvageField(raw, "chapters") };
      }
      if (!parsed || (!parsed.title && !parsed.synopsis)) {
        return res.status(502).json({ error: "AI returned unparseable output.", raw: raw.slice(0, 500) });
      }
    }

    const aiTitle = String(parsed.title || "").trim();
    const synopsis = String(parsed.synopsis || "").trim();
    const chapters = String(parsed.chapters || "").trim();
    if (!aiTitle && !synopsis) {
      return res.status(502).json({ error: "AI returned empty metadata." });
    }
    // Fill the saved template's slots and compose the final title + description.
    // castText/crewText (from a selected MSM project) fill {{CAST}}/{{CREW}}.
    const castText = (req.body && req.body.castText != null) ? String(req.body.castText) : undefined;
    const crewText = (req.body && req.body.crewText != null) ? String(req.body.crewText) : undefined;
    const composed = composeMetadata({ aiTitle, synopsis, chapters, castText, crewText });
    res.json({ title: composed.title, description: composed.description, rawTitle: aiTitle, synopsis, chapters });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Template: the permanent title + description scaffold (with {{TOKEN}} slots) plus
// saved field defaults. Returns the built-in default when the DB isn't configured.
app.get("/api/template", async (req, res) => {
  try {
    if (dbConfigured) await refreshTemplateCache();
    res.json({
      titleTemplate: templateCache.title_template,
      descriptionTemplate: templateCache.description_template,
      defaults: templateCache.defaults || {},
      autoTokens: AUTO_TOKENS,
      persisted: dbConfigured,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Save the template. Keeps default values only for tokens that actually appear in
// the templates and aren't auto-filled, so saved defaults stay tidy.
app.post("/api/template", async (req, res) => {
  if (!dbConfigured) {
    return res.status(500).json({ error: "Can't save — set DATABASE_URL in Render to turn on templates." });
  }
  const { titleTemplate, descriptionTemplate, defaults } = req.body || {};
  const titleTpl = String(titleTemplate || "").slice(0, 5000);
  const descTpl = String(descriptionTemplate || "").slice(0, 20000);
  if (!titleTpl.trim() && !descTpl.trim()) {
    return res.status(400).json({ error: "Template is empty." });
  }
  const used = scanTokens(titleTpl + "\n" + descTpl).filter((t) => AUTO_TOKENS.indexOf(t) === -1);
  const inDefaults = (defaults && typeof defaults === "object") ? defaults : {};
  const cleanDefaults = {};
  for (const t of used) cleanDefaults[t] = String(inDefaults[t] ?? "").slice(0, 4000);
  try {
    await pool.query(
      `INSERT INTO yt_settings (id, title_template, description_template, defaults, updated_at)
       VALUES (1, $1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         title_template = EXCLUDED.title_template,
         description_template = EXCLUDED.description_template,
         defaults = EXCLUDED.defaults,
         updated_at = now()`,
      [titleTpl, descTpl, JSON.stringify(cleanDefaults)]
    );
    await refreshTemplateCache();
    res.json({ ok: true, fields: used });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --- Saved logos (Logo Studio): the design lives in Postgres (yt_logos); an
// uploaded logo image lives in R2, referenced by key. The image is served back
// through this same origin (a proxy), so drawing it on the canvas never taints
// the export. Single-user for now. ---
const LOGO_OWNER = "me"; // becomes a real owner id when Suite SSO lands
function logoImgUrl(row) { return row && row.img_key ? ("/api/logos/" + row.id + "/image") : null; }

app.get("/api/logos", async (req, res) => {
  if (!dbConfigured) return res.json({ logos: [], persisted: false });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, data, img_key FROM yt_logos WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 60`,
      [LOGO_OWNER]
    );
    const logos = rows.map((r) => ({ id: r.id, name: r.name, data: r.data || {}, imgKey: r.img_key || null, imgUrl: logoImgUrl(r) }));
    res.json({ logos, persisted: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/logos", async (req, res) => {
  if (!dbConfigured) return res.status(500).json({ error: "Can't save — set DATABASE_URL in Render to turn on saving." });
  const { name, logo, image, imgKey } = req.body || {};
  const nm = (String(name || "Logo").trim().slice(0, 60)) || "Logo";
  const data = (logo && typeof logo === "object") ? logo : {};
  let key = (typeof imgKey === "string" && imgKey) ? imgKey : null;
  let imgType = null;
  try {
    if (!key && typeof image === "string" && image.indexOf("data:") === 0) {
      if (!r2Configured) return res.status(500).json({ error: "Image storage not configured (set R2_* env vars)." });
      const comma = image.indexOf(",");
      imgType = image.slice(5, image.indexOf(";")) || "image/png";
      const buf = Buffer.from(image.slice(comma + 1), "base64");
      if (buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: "Logo image is too large (max 4MB)." });
      key = `logos/${LOGO_OWNER}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: imgType }));
    }
    const { rows } = await pool.query(
      `INSERT INTO yt_logos (owner_id, name, data, img_key, img_type)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, name, data, img_key`,
      [LOGO_OWNER, nm, JSON.stringify(data), key, imgType]
    );
    const r = rows[0];
    res.json({ id: r.id, name: r.name, data: r.data || {}, imgKey: r.img_key || null, imgUrl: logoImgUrl(r) });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Same-origin image proxy: stream the logo image out of R2 so the browser can
// draw it on the canvas without tainting it (R2's own domain is cross-origin).
app.get("/api/logos/:id/image", async (req, res) => {
  if (!dbConfigured || !r2Configured) return res.status(404).end();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).end();
  try {
    const { rows } = await pool.query(`SELECT img_key, img_type FROM yt_logos WHERE id = $1 AND owner_id = $2`, [id, LOGO_OWNER]);
    const row = rows[0];
    if (!row || !row.img_key) return res.status(404).end();
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: row.img_key }));
    res.setHeader("Content-Type", row.img_type || "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    obj.Body.on("error", () => { try { res.destroy(); } catch (e) {} });
    obj.Body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
  }
});

app.delete("/api/logos/:id", async (req, res) => {
  if (!dbConfigured) return res.status(500).json({ error: "Database not configured." });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id." });
  try {
    const { rows } = await pool.query(`DELETE FROM yt_logos WHERE id = $1 AND owner_id = $2 RETURNING img_key`, [id, LOGO_OWNER]);
    const key = rows[0] && rows[0].img_key;
    if (key && r2Configured) { try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); } catch (e) {} }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --- Saved thumbnails (Save Thumbnail = re-editable setup). The full editor
// state lives in Postgres (yt_thumbs.data); the current background photo (and
// any uploaded logo image) live in R2 and are served back through this same
// origin so re-drawing them on the canvas never taints the export. ---
async function storeImageDataUrl(prefix, dataUrl, maxBytes) {
  if (typeof dataUrl !== "string" || dataUrl.indexOf("data:") !== 0) return null;
  if (!r2Configured) throw new Error("Image storage not configured (set R2_* env vars).");
  const comma = dataUrl.indexOf(",");
  const type = dataUrl.slice(5, dataUrl.indexOf(";")) || "image/jpeg";
  const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (buf.length > (maxBytes || 8 * 1024 * 1024)) throw new Error("Image is too large.");
  const key = `${prefix}/${LOGO_OWNER}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: type }));
  return { key, type };
}
function thumbAssetUrl(row, which) {
  const k = which === "logo" ? (row && row.logo_key) : (row && row.photo_key);
  return k ? ("/api/thumbs/" + row.id + "/" + which) : null;
}

app.get("/api/thumbs", async (req, res) => {
  if (!dbConfigured) return res.json({ thumbs: [], persisted: false });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, data, photo_key, logo_key FROM yt_thumbs WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 60`,
      [LOGO_OWNER]
    );
    const thumbs = rows.map((r) => ({ id: r.id, name: r.name, data: r.data || {}, photoUrl: thumbAssetUrl(r, "photo"), logoUrl: thumbAssetUrl(r, "logo") }));
    res.json({ thumbs, persisted: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/thumbs", async (req, res) => {
  if (!dbConfigured) return res.status(500).json({ error: "Can't save — set DATABASE_URL in Render to turn on saving." });
  const { name, state, photo, logoImage } = req.body || {};
  const nm = (String(name || "Thumbnail").trim().slice(0, 80)) || "Thumbnail";
  const data = (state && typeof state === "object") ? state : {};
  try {
    const p = photo ? await storeImageDataUrl("thumbs", photo, 8 * 1024 * 1024) : null;
    const l = logoImage ? await storeImageDataUrl("thumblogos", logoImage, 4 * 1024 * 1024) : null;
    const { rows } = await pool.query(
      `INSERT INTO yt_thumbs (owner_id, name, data, photo_key, photo_type, logo_key, logo_type)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING id, name, data, photo_key, logo_key`,
      [LOGO_OWNER, nm, JSON.stringify(data), p && p.key, p && p.type, l && l.key, l && l.type]
    );
    const r = rows[0];
    res.json({ id: r.id, name: r.name, data: r.data || {}, photoUrl: thumbAssetUrl(r, "photo"), logoUrl: thumbAssetUrl(r, "logo") });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Same-origin asset proxy: stream a saved thumbnail's photo or logo out of R2.
app.get("/api/thumbs/:id/:which", async (req, res) => {
  if (!dbConfigured || !r2Configured) return res.status(404).end();
  const id = parseInt(req.params.id, 10);
  const which = req.params.which === "logo" ? "logo" : (req.params.which === "photo" ? "photo" : null);
  if (!Number.isFinite(id) || !which) return res.status(400).end();
  try {
    const { rows } = await pool.query(`SELECT photo_key, photo_type, logo_key, logo_type FROM yt_thumbs WHERE id = $1 AND owner_id = $2`, [id, LOGO_OWNER]);
    const row = rows[0];
    const key = row && (which === "logo" ? row.logo_key : row.photo_key);
    const type = row && (which === "logo" ? row.logo_type : row.photo_type);
    if (!key) return res.status(404).end();
    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    res.setHeader("Content-Type", type || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    obj.Body.on("error", () => { try { res.destroy(); } catch (e) {} });
    obj.Body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
  }
});

app.delete("/api/thumbs/:id", async (req, res) => {
  if (!dbConfigured) return res.status(500).json({ error: "Database not configured." });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id." });
  try {
    const { rows } = await pool.query(`DELETE FROM yt_thumbs WHERE id = $1 AND owner_id = $2 RETURNING photo_key, logo_key`, [id, LOGO_OWNER]);
    const row = rows[0];
    if (row && r2Configured) {
      for (const k of [row.photo_key, row.logo_key]) { if (k) { try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: k })); } catch (e) {} } }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Recompose the description from the AI's pieces + (optionally) a project's
// cast/crew — no AI call, so picking a project never rewrites the title.
app.post("/api/recompose", (req, res) => {
  const b = req.body || {};
  const composed = composeMetadata({
    aiTitle: String(b.rawTitle || ""),
    synopsis: String(b.synopsis || ""),
    chapters: String(b.chapters || ""),
    castText: b.castText != null ? String(b.castText) : undefined,
    crewText: b.crewText != null ? String(b.crewText) : undefined,
  });
  res.json({ title: composed.title, description: composed.description });
});

// --- Magic Story Maker bridge (server-to-server, key stays here) -------------
async function msmFetch(pathAndQuery) {
  const r = await fetchWithTimeout(MSM_BASE_URL + pathAndQuery, { headers: { "X-Export-Key": MSM_EXPORT_KEY } }, 12000, true);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, data };
}
app.get("/api/msm/projects", async (req, res) => {
  if (!msmConfigured) return res.status(503).json({ error: "MSM link not set up (set MSM_BASE_URL + MSM_EXPORT_KEY)." });
  try {
    const out = await msmFetch("/api/export/projects");
    if (!out.ok) return res.status(out.status).json({ error: out.data.error || "MSM request failed." });
    res.json(out.data);
  } catch (err) { res.status(502).json({ error: err?.message || String(err) }); }
});
app.get("/api/msm/credits", async (req, res) => {
  if (!msmConfigured) return res.status(503).json({ error: "MSM link not set up." });
  const id = String(req.query.id || "");
  if (!id) return res.status(400).json({ error: "Missing project id." });
  try {
    const out = await msmFetch("/api/export/credits?project=" + encodeURIComponent(id));
    if (!out.ok) return res.status(out.status).json({ error: out.data.error || "MSM request failed." });
    res.json(out.data);
  } catch (err) { res.status(502).json({ error: err?.message || String(err) }); }
});

// --- Thumbnail maker --------------------------------------------------------
// TH-1: kick off background frame extraction from the R2 master.
app.post("/api/thumb/frames", (req, res) => {
  if (!r2Configured) return res.status(500).json({ error: "R2 not configured." });
  if (!ffmpegStatic) return res.status(500).json({ error: "ffmpeg not available." });
  const { key, round } = req.body || {};
  if (!key) return res.status(400).json({ error: "Missing key." });
  const jobId = crypto.randomUUID();
  thumbJobs.set(jobId, { state: "fetching", createdAt: Date.now() });
  runFrameExtraction(jobId, key, round);
  res.json({ jobId });
});

// TH-2: poll frame-extraction progress + the candidate frames.
app.get("/api/thumb/frames/:jobId", (req, res) => {
  const job = thumbJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json(job);
});

// TH-3: AI writes a short, punchy thumbnail overlay from the title + synopsis,
// grouped into lines of words with per-word highlight flags.
app.post("/api/thumb/text", async (req, res) => {
  if (!aiConfigured) return res.status(500).json({ error: "AI not configured (set ANTHROPIC_API_KEY)." });
  const { title, synopsis } = req.body || {};
  const t = String(title || "").slice(0, 300).trim();
  const s = String(synopsis || "").slice(0, 4000).trim();
  if (!t && !s) return res.status(400).json({ error: "Need a title or synopsis to work from." });

  const system = [
    "You write the SHORT punchy text overlay that goes on a YouTube thumbnail for a fictional narrative short film (channel: Isaiah Jeremiah).",
    "Given the film's title and synopsis, write a thumbnail hook: 3 to 8 words total, broken into 2-3 short lines, ALL CAPS or strong Title Case, dramatic and curiosity-driven. It is NOT the full title — it is a bold, scannable hook (e.g. \"HE LOST HER / & BECAME / SUICIDAL\").",
    "Choose 1-3 of the most emotionally charged words to highlight in the accent color.",
    'Provide the overlay by calling the emit_overlay tool. Each inner array is one line of words top-to-bottom; "t" is the word text and "b" is true if that word should be highlighted in the accent color.',
  ].join("\n");
  const userContent = "Title: " + (t || "(none)") + "\nSynopsis: " + (s || "(none)");

  try {
    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: METADATA_MODEL,
        max_tokens: 400,
        system,
        tools: [{
          name: "emit_overlay",
          description: "Return the short punchy thumbnail text overlay.",
          input_schema: {
            type: "object",
            properties: {
              lines: {
                type: "array",
                description: "2-3 lines, top to bottom. Each line is an array of word objects.",
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      t: { type: "string", description: "The word." },
                      b: { type: "boolean", description: "true to highlight this word in the accent color." },
                    },
                    required: ["t", "b"],
                  },
                },
              },
            },
            required: ["lines"],
          },
        }],
        tool_choice: { type: "tool", name: "emit_overlay" },
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: `AI request failed (HTTP ${r.status}): ${errText.slice(0, 200)}` });
    }
    const data = await r.json();
    const toolBlock = (data.content || []).find((b) => b && b.type === "tool_use" && b.input);
    let parsed;
    if (toolBlock) {
      parsed = toolBlock.input;
    } else {
      let raw = (data.content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
      const open = raw.indexOf("{"), close = raw.lastIndexOf("}");
      if (open !== -1 && close > open) raw = raw.slice(open, close + 1);
      try { parsed = JSON.parse(raw); } catch { return res.status(502).json({ error: "AI returned unparseable overlay." }); }
    }
    // Normalize into clean lines of {t,b}.
    const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
    const clean = lines
      .map((line) => (Array.isArray(line) ? line
        .map((w) => ({ t: String(w && w.t != null ? w.t : "").slice(0, 40), b: Boolean(w && w.b) }))
        .filter((w) => w.t.trim()) : []))
      .filter((line) => line.length);
    if (clean.length === 0) return res.status(502).json({ error: "AI returned an empty overlay." });
    res.json({ lines: clean });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// TH-4: stamp the composed thumbnail (base64 image) onto the YouTube video.
app.post("/api/thumb/set", async (req, res) => {
  if (!refreshToken) return res.status(401).json({ error: "Not authorized yet." });
  const { videoId, imageBase64 } = req.body || {};
  if (!videoId || !imageBase64) return res.status(400).json({ error: "Missing videoId or image." });
  try {
    const b64 = imageBase64.indexOf(",") !== -1 ? imageBase64.slice(imageBase64.indexOf(",") + 1) : imageBase64;
    const buf = Buffer.from(b64, "base64");
    if (buf.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: "Thumbnail is over YouTube's 2MB limit — try again (the app exports JPEG to stay small)." });
    }
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: refreshToken });
    const youtube = google.youtube({ version: "v3", auth });
    await youtube.thumbnails.set({ videoId, media: { mimeType: "image/jpeg", body: Readable.from(buf) } });
    res.json({ ok: true });
  } catch (err) {
    const reason = err?.errors?.[0]?.reason;
    const msg = err?.response?.data?.error?.message || err?.message || String(err);
    res.status(500).json({ error: reason ? `${reason}: ${msg}` : msg });
  }
});

// AI enhance for thumbnails — touch up the real shot, swap the background while
// keeping the subject, or generate a fresh background. Uses OpenAI GPT Image
// (edits for the first two, generation for the last). Returns a base64 PNG.
app.post("/api/thumb/enhance", async (req, res) => {
  if (!imageConfigured) return res.status(500).json({ error: "Image enhance not configured (set OPENAI_API_KEY in Render)." });
  const { mode, imageBase64, maskBase64, prompt, title, synopsis } = req.body || {};
  const m = String(mode || "").trim();
  const userHint = String(prompt || "").slice(0, 600).trim();
  const ctx = [String(title || "").trim(), String(synopsis || "").trim()].filter(Boolean).join(" — ").slice(0, 600);

  let instruction;
  if (m === "touchup") {
    instruction = "Enhance this video still into a polished, eye-catching YouTube thumbnail background. Improve the lighting, color, contrast, and sharpness for a cinematic, high-impact look. Keep the composition, the subject, and any people's faces and identity EXACTLY the same — only improve quality. No added text, no logos, no watermarks." + (userHint ? " Direction: " + userHint + "." : "");
  } else if (m === "replacebg") {
    instruction = "Replace ONLY the background behind the main subject with a dramatic, cinematic backdrop that fits the film" + (ctx ? " (" + ctx + ")" : "") + ". Keep the main subject / person exactly the same — same pose, face, identity, and placement. Make it look like a professional movie thumbnail. No added text, no logos, no watermarks." + (userHint ? " Background to use: " + userHint + "." : "");
  } else if (m === "genbg") {
    instruction = "Create a dramatic, cinematic background image for a YouTube thumbnail" + (ctx ? " for this film: " + ctx : "") + ". Rich lighting and depth, strong visual impact, no people, no text, no logos, no watermarks." + (userHint ? " Specifics: " + userHint + "." : "");
  } else if (m === "extendbg") {
    instruction = "Extend the scene outward to fill the empty edges around the subject with a seamless, photorealistic continuation of the existing image" + (ctx ? " for this film (" + ctx + ")" : "") + ". Keep every existing (non-masked) pixel EXACTLY the same — same subject, faces, identity, colors, and placement. Only paint the masked empty edges. No added text, no logos, no watermarks." + (userHint ? " Background style: " + userHint + "." : "");
  } else {
    return res.status(400).json({ error: "Unknown enhance mode." });
  }

  try {
    let r;
    if (m === "genbg") {
      r = await fetchWithTimeout("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt: instruction, size: IMAGE_SIZE, quality: IMAGE_QUALITY, n: 1 }),
      });
    } else {
      if (!imageBase64) return res.status(400).json({ error: "Missing image to enhance." });
      const b64 = imageBase64.indexOf(",") !== -1 ? imageBase64.slice(imageBase64.indexOf(",") + 1) : imageBase64;
      const buf = Buffer.from(b64, "base64");
      const isExtend = (m === "extendbg");
      const form = new FormData();
      form.append("model", IMAGE_MODEL);
      form.append("image[]", new Blob([buf], { type: "image/jpeg" }), "frame.jpg");
      if (isExtend) {
        if (!maskBase64) return res.status(400).json({ error: "Missing mask for extend." });
        const mb64 = maskBase64.indexOf(",") !== -1 ? maskBase64.slice(maskBase64.indexOf(",") + 1) : maskBase64;
        form.append("mask", new Blob([Buffer.from(mb64, "base64")], { type: "image/png" }), "mask.png");
      }
      form.append("prompt", instruction);
      form.append("size", IMAGE_SIZE);
      form.append("quality", IMAGE_QUALITY);
      form.append("input_fidelity", "high");
      r = await fetchWithTimeout("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      });
    }
    if (!r.ok) {
      const errText = await r.text();
      let msg = errText.slice(0, 400);
      try { const j = JSON.parse(errText); if (j && j.error && j.error.message) msg = j.error.message; } catch (_) { }
      const hint = msg.toLowerCase().indexOf("verif") !== -1
        ? " (Your OpenAI organization likely needs verification to use image models — platform.openai.com → Settings → Organization → General.)"
        : "";
      return res.status(502).json({ error: `Image request failed (HTTP ${r.status}): ${msg}${hint}` });
    }
    const data = await r.json();
    const out = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!out) return res.status(502).json({ error: "Image model returned no image." });
    res.json({ image: "data:image/png;base64," + out });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
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

// ---------- Global error-handling middleware — friendly, never a raw crash ----------
// Registered after every route so it catches errors from any of them (sync throws and
// async rejections both arrive here via the wrapper above). Logs + alerts, then returns
// a calm message. If the response already started, defer to Express's default handler.
app.use((err, req, res, next) => {
  logError("route " + req.method + " " + req.path, err);
  if (res.headersSent) return next(err);
  const wantsHtml = req.method === "GET" && String(req.headers.accept || "").indexOf("text/html") !== -1;
  if (wantsHtml) {
    return res.status(500).type("html").send('<!doctype html><meta charset="utf-8"><title>Something went wrong</title><body style="font-family:-apple-system,Segoe UI,sans-serif;padding:40px;color:#333;"><h1>Something went wrong</h1><p>The app hit a snag. Please try again in a moment.</p></body>');
  }
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// ---------- Process-level safety nets — log, alert, and STAY ALIVE ----------
// A stray uncaught exception or unhandled rejection must never take the server down.
process.on("uncaughtException", (err) => { logError("uncaughtException", err); });
process.on("unhandledRejection", (reason) => { logError("unhandledRejection", reason); });

initDb().catch((e) => console.error("DB init failed (templates fall back to the built-in default):", e?.message || e));

app.listen(PORT, () => {
  console.log(`YouTube uploader v${APP_VERSION} listening on ${BASE_URL}`);
  console.log(`Redirect URI to register in Google Cloud: ${REDIRECT_URI}`);
  console.log(`R2 configured: ${r2Configured}`);
  console.log(`AI metadata configured: ${aiConfigured}`);
  console.log(`Transcription configured: ${transcribeConfigured}`);
  console.log(`Image enhance configured: ${imageConfigured} (model ${IMAGE_MODEL})`);
  console.log(`Database configured: ${dbConfigured}`);
  console.log(`MSM bridge configured: ${msmConfigured}`);
});
