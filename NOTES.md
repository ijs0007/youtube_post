# Magic Marquee — handoff notes

## Polish Round 4 (2026-07-01)

**Phase 1 — removed the Comments toggle from Upload Options (footer v3.46 → v3.47, server APP_VERSION 0.49 → 0.50).**
Round 3 confirmed per-video comment enable/disable is **not settable via YouTube Data API v3 `videos.insert`**
(channel/Studio setting), so the "Comments" toggle was a dead control that misled. Removed it end-to-end:
- **Markup:** deleted the `#optCommentsRow` `.optrow` (label "Comments" + `#optCommentsVal`) from the Upload
  Options tab — clean sibling removal, no layout gap (div count 323 → 322).
- **Client JS:** dropped `getComments` from the shared top-level `var` list, removed `opts.comments` from
  `readUploadOpts()`, removed the `comments:` field from `save()`'s localStorage payload, removed the
  `getComments = bindToggle('optCommentsRow', …)` binding, and updated the "four toggles"/comment copy to "three".
- **Server JS:** `sanitizeUploadOpts()` no longer reads `b.comments` or returns a `comments` field; updated the
  transfer-status comment (it never sent comments anyway, so nothing behavioral changed).
- No help-text/"How It Works" copy mentioned comment control (grep-confirmed), so nothing to prune there.
Verified: no leftover `optComments`/`getComments`/`opts.comments`/`const comments` refs; `node --check` server.js ✓
+ main inline `<script>` ✓; div-balanced (322/322); no dup IDs.

## Polish Round 3 (2026-07-01)

**Phase 2 — How It Works "?" hamburger icon → accent color (footer v3.40 → v3.41).** The hamburger "How It
Works" item led with a `❔` emoji (U+2754) that renders red/pink. Replaced it with a styled
`<span style="color:var(--accent);font-weight:700">?</span>` so the "?" uses Marquee's blue accent `#2f80ff`
(via `var(--accent)`). Icon only; still proxies to `#helpBtn`. Verified: inline scripts parse ✓; no leftover emoji.

**Phase 3 — How It Works panel → MSM centered modal (footer v3.41 → v3.42; front-end only, server APP_VERSION
unchanged).** The old `#helpPanel` was an in-flow `.helppanel` card toggled by `style.display` block/none.
Restructured it into MSM's modal shape: `.prof-overlay > .prof-overlay-backdrop + .prof-overlay-panel(
.prof-overlay-head[title + ✕] + .prof-overlay-mount[content])`. Ported the `.prof-overlay` CSS family + `@keyframes
profPopIn` from MSM (Marquee had no prior copy — verified single definition), replacing the two `.helppanel` rules;
folded the old `.helppanel b` bold color into `.prof-overlay-mount b`. Kept the "How It Works" heading (now in the
modal head) and the Magic-Marquee-led first paragraph. Open still comes from `#helpBtn` (which the hamburger item
proxies) via `classList.remove('hidden')`; close = ✕ **and** backdrop-click **and** Escape via
`classList.add('hidden')`. **Decision (noted):** the header `#helpBtn` is now open-only (was a toggle) since the
modal has its own dismiss affordances — standard modal behavior. Title span carries inline `flex:1` so the ✕ sits
right. Verified: `node --check` on the rewritten inline script ✓; div-balanced (323/323); no dup IDs; single
`.prof-overlay` definition; live Preview harness (exact ported CSS/markup/JS) confirmed centered glass modal +
dimmed/blurred backdrop + backdrop-click close.

**Phase 4 — Activity log restyled to Credits' floating "Controls" glass panel + header wrap fix (footer v3.42 →
v3.43; front-end only).** The owner-only Activity log `#logsPanel` keeps its centered floating position but swaps
its opaque `var(--surface)` fill for the **glass treatment** Credits uses on its pop-out **Controls** panel:
`background: color-mix(in srgb, var(--surface) 52%, transparent)` + `backdrop-filter: blur(16px)`, `border: 1px
solid color-mix(in srgb, var(--border) 70%, transparent)`, `border-radius: 12px`, softer `box-shadow: 0 14px 38px
rgba(0,0,0,.4)`, plus `overflow:hidden`. **Untouched:** owner-gate, secret-scrubbing, ring buffer, Copy-all,
✕/toggle wiring, closed-by-default. **Marquee header wrap bug — root cause found & fixed:** Marquee alone carries a
**global `button { width:100% }`** rule (line ~94). In the log header's flex row that gave Copy-all and ✕ a
full-container flex-basis, squeezing the `flex:1` title to ~0 width so its text wrapped one word per line. Setting
`flex:0 0 auto;width:auto` on those two buttons (now applied to all four apps for parity) restores content-width
buttons, so the title takes the remaining space and renders on one line; title `<b>` also got `min-width:0` for
narrow screens. **Decision (noted):** mirrored Controls' 52% surface opacity exactly; 16px blur keeps the log
legible. Verified: no leftover old panel style; div-balanced (323/323); glass `#logsPanel` ×1.

