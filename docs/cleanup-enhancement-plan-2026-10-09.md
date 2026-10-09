# Cleanup and enhancement plan — 2026-10-09

The next step is reproducible measurement before cleanup. Small cleanup then
establishes a simpler implementation without claiming a speedup. Each later
enhancement targets a measured cost and must preserve the existing appearance
and interaction contracts.

This plan incorporates [fork issue #1](https://github.com/SkinkEBravia/Codex-Dream-Skin-Needy-Girl-Overdose/issues/1),
reviewed on 2026-10-09 with no comments, and the
[pre-cleanup audit](pre-clean-audit-2026-10-09.md). It supersedes the audit's
original cleanup-first sequence without changing its historical findings.
The [Phase 0 checkpoint](phase0-baseline-2026-10-09.md) freezes source/workload
identities and records a limited synthetic classifier variability run. The
[Phase 1 harness](phase1-interactions-2026-10-09.md) now implements controlled
keyboard, switching, scroll and appearance fixtures plus a passive Windows
native recorder. Cleanup and enhancement experiments have not started.
Controlled native stock/original/pre-clean interaction comparisons remain pending.

## What the issue changes

The issue proposes comparable scenarios and quantified before/after results
for the predicate cache and later optimizations. Adopt that measurement-first
direction, with these corrections:

- Metric deltas explain renderer work; they do not directly establish typing
  latency, scrolling smoothness, or GPU paint cost.
- First-letter latency needs its own case. A single 200-character paste or
  fill does not exercise the same editor path as paced keyboard input.
- Pin app versions and source commits, rather than comparing moving branch
  names. A paused skin is a useful extra control, not a genuine stock launch.
- Keep timing collection lightweight and run expensive diagnostics separately.
- Commit only bounded, sanitized aggregates; keep raw native traces local.
- Preserve and report negative or inconclusive results.

The issue's statement that CI passes is not a verified baseline fact:
[PR33 CI run 37575695241](https://github.com/EmiyaKatuz/Codex-Dream-Skin-Needy-Girl-Overdose/actions/runs/37575695241)
reports `completed/action_required` as of this review. Local tests passed as
recorded in the audit. Hosted CI and native platform validation remain separate.

## Phase 0 — Freeze comparable baselines

Define these variants before collecting data:

| Variant | Definition |
| --- | --- |
| Stock-CDP | Same official app build with validated local debugging, no injected skin payload or skin watcher. This controls for collector/debugging overhead. A normal non-debug launch can be assessed separately with built-in tracing. |
| Original skin | Overdose source commit `10acfa0a29d9c44e91a53bdc6bebaa42e7adf955` (v1.5.20), rather than an unspecified fork/upstream `main`. |
| Pre-clean skin | Runtime source at `ac0cc83415deef4df7dbc77cd31be3e4abf7391f`, documented by checkpoint `284bff69ae193b457d30adb3ea84d3f88629681c`. |
| Candidate | One cleanup or enhancement commit, with the exact SHA recorded. |

Use performance-only commit
`265841ba46d1254a7bce205d0f16bcaade1aea3b` as an optional attribution variant
when separating the original performance work from modern-surface adaptations.

Record browser/Chromium and app versions, OS, viewport, scale factor,
display refresh rate where available, theme/artwork hash, system/acrylic mode,
light/dark appearance, reduced-motion setting, animation state, fixture
revision, conversation-size bucket, and visible panel state. Record coarse
environment data only; omit usernames, device names, personal paths and IDs.
Keep machine power mode and background workload comparable.

Separate cold startup from warmed interactions and theme rebuilds. Alternate
variant order to reduce warm-cache and machine-load bias. Establish baseline
variability with at least ten valid paired fixture trials after two warmups;
record actual native trial counts and classify undersampled findings as
exploratory. Preserve the first input after a session change as a measured
event, rather than discarding it as warmup.

Exit condition: repeatable scenario definitions, exact variant identities,
stable trial conditions, and a measured variability range. Historical manual
traces remain supporting evidence, not substitutes for controlled paired runs.

Current checkpoint: source variants and the existing long-chat classifier
fixture are locked, two warmup pairs and ten alternating measured pairs were
recorded, and native environment metadata was observed without changing the
installed skin. See the Phase 0 document for exact scope and results. Its
classifier timing does not satisfy Phase 1's interaction measurement gates.

## Phase 1 — Build measurement before changing runtime behavior

Plan a Node 22+ harness with two distinct modes:

1. **Controlled Chromium fixtures.** Reuse the existing production payloads
   and browser-test fixtures, extend them with long conversations, sidebar
   virtualization, retained hidden pages, Changes panes, and synthetic editors.
   Run scripted actions here without touching real user chats.
2. **Verified native renderer recording.** Reuse the project's identity-bound
   CDP connection and target validation. Initially record user-performed
   scenarios in disposable test chats without automatically editing drafts,
   sending prompts, changing routes, or restarting the app. Native measurements
   verify actual Electron/editor/GPU behavior; fixture timing is not equivalent.

The harness must not depend on ignored diagnostic scripts or introduce a new
unverified CDP discovery path. Give recording duration, trace size, target
count, and shutdown explicit bounds. Clean up only collector-owned observers,
timers, sessions and tracing; preserve the active skin watcher.

### Scenarios and outcomes

| Scenario | Fixed action and completion criterion | Outcomes |
| --- | --- | --- |
| First letter after switching | Complete a defined A-to-B session transition, then type one character; measure immediately-ready and fixed-idle-delay cases separately. | Input delay, event processing/presentation evidence where supported, editor readiness, style/layout work. |
| Steady typing | 200 paced characters at a fixed cadence in a synthetic/disposable draft; do not submit. | Per-input latency distribution and sample count, renderer work, classifier and predicate-cache activity. |
| IME | Composition start/update/end followed by committed input; real OS IME validation is separate from synthetic composition events. | Refresh suspension during composition, one bounded catch-up, input correctness and latency. |
| Session switching | Fixed A-to-B-to-A route sequence and conversation-size buckets, with the same panes open; complete when native composer and target surface are ready. | Transition latency, style/layout/script work, retained-page and resource growth across cycles. |
| Scrolling | Fixed target (project dock and transcript measured separately), pixel distance, direction, cadence and starting offset. | Frame/presentation evidence and renderer work; completion verifies the intended scroll displacement. |
| Theme changes | Fixed light/dark transition and fixed saved-theme A-to-B transition measured separately; verify applied revision and settled surface. | Apply/rebuild latency, stylesheet work, cleanup and resource growth. Stock supports native appearance changes; saved-skin-theme switching is explicitly not applicable. |
| Startup / background | Cold attach/initial paint collected separately; fixed idle and hidden-to-visible windows. | Payload build/parse cost, idle work and bounded refresh on resume. |

Never infer latency solely from input-command round-trip time. Use supported
Event Timing or bounded trace input-to-presentation evidence; report missing
events, API thresholds and unsupported metrics explicitly. A next-frame probe
is a proxy and must be labeled as such. Do not call local native samples
population INP. Report p95 only with an adequate declared sample count, and
report first-key samples separately from the 200-character distribution.

### Collection and export contract

- Feature-detect `Performance.getMetrics` names for the actual browser build.
  Take before/after snapshots in the same verified target/document epoch.
  Record deltas for counts/durations such as style, layout, script and tasks.
  Preserve source units and convert durations explicitly.
- Heap usage, node counts and listener counts are gauges: record endpoints
  and growth across repeated cycles, not purported work totals. Do not sum
  task duration with its overlapping script/layout/style subsets.
- Reject or split samples on counter reset, target change, reload,
  reconnection, backgrounding during a foreground scenario, unmet readiness,
  lost trace events, or incomplete action counts. Missing values are
  unavailable, not zero. Record rejection reasons.
- Record existing renderer/classifier/predicate metrics when present; absence
  in stock or original versions is expected and does not invalidate the run.
- Use lightweight metrics for comparisons. Run selector statistics and
  advanced paint instrumentation in separate diagnostic trials because they
  add overhead. Do not mix those timings into uninstrumented distributions.
- Export schema-versioned JSON with allowlisted variant/scenario identity,
  environment buckets, action counts, units, validity, numeric trial
  summaries and observed collector overhead. Keep content hashes only for
  fixed benchmark assets; never hash private text as an export identifier.
- Reject nonfinite numbers and bound entries/file size. Exclude conversation
  text, typed characters, DOM snapshots, titles, URLs, project/file paths,
  account/session IDs, screenshots and raw native traces from tracked results.
  Use anonymous A/B scenario labels. Results stay local until validated and
  sanitized; no placeholder success numbers are committed.

Report paired changes, medians and spread with trial counts. Set numerical
acceptance tolerances after measuring baseline variability. Timing-only
thresholds do not become CI gates until runner noise is characterized.

Exit condition: the harness distinguishes invalid runs and known induced
regressions, reproduces a baseline across trials, and yields an honest
stock/original/pre-clean comparison. A result showing no difference is valid.

Current implementation distinguishes trusted browser keyboard input from DOM
mutation and synthetic composition, detects an induced 60 ms handler, and
collects pinned original/pre-clean payloads alongside an explicitly unskinned
synthetic control. The control is not native Stock-CDP. The first repeated
typing and surface collections have ten measured trials after two warmups per
variant, with 324 valid observations including warmups and none rejected. A
timed native trial captured 99 keydowns / 85 input events and a 240.90 ms first
input-to-two-frame proxy. See the Phase 1 report for numeric results and the
native recorder's limits. Startup, saved-theme switching, native virtualization,
OS IME and controlled native variant comparisons are not covered by this fixture.
Those gaps remain validation work rather than implicit successful scenarios.

## Phase 2 — Small cleanup without a speedup claim

Implement audit C1/C3/C4 in small reviewable commits. Resolve C2's external
theme-compatibility assumptions before removing variables. Preserve the
load-event safety net, template safety and rollback behavior.

Run functional checks and the benchmark before/after. Accept maintainability
improvements with neutral timing; investigate regressions outside measured
variability. Keep this phase separate from architecture or visual changes.

## Phase 3 — Enhance one measured cost at a time

| Priority | Experiment | Required evidence and guardrails |
| --- | --- | --- |
| 1 | P1 scheduling and scans: affected-surface classification, coalesced work, read-before-write phases, hidden-document suspension and event-driven ornament maintenance. | Fewer unnecessary passes/geometry reads with improved target latency. Restore a bounded full refresh on visibility resume because disconnected observers lose mutation history. Handle retained hidden pages separately from whole-document visibility. Preserve first-key readiness, IME, reload recovery and existing animation gates. |
| 2 | P2 selector work: extend cached predicates or replace measured substring/structural hotspots with native anchors and stable markers. | Selector stats identify actual expensive matches/nonmatches. Account for JavaScript cache upkeep and attribute churn. Preserve specificity, late mounts, detached/hidden pages, cleanup and required legacy fallbacks. |
| 3 | Paint: trial pre-blurred artwork plus tint on measured expensive surfaces; trial paint containment separately on isolated decoration. | Active repaint/layer evidence identifies the cost; declaration counts do not. Compare default and custom art, light/dark, resize and movement. Containment must not clip glows, focus outlines, menus or sticky content. Keep blinking and reduced-motion behavior. Treat fake glass as a visual change requiring review. |
| 4 | P4 startup/rebuild: correctly invalidated Windows static-asset caching and generated predicate manifests. | Lower startup/theme-rebuild work with unchanged trust validation, hashes, theme/source invalidation and recovery. Do not present it as a typing fix without typing evidence. |
| 5 | Windows constructed stylesheets; minification/compile-cache experiments if parsing remains material. | Preserve cascade order, inactive-light media gating, Safe CSS, idempotent reinjection, removal and a tested fallback. Judge startup/theme-apply separately; these do not eliminate selector matching. |
| 6 | C5/C6 shared helpers and inventory contracts. | Less maintenance drift with explicit platform/subset contracts and packaging tests. Keep source generation and Windows base-runtime ownership clear; do not force unrelated platform implementations into one algorithm. |

Order priorities 1–3 using baseline evidence; move paint ahead of selectors
if the diagnostic runs identify it as the dominant cost. Reject enhancements
that add complexity without a repeatable benefit. Record negative results
with the tested scope instead of declaring an entire technique useless.

The Phase 1 fixture reduced immediate post-switch first-key style work, while
its steady-typing timing remained nearly neutral. The timed native recording
still captured substantial post-dispatch input delay and high mixed-activity
style work. Before choosing a further enhancement, isolate native style and
editing work around delayed inputs, then compare the same scenario with the
skin paused or a verified stock launch. Selector/paint diagnostics must remain
separate from lightweight timing trials. This evidence gives no reason to
prioritize precompilation as a remedy for ongoing typing delay.

## Phase 4 — Validate and publish evidence

Reuse deterministic regressions for classifier ancestor reads/IME/coalescing,
lazy panel geometry, predicate equivalence/lifecycle, rail specificity/style
invalidation, light-rule gating, and modern Changes control geometry/colors.
These already exist in `tools/*performance*.test.mjs`,
`tools/css-predicate-cache.test.mjs`, `tools/turn-rail-invalidation.test.mjs`,
`tools/internet-angel-light-gate.test.mjs`,
`tools/internet-angel-modern-review.test.mjs`, and
`windows/tests/panel-performance.test.mjs`; extend them rather than replacing
their assertions with timing-only tests.

Require applicable Node/PowerShell checks, synchronized platform assets,
payload integrity and atomic patch/rollback. For resource growth, compare
settled heap/node/listener plateaus across repeated cycles; distinguish
bounded caches and expected retained pages from sustained leaks.

Confirm targeted improvements in the real Windows app without another
scenario regressing beyond measured variability. Obtain native macOS evidence
before claiming cross-platform performance gains. Functional CI success,
synthetic performance, native verification, merge and release are separate
statuses. Do not close issue #1 on a document or harness-only commit.

Publish sanitized aggregate results and reproduction parameters beside these
docs when actual valid runs exist. Each enhancement PR should link its
before/after commits, measurements, correctness checks and limitations.
Publishing releases follows the repository's normal version/build contract.

## References

- [Issue #1: reproducible benchmark proposal](https://github.com/SkinkEBravia/Codex-Dream-Skin-Needy-Girl-Overdose/issues/1)
- [CDP Performance domain](https://chromedevtools.github.io/devtools-protocol/tot/Performance/)
- [Chrome Performance monitor](https://developer.chrome.com/docs/devtools/performance-monitor)
- [Chrome performance recording reference](https://developer.chrome.com/docs/devtools/performance/reference)
- [Chrome selector statistics and instrumentation overhead](https://developer.chrome.com/docs/devtools/performance/selector-stats)
