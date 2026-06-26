# Magic Suite — Studio Guide (house rules for Claude Code)

*This is the shared rulebook for every app in Isaiah's Magic Suite. Drop a copy in each repo as `CLAUDE.md` — Claude Code reads it automatically every session. The actual repo code always wins over this doc; if they disagree, follow the code and flag it.*

---

## Who does what
- **Isaiah** owns every product and creative decision (features, design, names, accent colors). He is non-technical and tests on **desktop + iPhone Safari (portrait)**.
- **Claude Code** writes 100% of the code. For any feature/design choice, offer Isaiah clear options — don't pick unilaterally. Plan risky or complex changes before coding.
- **Deploys are Isaiah's:** GitHub Desktop → Render auto-deploy. **Claude Code never deploys, commits, or pushes.** It edits files; Isaiah reviews the diff in GitHub Desktop and commits.
- Communication style: short, direct, execution-first. Honest tradeoffs over cheerleading. Minimal formatting.

---

## The apps

| App | Role | Subdomain | Repo | Module system | Accent |
|---|---|---|---|---|---|
| **Magic Story Maker (MSM)** | Mothership · **identity owner** · data source | `app.isaiahsmithfilms.com` | `magic-story-maker` | **ESM** | blue `#2f80ff` |
| **Magic Reel** | Footage review for cast/crew | `reels.isaiahsmithfilms.com` | `magic-reel` | **CommonJS** | purple `#7c4dff` |
| **Magic Marquee** | YouTube thumbnail studio + uploader | `marquee.isaiahsmithfilms.com` | `magic-marquee` | **ESM** | orange `#f45911` |
| **Magic Credits** | End-credits builder | `credits.isaiahsmithfilms.com` | `magic-credits` | **ESM** | green |

All are plain **Node/Express + vanilla JS — no framework, no build step.** In-place DOM updates (panels stay open during live edits).

**Shared infrastructure:** one **Neon Postgres** DB (per-app table prefixes: `msm_`, `reel_`, `credits_`, …) · **Cloudflare R2** (`youtube-masters` bucket, same-origin proxy pattern) · **Resend** email · **Mux** video (Reel) · one login, **"Suite Pass,"** with **MSM as the identity owner**.

### Per-app facts that matter
- **MSM** — ESM. A ~1.16 MB single-file `index.html` monolith. **No server-side R2** (photos are base64 in Postgres; `db.js` is a key-value layer). It owns identity and exposes a server-to-server export API: `GET /api/export/projects` and `GET /api/export/credits?project=<id>`, both gated by an `X-Export-Key` header.
- **Reel** — the **only CommonJS** app (`require`, not `import`). Mux footage review with public `/r/<token>` recipient pages.
- **Marquee** — ESM. Uses **R2** (the canonical R2 pattern), Google/YouTube OAuth, and a bridge that proxies MSM's export API. Best reference for a new ESM satellite.
- **Credits** — ESM. Extracted from MSM's End Credits room; pulls credits from MSM's export API.

---

## Suite Pass (shared login)
MSM signs a cookie **`msm_auth`** scoped to **`.isaiahsmithfilms.com`**, HMAC-SHA256 with a shared **`SESSION_SECRET`** (same value in every Render service). Satellites **verify** this cookie and redirect to MSM's login if it's missing/invalid — they never manage passwords. Copy the verifier from **Marquee** (ESM) or **Reel** (CommonJS).

---

## Universal conventions (do these every time)
- **Match the existing app:** vanilla JS, no framework, no build step.
- **`.gitattributes` is `* -text` in every repo — keep it.** This is the fix that stops Git's line-ending normalization from stripping backslashes out of regex literals (`/^https?:\/\//` → broken). Even with it in place, prefer char-class `[+]` / `[/]` or `new RegExp("…")` for any regex that ships to the browser.
- **Module system is not optional:** MSM / Marquee / Credits = **ESM** (`import`). Reel = **CommonJS** (`require`). Never mix them within an app.
- **Version bump on every user-facing ship.** The footer shows the version. MSM and Marquee **hardcode** a front-end version string in `index.html`; Reel **fetches `/version`**, so its `server.js` `APP_VERSION` must bump too. Format: `v[X.Y.Z] — [emoji] [Name]: [subtitle]`.
- **Secrets never go in code.** Real values live in Render's environment variables (`DATABASE_URL`, `SESSION_SECRET`, app-specific keys). `.env` is gitignored. Never print, commit, or paste secret values.

---

## Ship discipline (the checklist for every change)
1. **Re-baseline from the actual repo** before editing — never build from memory.
2. Make edits with scripts that assert the exact match count before writing (so a failed match leaves the file untouched).
3. **`node --check` every JS file**, including any inline `<script>` you extract (pull it to a temp file and check it).
4. **HTML tag-balance check** (div / button / nav / select).
5. **Logic-test pure functions** in Node with mocks.
6. **Version bump** (see above).
7. Hand Isaiah a clear **diff summary**; he reviews changed files in **GitHub Desktop** before committing. **Do not deploy.**

---

## Ask before (don't guess)
- Anything that **deletes data** or is otherwise **irreversible**.
- Changing a **creative/design decision** (accent color, naming, UX flow) — that's Isaiah's call; surface options.
- Anything genuinely not covered here: make the most faithful-to-the-existing-app choice, write the assumption in **`NOTES.md`**, and keep going — don't stall.

---

## Gotchas that have already bitten (avoid repeats)
- **Regex backslashes + `.gitattributes`** — covered above; this one is sneaky and breaks deploys silently.
- **ffmpeg on Render** — pointing it at an R2 URL over HTTP gets OOM-killed. Download to a local temp file via a constant-memory stream first, then run ffmpeg locally.
- **AWS SDK v3 + R2** — set `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"` on the `S3Client`; R2 CORS `AllowedHeaders` must be exactly `["content-type"]` (never wildcard). A missing setting shows up as a fake CORS error.
- **Same-named files across repos** (`server.js`, `index.html` exist in all of them) — be careful when referencing files across apps.
- **Build env can drift between sessions** — re-baseline from the repo; don't trust a stale working copy.

---

## Working style
- **One app (or one feature) per session** keeps context tight and regressions small.
- Detailed handoff notes (`NOTES.md`) bridge sessions.
- When in doubt, do less and ask — a clear question beats a confident wrong guess.
