// YouTube Uploader — Step 2: browser -> R2 (direct) -> background R2 -> YouTube.
// Single-channel personal tool. Refresh token held in memory, seeded from
// YT_REFRESH_TOKEN so authorization survives restarts once set.

import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_VERSION = "0.04";
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

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
});