**Phase 5 — Activity log open/closed persists across the suite via a shared cookie (footer v3.43 → v3.44;
front-end only).** Added a small parent-domain preference cookie so the Activity log's open/closed state follows
the user between apps. `setLogPref(v)` writes `msuite_activity_log=<v>; domain=.isaiahsmithfilms.com; path=/;
max-age=2592000 (30d); SameSite=Lax`; `getLogPref()` reads it with **`split(';')` + `trim()` + `indexOf(...)===0`**
(no regex per house rule; prefix-collision-safe). `openLogs()` now sets the cookie to `1`; the hamburger
toggle-closed path and the ✕ both set it to `0`. **On load:** `if (getLogPref() === '1') openLogs();` — auto-opens
**only** when the cookie explicitly says open, so a fresh visitor or an explicitly-closed one stays closed (no
auto-open regression). Owner-gating still governs the data (`/api/logs` unchanged, fail-closed); the cookie only
controls open/closed. `localStorage` NOT used (per-subdomain). **Decision (noted):** cookie is not `Secure` — works
on the HTTPS subdomains via the `.isaiahsmithfilms.com` scope, no-ops on localhost (graceful). Verified: extracted
log `<script>` `node --check` ✓; 12/12 logic tests pass (incl. fresh→closed, `=0`→closed, `=1`→open, prefix-collision).

**Phase 6b — filter benign ResizeObserver-loop noise from the log (footer v3.44 → v3.45).** Added `if (msg &&
(""+msg).indexOf("ResizeObserver loop") !== -1) return;` at the top of the client-error net's `report()` so the
benign "ResizeObserver loop completed…/limit exceeded" browser quirk never reaches the Activity log. `indexOf`, no
regex (house rule). (6a's `querySelectorAll`-on-null bug is MSM-only — confirmed the pattern isn't present here.)
Verified: extracted net `node --check` ✓; filter present ×1; 6/6 filter logic tests pass.

**Phase 8 — Made-for-Kids / comments / notify / embeddable wiring (footer v3.45 → v3.46, server APP_VERSION 0.48 →
0.49).** Traced all three layers; the four toggles were **dropped at every one** (same shape as the scheduling bug):
- **Client:** `getKids/getComments/getNotify/getEmbed` were declared **local** to `initUploadOptions()`, so `save()`
  persisted them to localStorage but the actually-sent `readUploadOpts()` (a sibling top-level fn) never saw them
  and omitted them — "saved locally but never sent." *Fix:* hoisted `var getKids, getComments, getNotify, getEmbed;`
  to the shared top-level scope (next to `getSchedule`); init now only **assigns** them; `readUploadOpts()` now
  sends `opts.kids/comments/notify/embeddable` (defensive `typeof …==='function'` guards; safe defaults kids=false,
  others=true).
- **Server sanitizer:** `sanitizeUploadOpts()` returned only 7 fields — **stripped** all four. *Fix:* it now
  validates + returns `kids/comments/notify/embeddable` with the same safe defaults (unset ⇒ today's behavior
  exactly).
- **Server `videos.insert`:** `status.selfDeclaredMadeForKids` was **hardcoded `false`** (ignored the user),
  `embeddable` was never set, `notifySubscribers` was never passed. *Fix:* `selfDeclaredMadeForKids: o.kids`,
  `status.embeddable: o.embeddable`, and `notifySubscribers: o.notify` as a **top-level insert param** (not inside
  `status`). Diagnostic log extended to print madeForKids/embeddable/notifySubscribers.
