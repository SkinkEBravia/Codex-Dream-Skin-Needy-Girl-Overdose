# Native automation checkpoint — 2026-10-09 (updated after CDP fix)

The CDP controller is fixed and smoke-validated against the live Windows Codex
client (26.1002.7124.0, store package, managed session on port 9335). The
readiness flag is enabled (`NATIVE_MACRO_READY = true` in
`tools/benchmark-native-macro.mjs`). The passing smoke report is
`.local-evidence/native-macro-report.json` (local only, never committed).

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
   always recoverable. Logically held keys are released best-effort.
5. Plan schema is now `dream-skin-native-macro-plan/2`: numeric scenario
   parameters plus `pinnedClicks` (1–3); `scrollInputs: 0` skips the timed
   wheel phases so the smoke plan runs exactly the requested scenario
   (sidebar to top → each pinned conversation once → composer focus → preset
   text, never submitted).

## Verification status

- Mocked actor tests (`tools/benchmark-native-macro.test.mjs`): 7 passing,
  including a scripted-renderer happy path, deadline expiry during an owned
  draft, and interrupt-during-draft recovery.
- Adjacent suites (`native-macro-wrapper`, `benchmark-interactions`,
  `record-native-interactions`, `interaction-probe`): 30 passing.
- Live smoke on the real app: completed with 3 pinned switches (verified via
  the sidebar `aria-current="page"` /
  `data-app-action-sidebar-thread-active="true"` marker), first key, 8 preset
  characters, cleanup confirmed, draft and initial route restored. Post-run
  guard diag: editor empty, no residue.
- Not yet done: paired skin-on/off trials with the passive recorder, and the
  recovery scenarios on the real app (deadline/interrupt live).

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
