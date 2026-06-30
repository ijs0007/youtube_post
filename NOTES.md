# Magic Marquee — handoff notes

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
