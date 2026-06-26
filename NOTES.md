# Magic Marquee — handoff notes

## Phase 1 (2026-06-26) — switcher + accent. Review & push when ready.

### 1A · Two-way switcher
Added **Credits** as a destination in the header switcher (`public/index.html`): `&middot;` dot + `<a ... data-app="credits">Credits</a>` after Marquee, matching the existing entry shape. Generic hostname snippet, so it's a normal link in Marquee — no JS change.

Footer version bumped `v3.22` → `v3.23`.

### 1B · Accent — **no change needed**
Marquee's suite identity accent (`:root --accent` and the `mp_accent` default) is **already blue `#2f80ff`**, the new target. No accent edit required.

⚠️ **Heads-up (code vs. the CLAUDE.md table):** the shared CLAUDE.md still lists Marquee as orange `#f45911`. The code is already blue — the rotation was apparently partly applied earlier. Code wins; left blue. Consider updating the CLAUDE.md accent table.

### Note on the orange `#f45911` still in the file
Several `#f45911` orange instances remain in `index.html` — but these are **thumbnail-design feature colors** (the "Brand" border preset, the star glyph, the "Bold Punch" look, `borderCustom`), not the suite accent. Correctly left untouched.

### Validation
- Switcher: 1 Credits entry; anchors/spans/nav/div/button all tag-balanced ✅
- No deploy — yours to push.
