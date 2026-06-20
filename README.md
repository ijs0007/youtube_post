# YouTube Uploader

Drop a film file in the browser → (optionally) drop a transcript and let the AI
write the **title, description, and chapter timestamps** → review/edit them → the
file uploads straight to Cloudflare R2 (bypassing Render) → the server transfers it
from R2 to YouTube as a **private** video. R2 is the durable home the later steps
(thumbnail frame extraction) will also read from.

## Files
- `server.js` — Express: OAuth, `/api/presign` (R2 upload URL), `/api/transfer`
  (background R2→YouTube), `/api/transfer/:jobId` (progress), `/api/metadata`
  (transcript → AI title/description/chapters), `/api/r2test` (diagnostic).
- `public/index.html` — UI: status, Authorize, transcript/logline inputs, AI
  Generate button, editable title + description, upload with two-phase progress.
- `package.json` — deps: express, googleapis, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner.
  (The AI call uses native `fetch` — no extra dependency.)

## Env vars (Render → Environment)
Already set from step 1: `CLIENT_ID`, `CLIENT_SECRET`, `BASE_URL`, `YT_REFRESH_TOKEN`.

New for step 2 (Cloudflare R2):
- `R2_ACCOUNT_ID` — your Cloudflare account ID.
- `R2_ACCESS_KEY_ID` — R2 S3 access key ID.
- `R2_SECRET_ACCESS_KEY` — R2 S3 secret access key.
- `R2_BUCKET` — the bucket name.

New for step 3 (AI metadata):
- `ANTHROPIC_API_KEY` — your Anthropic API key. Powers `/api/metadata`. Without it,
  the Generate button is disabled but manual upload still works. Model is set in
  `server.js` (`METADATA_MODEL`, default `claude-sonnet-4-6`; swap to a stronger
  model there for max-quality titles).

## R2 setup (Cloudflare dashboard)

1. **Create a bucket** — Cloudflare dashboard → **R2** → Create bucket → name it
   (e.g. `youtube-masters`). That name is `R2_BUCKET`. Standard location is fine.
2. **Account ID** — shown on the R2 overview page (and in the bucket's S3 API
   endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`). That's `R2_ACCOUNT_ID`.
3. **S3 credentials** — R2 → **Manage R2 API Tokens** → Create API token → permission
   **Object Read & Write**, scoped to this bucket → Create. Copy the **Access Key ID**
   and **Secret Access Key** (the secret is shown once). These are `R2_ACCESS_KEY_ID`
   and `R2_SECRET_ACCESS_KEY`.
4. **CORS** — bucket → **Settings** → **CORS Policy** → Add, paste:

```json
[
  {
    "AllowedOrigins": ["https://youtube-post.onrender.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

   ⚠️ `AllowedHeaders` must be `"content-type"`, **not** `"*"` — the wildcard makes
   R2 reject browser uploads with a 403. Origin must match your Render URL exactly.

5. Add the four `R2_*` env vars in Render → Save → wait for redeploy → **Live**.
   The status line should read **"Authorized, R2 connected — ready."**

## Test
Pick a video → Upload. You'll see two bars: **R2** (browser → R2) then
**YouTube** (R2 → YouTube). Result card shows **Privacy: private** and Studio/Watch links.

## AI metadata (step 3)
1. Pick your video, then **optionally** add a transcript file (`.srt` / `.vtt` /
   `.txt`). Export **SRT or VTT** from your NLE if you want auto-chapters — the
   timestamps are what YouTube builds chapter markers from. Plain `.txt` gives a
   title + description but no chapters. A transcription from a Whisper-class tool
   works identically (same file types) and can be slotted in later.
2. For near-silent footage, type a one-line **logline** instead of (or alongside)
   the transcript.
3. Click **Generate title & description** → the AI fills both fields. They're fully
   **editable** — tweak anything, or click Generate again to redo.
4. Click **Upload**. The (possibly edited) title + description ride along to YouTube.
   Chapters are formatted into the description (0:00-anchored, 3+, ≥10s apart), which
   YouTube auto-converts into chapter buttons.

## This build's limits (deliberate, Tier 1)
- **5GB max per file**, and the R2 upload **won't resume** if the connection drops
  mid-upload. Fine for typical shorts. Bigger masters / flaky connections → next
  step is chunked/multipart (any size, per-chunk retry).
- Transfer + metadata are stateless/in-memory (single-user). Persistence/history →
  optional later upgrade (a `yt_` table in the shared Neon DB).
- Metadata quality depends on the transcript. No transcript and no logline → the
  Generate button has nothing to work from.

## Not yet
Thumbnail compositor (needs real channel thumbnails), optional generative image
polish, in-app Whisper-class auto-transcription (currently bring-your-own transcript).
