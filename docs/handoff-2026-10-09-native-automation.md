# Native automation checkpoint — 2026-10-09

Real chat switching and typing tests still need an independent automation module.
The user requested this checkpoint so another session can finish that module.
The controller prototype is disabled (`NATIVE_MACRO_READY = false`) at both
entry points, before filesystem access or app input. Do not describe it as a
working macro or native benchmark.

## Saved work

- `tools/benchmark-native-macro.mjs`: unfinished fixed-plan CDP controller,
  bounded plan parser, draft/focus checks, numeric timing collection and cleanup
  scaffold. It needs live-app validation and recovery tests before enabling.
- `windows/scripts/run-performance-macro.ps1`: identity-bound launcher with
  ordinary-path checks, plan/report bounds, 180-second child timeout and
  before/after package, browser, HWND, PID/start/session and pause checks.
- `tools/native-macro-wrapper.test.mjs`: seven mocked wrapper tests pass,
  including Windows PowerShell 5.1 parsing. Reparse attack tests use mocked
  metadata because sandbox junction creation was unavailable.
- `tools/benchmark-native-macro.test.mjs`: tests the disabled entry points and
  bounded argument/plan validation. It does not validate the unfinished actor.

The preceding working P1 checkpoint is `aafd42483b1e34c5788132f91065ce3fb88594bf`.
This checkpoint uses branch `codex/adapt-current-ui` on the
`SkinkEBravia/Codex-Dream-Skin-Needy-Girl-Overdose` fork.
Its fixtures and passive recorder remain unchanged. The installed skin/runtime
were not modified. No macro typing, session switching, prompt submission, PR,
merge, version bump or release was performed in this checkpoint.

## What the independent module must resolve

1. Calibrate fixed points in native renderer coordinates. The observed Windows
   screenshot and renderer viewport differ: the renderer reported 1707 × 1019,
   and its editor rectangle was approximately x=364.44, y=921.33, w=712, h=44.
   The screenshot-derived composer point did not hit that editor.
2. Select the active chat surface rather than the first `main`. The first main
   contained no editor or message units; a second main contained the editor and
   nine `data-content-search-unit-key` units. Current route tracking selects the
   wrong surface and reports unavailable. Resolve this before any switching.
3. Validate A → B → A readiness, empty drafts, focus, known test-text ownership,
   completed input counts, wheel displacement and restoration. Stop on user
   interference, changed layout, reload or unexpected content. Never send a
   prompt or clear a pre-existing draft.
4. Add meaningful actor/recovery tests, including deadline expiry during an
   owned draft and mid-scroll failures. Current cleanup can be prevented by the
   action deadline and interrupted scroll restoration is incomplete. Address
   those defects and release any pending keys/buttons after partial input
   failures before setting the readiness flag to true.
5. Replay a short bounded native smoke test, then collect paired skin-on/off
   trials with accurate automated-input provenance. Keep screenshots outside
   typing windows; report actual cadence, Event Timing thresholds and proxies.

The native helper successfully accepted a focus click, but no test character
was entered. Earlier wording that the skill guidance was an immutable permission
block was corrected: explicit user authorization takes precedence over skill
guidance under this workspace's instructions. Do not evade actual tool/API
rejections or security controls. The independent module should use the existing
verified debugging connection and normal input APIs.

Use [the P1 report](phase1-interactions-2026-10-09.md) for previous evidence:
the timed manual trial captured native input delay; automated real-app A/B
attribution remains pending. Local identities, plans and diagnostics stay in
ignored `.local-evidence/`; do not commit private app state or raw native traces.