- **Comments — flagged, NOT wired (API limitation):** per-video comment enable/disable is **not settable via Data
  API v3 `videos.insert`** (it's a channel default / Studio setting). The value is still saved/sent, but the server
  intentionally does **not** apply it and says so in a code comment. Comment policy is set in YouTube Studio.
- **Made-for-Kids (COPPA) — deliberate-choice guarantee:** it now reflects the user's explicit toggle, defaulting to
  **No (not for kids)** only when truly unset (matching prior behavior + the UI default); it is **never** silently
  set to Yes. Live YouTube confirmation is Isaiah's post-deploy.

Verified: end-to-end path (client toggle → `readUploadOpts` → POST `/api/transfer` body → route passes `req.body` →
`sanitizeUploadOpts` → `videos.insert`) traced in code; `node --check` server.js ✓ + main inline `<script>` ✓;
single `var getKids` decl; div-balanced (323/323); no dup IDs.
## Scheduled-upload fix — publishAt was never sent (2026-07-01) — footer v3.39 → v3.40, APP_VERSION 0.47 → 0.48

**Root cause (confirmed, not guessed):** a JS scoping bug, not the sanitizer and not the force-private override —
both of those were already correct. `getSchedule` (the Schedule toggle's state-getter, returned by `bindToggle()`)
was declared with `var` **inside** `initUploadOptions()` only. `readUploadOpts()` and `scheduleError()` are
sibling top-level functions in the same `<script>` block, but `var` is function-scoped — so their reference to
`getSchedule` resolved to nothing (`typeof getSchedule === 'undefined'`), meaning `on` was **always `false`**.
Result: `scheduleAt` was never attached to the `/api/transfer` payload, no matter what the user picked, and
`scheduleError()`'s friendly past/missing-time validation never fired either. This is exactly why Studio showed
Private with no scheduled time regardless of the dropdown — the schedule data never left the browser.

**Fix (client, surgical):** moved `var getSchedule;` to the shared top-level scope (declared once, right before
`readUploadOpts()`), and `initUploadOptions()` now **assigns** the existing outer variable instead of
re-declaring a shadowing local (removed `getSchedule` from its own `var` list). `getKids`/`getComments`/
`getNotify`/`getEmbed` untouched — they're only used inside `initUploadOptions()`'s own `save()`.
- **🔵 Flagged, not fixed (out of scope):** those four toggles (kids/comments/notify/embeddable) are saved to
  `localStorage` as device defaults but were **already** never read by `readUploadOpts()` or sent to
  `/api/transfer`, and `sanitizeUploadOpts()`/`transferToYouTube()` never apply them either — so they're
  currently dead UI, same class of gap as the old schedule/playlist one from Phase E, but separate from this
  bug (they don't share `getSchedule`'s scoping issue) and outside this task's ask. Worth a future pass if
  Isaiah wants "made for kids" / comments / notify / embeddable actually wired into the upload.
- **Server-side (already correct, unchanged):** `sanitizeUploadOpts()` already allow-lists `scheduleAt`
  (future-only, normalized to UTC ISO via `.toISOString()`), and `transferToYouTube()` already builds `status`
  with the dropdown privacy first, then forces `privacyStatus:"private"` + attaches `publishAt` **after**, right
  before `videos.insert` — correct order of operations, correct RFC 3339 UTC format. Nothing here needed a fix.
- **Added a diagnostic log line** right before `videos.insert`: `console.log("[transfer] outgoing status ->
  privacyStatus:", status.privacyStatus, "| publishAt:", status.publishAt || "(none)")` — not a secret, safe to
  log. This will show the real outgoing values in the Render log on the next live test.
- **Verified:** `node --check` ✓; inline scripts parse ✓; an isolated Node harness mirroring the exact scope
  shape proves the fix (closed→no `scheduleAt`, toggled-on+future-time→`scheduleAt` present, toggled-off→gone
  again); a server-logic harness re-confirms all 5 cases (public+future→forced private+publishAt, private+
  future→private+publishAt, no-schedule→dropdown honored/no publishAt, past-time→ignored, garbage→ignored);
  **live-verified in a real browser via Preview** — clicking the actual Schedule toggle + setting a real future
  time in `#optScheduleAt` now produces `readUploadOpts().scheduleAt` as a valid ISO/RFC3339 UTC string
  (previously always absent), `scheduleError()` now genuinely validates (previously always null), and toggling
  off correctly removes `scheduleAt` again. `/api/transfer` still behaves exactly as before when unconfigured.
- **🔵 Test scheduled upload after deploy; check Render log for the printed `publishAt`** — confirm YouTube
  Studio now shows Private **with** a scheduled go-live time (not just Private), and that it flips Public on
  its own at that time.
## Phase F log viewer — close (✕) fix + "Activity log" rename (2026-06-30) — footer v3.38 → v3.39, APP_VERSION 0.46 → 0.47

**Fix (front-end only):** the log panel's `✕` was dead + the panel auto-opened, because `#logsPanel` had both
`hidden` AND inline `display:flex` (inline `display` overrides the UA `[hidden]{display:none}` rule, so toggling
`hidden` did nothing). Switched show/hide to `style.display` (markup ships `display:none` = closed by default;
open → `flex`, ✕/toggle → `none`); the hamburger item is now a real toggle. Renamed **"Error log" → "Activity
log"** (heading + `fm-item`) and softened the descriptor + empty-state to "recent activity". Copy-all/gate/
scrubbing/buffer untouched. Verified: `node --check` ✓, no dup IDs, no stray "Error log", served panel ships
`display:none`, `/api/logs` still 403 (fail-closed). (Same one-line mechanism live-verified in MSM via Preview.)
## Polish Round 2 + YouTube Reconnect (2026-06-30)

**Phase A — `uncaughtException` → exit-and-restart (footer v3.33 → v3.34, server APP_VERSION 0.41 → 0.42).**
After an uncaught exception the process may be in an undefined state, so on Render the safe pattern is log →
alert → `process.exit(1)` and let the platform auto-restart clean. The `uncaughtException` handler now logs +
fires the rate-limited Resend alert (via `logError`, which now **returns** the alert promise — additive), then
exits, **racing the alert against `setTimeout(bail, 2500)`** (first to settle wins; `exited` flag → exactly one
exit). The timer is **not `unref`'d** so it deterministically forces exit(1). **`unhandledRejection` unchanged**
(log + alert, stays alive). Double-alert prevented by the existing 1-email-per-5-min rate-limiter. Verified:
`node --check` ✓; isolated harness proves exit(1) on fast (~35ms) and hung (~2.5s) paths; server boots,
`/api/status` + normal requests succeed, logs clean.

**Phase B — "How It Works" standardization (footer v3.34 → v3.35, APP_VERSION 0.42 → 0.43).** Converted the
inline `#helpPanel` to match Credits' dismissible-card design: added a **`✕` close button** (`#helpPanelClose`)
and a bold **`<h3>How It Works</h3>`** heading; the panel already used the token-driven `.helppanel` card so no
restyle was needed (added `position:relative` for the close button). The **first paragraph now leads with
"Magic Marquee uploads a finished film…"** (was "Upload a finished film…"). The **"Part of the Magic Suite"**
block is kept. The hamburger item was relabeled **"❔ How it works" → "❔ How It Works"** (still proxies the
header `#helpBtn`). Verified: `node --check` ✓, inline scripts parse ✓; booted and confirmed the heading, close
button, Magic-Marquee-led first paragraph, hamburger item, Suite block, and footer v3.35 all render.

**Phase C — N/A.** Marquee is the **reference** for the loading bar (top progress bar + button busy-states);
left untouched per the task. (MSM/Reel/Credits replicated it.)

**Phase D — "Reconnect YouTube" button + DB token persistence (footer v3.35 → v3.36, APP_VERSION 0.43 → 0.44).
🔴 SENSITIVE — review the OAuth/token diff closely before pushing.**
- **In-app reconnect:** `/auth` (already had `access_type=offline` + `prompt=consent` — both required for a
  refresh token on re-auth) now also sets a **CSRF `state`** nonce in a short-lived httpOnly `SameSite=Lax`
  cookie and echoes it in the auth URL. `/oauth2callback` **verifies the state (timing-safe, length-guarded so
  it can't throw) BEFORE exchanging the code, and fails closed** (400) on any mismatch.
- **Token persistence (no more pasting into Render):** `/oauth2callback` now captures the refresh token and
  **persists it to Postgres** (new `yt_oauth` singleton table) via `saveOAuthCreds()`; on startup
  `loadOAuthCreds()` reads it **DB-first, falling back to the `YT_REFRESH_TOKEN` env var** (so an existing
  deployment keeps working until the first in-app reconnect). The in-memory `refreshToken` is updated live.
  **The refresh token is NEVER returned to any client** — the old success page that *displayed the token for
  manual copy* was removed; the new page shows only a success boolean. (Verified by an adversarial review: no
  response/redirect/cookie/log/error path exposes the token.)
- **redirect_uri NOT hardcoded:** still `REDIRECT_URI = BASE_URL + '/oauth2callback'` from env
  (`BASE_URL`/`RENDER_EXTERNAL_URL`), so it always matches an authorized entry.
- **UI:** a standing **"↻ Reconnect YouTube"** card (always visible — moved out of `#statusCard`, which hides
  when ready, so the owner can re-link proactively before a token expires) + a friendly **`invalid_grant`**
  message (`isYtAuthError`/`ytReconnectHtml`) that replaces the raw error with a Reconnect prompt (covers both
  the upload's `job.error` and the no-token 401). House-rule safe (no `\uXXXX`, no regex backslashes — `indexOf`).
- **🔵 BY-HAND PREREQUISITE (Isaiah's, not code):** the Google **consent screen must be in Production** and the
  **redirect URI the app sends must be registered** in Google Cloud Console, or any captured token still
  expires in ~7 days. (Per the task header this is already done — consent in Production, `YT_REFRESH_TOKEN`
  refreshed — so this builds on a working connection; flagged so reconnect keeps working.) Also ensure
  `SESSION_SECRET` stays set in prod so `/auth` is never anonymous (it's gated by the SSO when set).
- **Adversarial security review run (4 lenses + verification): 0 confirmed critical/high/medium issues.**
  Accepted low-risk notes (no change for this single-user tool): refresh token stored as plaintext in Neon
  (same trust boundary as the `YT_REFRESH_TOKEN` env var); `loadOAuthCreds` runs only at boot (fine for a
  single Render instance; re-read per-upload if ever horizontally scaled); `Secure` cookie flag derives from
  `x-forwarded-proto` (reliable on Render).
- **Verify:** `node --check` ✓; inline scripts parse ✓; no dup IDs ✓; booted — `/auth` 500s only when
  `CLIENT_ID` unset, `/oauth2callback` 400s on missing code AND on **state mismatch** (CSRF fail-closed proven),
  Reconnect card + helpers + footer v3.36 serve. **Live OAuth round-trip not testable in the sandbox** (no
  Google creds) — Isaiah verifies the end-to-end reconnect after deploy.

**Phase E — wire Schedule + Playlist into the upload (footer v3.36 → v3.37, APP_VERSION 0.44 → 0.45).** Both
were dead UI; now fully wired. Both depend on a valid token, so **live upload can't be tested in the sandbox** —
verified the wiring + validation; Isaiah tests after deploy.
- **Schedule:** `readUploadOpts()` now sends `scheduleAt` only when the toggle is **On** and a **future** time
  is picked, converting the local `datetime-local` value to a **UTC ISO string** (`new Date(v).toISOString()`).
  `sanitizeUploadOpts()` re-validates server-side (must parse and be >1 min in the future, else ignored).
  `transferToYouTube()` sets `status.publishAt` AND **forces `status.privacyStatus = "private"`** (YouTube
  ignores `publishAt` unless private — the video auto-goes-public at the set time). A UI note
  (`#optScheduleNote`, shown when Schedule is On) says exactly that. A friendly **`scheduleError()`** blocks the
  upload with a message if Schedule is On but the time is missing/invalid/past. **No schedule set ⇒ identical
  to before** (privacy follows the dropdown, no `publishAt`). Sanitizer unit-tested (future kept, past/garbage
  dropped).
- **Playlist:** the **text input is now a `<select>`** populated from a new owner-gated endpoint
  **`GET /api/youtube/playlists`** (`playlists.list`, `mine=true`, paginated, capped at 200) + a ↻ refresh
  button; `loadPlaylists()` fills it best-effort on load. After a **successful** upload, if a playlist is
  chosen, `playlistItems.insert` adds the video — **inside its own try/catch so a playlist failure NEVER fails
  the upload** (recorded as `job.playlistAdded`/`job.playlistError` and surfaced separately in the result).
  **Unset = no playlist add** (current behavior). The playlist id is allow-listed (`[A-Za-z0-9_-]{12,64}`) +
  HTML-escaped in the option text (split/join, no regex). Sanitizer unit-tested (valid kept, evil/short
  dropped).
- **🔴 SCOPE CHANGE — requires RE-AUTH:** `playlists.list` + `playlistItems.insert` need more than the
  upload-only scope, so I added **`https://www.googleapis.com/auth/youtube`** to `SCOPES`. **Uploads keep
  working on the existing token**, but the **playlist dropdown stays at "None" and playlist-add fails until
  Isaiah clicks "Reconnect YouTube" once** to grant the new scope (`prompt=consent` re-prompts). The dropdown
  and the post-upload add both **degrade gracefully** without it. Flag this for Isaiah.
- **Verify:** `node --check` ✓; inline scripts parse ✓; sanitizer unit tests pass; booted —
  `/api/youtube/playlists` 401s without a token (token-guarded), the playlist `<select>` + refresh button +
  schedule note + `loadPlaylists`/`scheduleError` all serve, footer v3.37. House-rule safe (no `\uXXXX`, no
  regex backslashes — `indexOf`/char-classes/split-join).

**Phase F — owner-only error-log viewer (footer v3.37 → v3.38, APP_VERSION 0.45 → 0.46). 🔴 SENSITIVE.** Ported
the **reviewed** MSM pattern: capped `RECENT_ERRORS` (200) fed by `logError` + `/api/client-error` via
`pushError()`; the **hardened `scrubSecrets`** scrubs at write time; all buffer ops `try/catch`-wrapped.
- **Owner-only, FAIL CLOSED:** `GET /api/logs` returns **403 unless `msmAuthed(req)`** (valid non-guest SSO).
  No `SESSION_SECRET` → `msmAuthed` false → **denies** (verified 403 locally). The route is not in
  `isPublicSuitePath`, so the SSO gate guards it too; the in-handler check is the real gate.
- **UI:** "📋 Error log" `fm-item` in the hamburger opens `#logsPanel`, fetches `/api/logs`, renders via
  **`textContent`**, newest first, **Copy all** copies the scrubbed text. (The fast-menu's proxy loop ignores
  the item since it has no `data-proxy`; my own handler opens the panel + closes the menu.)
- **Verify:** `node --check` ✓; inline scripts parse ✓; booted — `/api/logs` **403 without SSO (fail closed)**,
  menu item + panel serve, footer v3.38. (Same hardened scrubber as MSM, unit-tested there.)

## Suite Bulletproofing, Fixes & Improvements (2026-06-30) — server v0.39 → v0.40, UI v3.29 → v3.30

**Repo hygiene first:** Marquee had **no `.gitattributes`** while `core.autocrlf=true` (the regex-backslash
hazard the house rules warn about). Added the canonical `* -text` `.gitattributes` (own commit). Verified the
committed `server.js` keeps its backslashes intact.

**Phase 1 fix:** Title descender clip — added `padding-bottom:.16em; margin-bottom:-.16em` to `.brand .wm`.
Zero layout shift. (UI footer v3.29 → v3.30.)

**Phase 2 — Bulletproofing.** All additive; no behavior change on success.
- **Async route wrapper** installed right after `app = express()`: every handler's throw/rejection is forwarded
  to the error middleware. Arity preserved. Pattern validated in isolation.
- **Global error-handling middleware** (after all routes): logs + alerts, calm HTML / `{error}` JSON.
- **Process nets:** `uncaughtException` / `unhandledRejection` log + alert and keep the server alive.
- **Network resilience:** new `fetchWithTimeout()` wraps **every raw outbound fetch** — Anthropic (×2), OpenAI
  transcription, OpenAI image generate/edit, Resend (8s), and the MSM bridge (12s, **retry once** — idempotent
  GET). Default ceiling is a **generous 120s** so long-but-valid AI / image-gen calls are never cut short, but
  a truly hung upstream is still aborted. **R2 (AWS SDK)** and **YouTube (googleapis)** calls keep their own SDK
  timeouts/retries — deliberately not wrapped.
- **Error logging + email alerts:** `logError()` + `sendErrorAlert()` email Isaiah via the existing Resend
  setup (`FEEDBACK_TO`, else `CALLSHEET_FROM` address), **rate-limited to one per 5 min**. No-op if unset.
- **Client-side net:** early inline script catches `window.onerror` + `unhandledrejection`, never blanks the
  page, best-effort reports to **`POST /api/client-error`** (added to `isPublicSuitePath` so it works even if
  the SSO cookie has lapsed).

**Validation:** `node --check server.js` ✅; index.html inline scripts parse + tags balanced ✅; **booted the
real server** (deps installed locally, lockfile not committed) — `/api/status`, `/`, `/api/client-error`(public,
logged), `/api/msm/projects`(503 w/o bridge) all behave correctly. ⚠️ No live YouTube/R2 creds this session —
spot-check a real upload + an AI metadata/enhance run.

**Phase 3 — Accent picker hidden (UI v3.30 → v3.31).** Hid the `🎨 Accent color` fast-menu item via
`.fm-item[data-proxy="accentBtn"]{display:none}`. The accent system is untouched — the saved accent still
applies on load; only the picker control is gone. (The header `#accentBtn` was already `display:none`.)

**Phase 4 — Upload Options tab: FOUND MIS-WIRED, now fixed (UI v3.31 → v3.32, server v0.40 → v0.41).**
- **Finding:** The Upload options tab (privacy, category, tags, license, language, *schedule*, *playlist*)
  was **dead UI**. `initUploadOptions()` saved those values as on-device defaults, but the upload path never
  sent them: `startTransfer()` POSTed only `{key,title,description}`, `/api/transfer` read only those three,
  and `transferToYouTube()` **hardcoded** `privacyStatus:"private"` + `categoryId:"1"`. So every upload went
  out private / Film & Animation regardless of what the user picked. (Title + description, on the Publish tab,
  *were* correctly wired.)
- **Fix (wired through, with validation):** `startTransfer()` now sends `privacy, category, tags, license,
  lang`; `/api/transfer` forwards the body; the worker runs them through a new **`sanitizeUploadOpts()`**
  allow-list (privacy ∈ public/unlisted/private, license ∈ youtube/creativeCommon, category ∈ the 14 listed
  IDs, lang matches `[a-zA-Z-]{2,10}`, tags split/clamped to ≤30 items & ≤480 chars). **Every field falls back
  to the old `private` / category-1 / no-tags behavior when missing or invalid**, so an upload that doesn't
  change anything behaves EXACTLY as before. Unit-tested the sanitizer (empty→defaults, valid→passthrough,
  malicious→defaults: all pass). Help text updated to "private draft by default (change visibility… under
  Upload options)".
- **⚠️ BEHAVIOR CHANGE for Isaiah to review before push:** privacy is now honored — if a user explicitly
  selects **Public** or **Unlisted**, the video uploads that way (previously always private). The default is
  still private, so nothing changes unless the control is deliberately used. Flagging because a public upload
  is outward-facing / hard to reverse.
- **🔵 FLAGGED — not yet wired (left as-is, need dedicated work + live testing):** the **Schedule**
  (`optScheduleAt`) and **Playlist** (`optPlaylist`) controls still have **no effect**. Scheduling needs
  `status.publishAt` (ISO, privacy forced private until the time) and playlist needs a separate
  `playlistItems.insert` call after the video is created — both have API nuances I didn't want to ship blind
  while the live upload is broken by `invalid_grant`. Recommend wiring + testing these once the token is fixed.
- **invalid_grant (unchanged, as the brief notes):** the live upload's token failure is a **Google Cloud
  Console** fix (publish the OAuth consent screen to Production, add the `…/oauth2callback` redirect URI,
  re-authorize, update `YT_REFRESH_TOKEN`), **not code**. The wiring above is verified by inspection + a local
  boot (the endpoint accepts the new body and guards cleanly); a real end-to-end upload still needs the token.

## Phase 1 (2026-06-26) — switcher + accent. Review & push when ready.

### 1A · Two-way switcher
Added **Credits** as a destination in the header switcher (`public/index.html`): `&middot;` dot + `<a ... data-app="credits">Credits</a>` after Marquee, matching the existing entry shape. Generic hostname snippet, so it's a normal link in Marquee — no JS change.

Footer version bumped `v3.22` → `v3.23`.

### 1B · Accent — **no change needed**
Marquee's suite identity accent (`:root --accent` and the `mp_accent` default) is **already blue `#2f80ff`**, the new target. No accent edit required.

**Note (code vs. the old CLAUDE.md table):** CLAUDE.md used to list Marquee as orange `#f45911`, but the code was already blue — the rotation was partly applied earlier. Code wins; left blue. ✅ CLAUDE.md accent table now updated across all four repos to match.

### Note on the orange `#f45911` still in the file
Several `#f45911` orange instances remain in `index.html` — but these are **thumbnail-design feature colors** (the "Brand" border preset, the star glyph, the "Bold Punch" look, `borderCustom`), not the suite accent. Correctly left untouched.

### Validation
- Switcher: 1 Credits entry; anchors/spans/nav/div/button all tag-balanced ✅
- No deploy — yours to push.

---

## Phase 2 (2026-06-26) — header → fast menu (Marquee). Review/test/push.

**Goal:** top-right shows only the **app switcher + a hamburger (☰)**; everything else lives in the ☰ menu. Footer `v3.23` → **`v3.24`**.

### What was up top, and where it went
Marquee's top-right (`.hbtns`) had the **switcher** + three buttons: **Help `?`**, **Accent 🎨**, **Theme 🌙**. Marquee had no existing menu, so I built one (its own, themed with Marquee's vars).

Used the **proxy pattern** (same as MSM): the three real buttons stay in the DOM but are hidden (`display:none`); the new ☰ menu's items call each real button's `.click()`. So all existing behavior is **unchanged**:
- ❔ **How it works** → toggles the help panel (still renders in normal flow below the header).
- 🎨 **Accent color** → opens the accent-swatch popover (unchanged).
- 🌙/☀️ **Dark/Light mode** → flips theme; the menu label syncs to the current theme each time the menu opens.
- ↩ **Log out** → grayed-out, disabled placeholder (Marquee is a satellite; real sign-out is Suite Pass / MSM's job).

### Result
Top-right now = **switcher + ☰** only. On phones (≤560px) the switcher + ☰ wrap to their own row under the brand (Credits-style).

### Validation
- Both inline `<script>` blocks `node --check`'d ✅
- Tag-balance (a/span/nav/div/button) all balanced ✅
- ⚠️ Couldn't run a live browser this session (Chrome extension not connected). **Please device-test** on desktop + iPhone Safari portrait: open ☰, confirm Help panel, Accent swatches, and Dark/Light all still work from the menu, the switcher still hops to all four apps, top-right shows only switcher + ☰, and Log out reads grayed/un-clickable.
- No deploy — yours to push.

---

## Unified header + logo badge task (2026-06-27) — Marquee. v3.24 → v3.25.

Applied the **same canonical header** as the other apps (`public/index.html`):
- **Part 1:** converted the old `.hrow`/`.hbtns` one-row header into the canonical `<header>` —
  two rows (badge + `Magic Marquee` wordmark; then the switcher), full-width divider underneath
  (Marquee was **missing** the divider — now added). Hamburger pinned top-right (absolute). The
  hidden proxy buttons + `#fastMenu` stay as header children; `#accentPop`/`#helpPanel` still
  render below the header in normal flow (unchanged).
- **Part 2:** boxed logo badge — `.brand-badge` (30×30, 1.5px blue border, dark fill) with an
  inline-SVG **play triangle** in the accent color. Wordmark unified to 27px (blue gradient kept).
- **Part 3:** mobile (≤560px) centers brand + switcher; hamburger stays top-right.
- **Part 5:** the ☰ Dark/Light item now flips in place and **keeps the menu open**. ⚠️ Subtlety:
  Marquee uses the *proxy* pattern (the menu item `.click()`s the hidden real `#themeToggle`), and
  that synthetic click bubbles to the close-on-outside-click handler — so it would slam the menu
  shut. Fix: re-open the menu immediately after the proxied click (synchronous, no flicker). (Same
  fix applied to MSM, which is also proxy-based; Reel/Credits move the toggle *into* the menu so
  they never had the problem.)
- Part 4 N/A (Marquee is blue, already correct).

**Validation:** both inline scripts `node --check`'d ✅; tags balanced ✅; no `.hrow`/`.hbtns`/
`.star` leftovers. ⚠️ Couldn't run a live browser — please device-test on desktop + iPhone Safari
portrait: badge renders, two-row + divider, mobile centered, ☰ → Help panel / Accent swatches /
Dark-light (menu stays open) all work, switcher hops all four apps.

---

## Suite consistency pass (2026-06-27) — Marquee. v3.27 → v3.28.

Aligning Marquee to MSM as the gold reference (suite-wide pass; full audit in repo-root
`MSM-Studio-Suite/NOTES.md`). Header structure was already unified — switcher refined only to kill
the bounce (below).

**Width (the reported "doesn't stretch as wide"):** `.wrap` max-width 540 → **860** (MSM column),
gutter moved onto `.wrap` (`padding:0 22px 80px`), `body` horizontal padding zeroed. Marquee now
expands/contracts like the other three.

**Scrollbar (was absent):** added MSM's thin/translucent custom scrollbar block.

**Dark tokens → MSM values:** `--bg #1a1a1c`, `--surface #252528`, `--field #2e2e32`,
`--border rgba(255,255,255,.14)`, `--text #ececec`, `--text-soft #9a9a9e` (were all a few points
off). `--chip` left (app-specific, ≈ MSM `--pick-bg`).

**Cards:** radius 16 → 12, removed the `box-shadow`. Removed `body.dark .card{background:transparent;
border-color:transparent}` so dark cards show `--surface` + border like MSM (they were invisible/flat
in dark before). NOTE: this visibly raises every card in dark mode — that's the MSM look; please eyeball.

**Buttons:** base radius 11 → 10, padding 11×18 → 12×22, added the missing `:hover{opacity:.9}`.
`a.btn` matched. **Gray disabled fixed:** `.secondary` was a solid `var(--border)` gray fill (so the
default-disabled "Generate title & description" read as a gray box) → now transparent + 1px border +
accent text (MSM outline), disabled reads as a dimmed outline.

**Header bounce (the reported "shifts a little when selected"):** matched `.msuite-switch` to MSM
exactly (`inline-flex`, link `color:var(--text)`+`opacity:.55`, dot `opacity:.3`) AND added a
zero-height bold `::after` ghost (`content:attr(data-label)`) to every link so each reserves its
**bold** width permanently — the active app going bold no longer reflows the row. Inactive links stay
weight 400 (MSM look); added `data-label` to the four links.

**Footer:** rebuilt to MSM's `.foot/.foot-brand/.foot-ver` markup — `Isaiah Smith Films · Magic
Marquee v3.28`, 12.5px, margin-top 40px, letter-spacing .02em, bold brand, tabular version (was a
bare inline `Magic Marquee · v3.27`, 12px). Version 3.27 → **3.28**. (Server `APP_VERSION="0.39"` is
an internal log version, unrelated to the UI footer — left alone.)

**Validation:** both inline `<script>` blocks parse ✅; `node --check server.js` ✅; tags balanced
(div/button/nav/header/select/a) ✅. ⚠️ No live browser this session — please device-test desktop +
iPhone Safari portrait: width at narrow→wide, dark cards (now raised), disabled "Generate" button
(dimmed outline, not gray), switcher does NOT shift when on the Marquee host, scrollbars.

**Flagged for a follow-up (not touched — risk/needs browser):** several inline-styled inputs in the
logo/template panels (some built in JS) hardcode `color:#fff; background:rgba(255,255,255,.06);
border:rgba(255,255,255,.14)` → invisible in light mode and bypass the tokens. Should be swapped to
`var(--text)/var(--field)/var(--border)` in a focused pass with a browser to verify each panel.

No deploy — yours to push.
