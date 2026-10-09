# Native automation checkpoint — 2026-10-09 (updated after CDP fix)

The CDP controller is enabled (`NATIVE_MACRO_READY = true` in
`tools/benchmark-native-macro.mjs`). Commit `fb8ba2b` passed a short live Windows
Codex smoke (26.1002.7124.0, Store package, validated managed session).
Its report is `.local-evidence/native-macro-report.json` (local only, never
committed). The submission corrections below passed regression tests; their
updated workload has not yet been smoke-tested in the native app.

## What was wrong and how it was fixed

1. Route surface selection. The shell keeps a hidden first `main` with zero
   search units, and the only `[data-app-shell-active-page="true"]` element is
   invisible (0×0), so the old `route()` resolved to `null`. The guard now
   selects the visible `main` that owns the composer editor, preferring one
   with message units.
2. Coordinate calibration. Fixed plan points went stale between sessions
   (observed editor rect moved from x≈364 to x≈490 between checkpoints). The
   plan no longer carries points; the guard computes the composer, pinned-row,
   dock and transcript points from live DOM rectangles each step, inside the
   plan-pinned viewport (1707×1019 CSS px, dpr 1.5 on the reference machine).
3. Empty-conversation identity. A fresh chat has zero
   `data-content-search-unit-key` units and no scrollable transcript; route
   identity now falls back to the active sidebar row's `aria-label`, which
   never crosses CDP.
4. Cleanup after deadline expiry. The action path keeps the deadline gate; the
   cleanup path (`clearOwned`, key release, route restore, probe/guard removal)
   uses raw bounded CDP calls that bypass `checkDeadline`, so an owned draft is
   recoverable when the guard still confirms draft ownership. Held keys and
   mouse buttons are tracked and released through bounded raw calls; failed
   releases prevent confirmed cleanup. Cleanup keys use the same tracking.
5. Plan schema is now `dream-skin-native-macro-plan/2`: numeric scenario
   parameters plus `pinnedClicks` (1–3); `scrollInputs: 0` skips the timed
   wheel phases so the smoke plan runs exactly the requested scenario
   (sidebar to top → each pinned conversation once → composer focus → preset
   text, never submitted).

## Submission corrections

The review found that the 54-character preset truncated a 200-character plan,
and the steady phase skipped its first character after clearing the first-key
draft. The controller now repeats the fixed ASCII preset to the requested
length and types all requested steady characters. First-key remains a separate
one-character phase. Each typing phase must observe exactly the requested
trusted keydowns and input events; matching draft text alone is insufficient.

Mouse release now runs even when an action is interrupted after mouse-down.
Restoration clicks use the same tracked helper, and final cleanup retries failed
releases. Ctrl+A and Backspace are tracked too. An already-cleared owned draft
is recognized if interruption occurs between Backspace and its key-up.

## Verification status

- Mocked actor tests (`tools/benchmark-native-macro.test.mjs`): 17 passing,
  including exact 1/54/200 steady-character counts, missing trusted input,
  mouse-down interruption/deadline, failed restoration release, persistent
  release failure, and interruption during cleanup keys.
- Six-suite regression run: 50 passing, no failures; two opt-in Chromium
  cases passed separately (induced-delay detection and full pinned payload
  fixtures). Windows PowerShell 5.1 parsing and wrapper checks passed.
- Asset sync passes on the canonical committed file tree. This checkout's
  direct sync check reports a pre-existing LF/CRLF difference between
  `tools/css-predicate-cache.mjs` and its three generated copies. All four
  files match HEAD after newline normalization; this submission changes none
  of them. JavaScript syntax and diff whitespace checks pass.
- Prior live smoke on commit `fb8ba2b`: completed with 3 pinned switches (verified via
  the sidebar `aria-current="page"` /
  `data-app-action-sidebar-thread-active="true"` marker), first key, 8 preset
  character request, cleanup confirmed, draft and initial route restored.
  Review showed the steady phase actually observed seven inputs, with one
  separate first-key input. This smoke verifies short switching/typing and
  restoration, not the corrected 200-character workload. Post-run guard diag:
  editor empty, no residue.
- Not yet done: live smoke of the submission corrections, paired native
  variant trials, and recovery scenarios on the real app (deadline/interrupt).

## Open items for the interaction benchmark

- Transcript wheel behavior needs its own study before timed scroll phases run
  against the real app: an `absolute inset-0 cursor-interaction` button
  overlays the transcript, small wheel deltas at the top boundary were
  swallowed, and Windows 11 elastic overscroll produced negative scrollTop
  (−599.3 observed). Evidence: `.local-evidence/transcript-probe2.mjs`,
  `transcript-wheel-probe.mjs`.
- The sidebar dock scrolled 1:1 with wheel input and restored exactly; only
  the transcript misbehaved.

Local identities, plans and diagnostics stay in ignored `.local-evidence/`;
do not commit private app state or raw native traces.
