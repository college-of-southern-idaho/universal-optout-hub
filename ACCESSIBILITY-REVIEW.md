# Accessibility Review — Operator Console (WCAG 2.1 AA)

A **source-level** accessibility review of the operator console (`web/index.html`,
`web/app.js`, inline CSS) against **WCAG 2.1 AA**, with the fixable findings applied.

**Scope & limits.** This is a code review, **not** a formal audit. It does not
replace a **browser-automated scan** (axe/Lighthouse) run against the authenticated
console, **assistive-technology testing** (screen reader / keyboard-only), or a
**VPAT** — those remain tracked separately. The console is an **internal,
staff-facing** admin tool (not student- or public-facing).

## Already conformant (verified in source)

- `<html lang="en">`, a meaningful `<title>`, and a zoom-friendly viewport (no
  `user-scalable=no`) — 3.1.1, 2.4.2, 1.4.4.
- Interactive controls are real `<button>`s (keyboard-operable) — 2.1.1.
- Nearly all form controls have an associated `<label for>` (or wrapping `<label>`)
  — 1.3.1, 3.3.2.
- Data tables use `<th>` headers — 1.3.1.
- Status is conveyed by **text + shape** (badge label + solid/hollow provenance dot),
  not color alone — 1.4.1.
- Primary buttons use **dark text on the gold accent** (brand layer), and `summary`
  toggles use ink — the light-gold-on-white contrast trap is avoided — 1.4.3.
- No `outline: none` — keyboard focus is never suppressed.
- The spinner and mode banner are already `role="status"` live regions and the
  spinner honors `prefers-reduced-motion`.

## Findings fixed in this change

| Finding | WCAG SC | Fix |
|---|---|---|
| No "skip to content" bypass | 2.4.1 (A) | Added a `.skip-link` (hidden until focused) targeting `<main id="main-content" tabindex="-1">` |
| No visible keyboard-focus style on custom-styled controls | 2.4.7 / 1.4.11 (AA) | Added `:focus-visible` outline — dark ring on the light UI, light ring on the dark header (both ≥3:1) |
| Toast notifications not announced | 4.1.3 (AA) | `#toast` → `role="status" aria-live="polite"` |
| Form success/error "flash" messages not announced | 4.1.3 / 3.3.1 | Added `role="status"` to all flash containers (13 static + the dynamic review flash) |
| Decorative SVG icons exposed to AT | 1.1.1 (A) | `aria-hidden="true"` on all 21 `svg.ic` (each paired with visible text) |
| Search / API-key inputs had a placeholder but no programmatic name | 1.3.1 / 3.3.2 / 4.1.2 | `aria-label` on the matrix search and the two API-key inputs |
| "Unknown" status badge low contrast (~3.9:1) | 1.4.3 (AA) | Darkened badge text `#6c7681` → `#566069` (≈4.8:1) |
| Decorative "live" ping animates regardless of motion prefs | 2.2.2 / 2.3.3 | Disabled the ping under `prefers-reduced-motion: reduce` |

## Fixed from the axe DevTools scan (2026-09-22)

An axe DevTools pass on the **authenticated** console (every view: login, matrix,
approvals, simulate, alerts, system, reports, audit, topology, services, users,
settings, appearance) found 8 distinct rule violations — all fixed:

| axe rule | WCAG SC | Root cause → fix |
|---|---|---|
| `aria-required-children` (critical) | 1.3.1 / 4.1.2 | The top nav was `role="tablist"` holding dropdown menus, not tabs. **Converted the top nav to a proper navigation landmark** (`<nav aria-label="Primary">`); the tab buttons became plain buttons using `aria-current="page"`. |
| `aria-allowed-attr` (critical) | 4.1.2 | The `.dropbtn` menu buttons carried `aria-selected` (invalid on a button). **Removed** it; they keep `aria-haspopup`/`aria-expanded`. |
| `region` (moderate) | 1.3.1 | Nav content wasn't in a landmark (the tablist role had overridden `<nav>`), and the login overlay wasn't in one. Fixed by the nav-landmark change + giving the login overlay `role="dialog" aria-modal="true" aria-labelledby`. |
| `color-contrast` (serious) | 1.4.3 | Readiness "warn"/"pass"/"manual" text used header-pill colors (bright amber/green) on the white System card. **Re-pointed to the darkened `--warn`/`--in`/`--ink-soft` tokens** (AA on white). |
| `empty-table-header` (minor) | 1.3.1 | Seven dynamically-built tables had an empty action/mark `<th>`. Added a visually-hidden name (`.sr-only`) to each. |
| `select-name` (critical) | 4.1.2 | The per-user role `<select>` had no accessible name. Added `aria-label="Role for <username>"`. |
| `label` (critical) | 1.3.1 / 4.1.2 | The category cascade-matrix checkboxes had no label. Added a descriptive `aria-label` per cell. |
| `label-title-only` (serious) | 3.3.2 / 4.1.2 | The protected-category cascade checkboxes were labeled only by `title`. Added an `aria-label`. |

The **top-nav rework** resolves the "tab/menu ARIA model" item previously deferred
to the formal audit. The Reports/Services **sub-tabs** remain genuine `role="tab"`
tablists (valid — they have real tab children) and were left as-is.

## Open — for the formal VPAT

- **Screen-reader and keyboard-only** walkthroughs of the real workflows (axe covers
  automated checks only — ~30–40% of WCAG).
- **VPAT** produced from the combined automated + manual results.

*Complements `SECURITY-REVIEW.md`; tracked separately (Accessibility audit & VPAT).*
