# Pre-cleanup audit — 2026-10-09

This document records the working baseline and cleanup candidates before any
cleanup is implemented. It contains source-level findings and validation
summaries, not private traces, screenshots, application state, or credentials.

## Baseline

- Branch: `codex/adapt-current-ui`.
- Audited source commit: `ac0cc83415deef4df7dbc77cd31be3e4abf7391f`.
- Upstream baseline: `10acfa0a29d9c44e91a53bdc6bebaa42e7adf955`, version 1.5.20.
- Changes already implemented:
  - `265841b`: reduce renderer scans and CSS invalidation.
  - `dd04153`: adapt modern Changes panels and edited-file cards.
  - `ac0cc83`: theme native Changes toolbar capsules.
- The audit found specific redundancy, but no evidence supporting wholesale
  repository corruption or deletion of large renderer/injector functions.
- No cleanup, version bump, or release is part of this audit.

The most recent local validation of this baseline passed 113 Node tests with
10 optional browser cases skipped in that run. A separate opt-in Chromium run
passed all four modern-review cases. Generated asset synchronization, all
three platform payload checks, and Windows atomic patch/exact rollback checks
also passed. Native macOS build and UI validation were not performed on the
Windows host. These results describe the existing baseline; they do not
validate a future cleanup.

The Changes panel body, edited-file cards, and both toolbar capsules were
verified in the live Windows renderer. The toolbar adaptation replaces native
gray gradients and 24px backdrop blur with purple paint and cyan/pink edging,
while preserving control geometry and green/red counts. The existing blinking
animation source and its visibility/reduced-motion gates remain intact.

## How the skin runs

1. The Windows launcher starts the official registered app with loopback remote
   debugging and a managed non-default profile
   ([launcher](../windows/scripts/start-dream-skin.ps1), lines 414–418).
2. A separate hidden Node watcher connects to the verified browser identity and
   eligible renderer targets. It assembles a payload from renderer JavaScript,
   CSS, validated theme data, and artwork
   ([injector](../windows/scripts/injector.mjs), lines 808–910).
3. CDP sends source text through `Runtime.evaluate`; early reload support uses
   `Page.addScriptToEvaluateOnNewDocument` (injector lines 456–462 and 1172–1176).
4. Injected JavaScript runs inside the application renderer. Observers and
   schedulers maintain component markers and decorative DOM as the UI changes.
   CSS matching, layout, paint, and scripting share renderer resources with
   user interaction.

The watcher reuses `loadedPayload` between updates, checks source stamps, and
performs a strong theme audit every 30 seconds. It does not rebuild and inject
the full payload on every keystroke (injector lines 1918 and 1944–1964).
Its `new Function(payload)` call is a compile-only syntax check in Node whose
result is discarded; it does not transfer compiled bytecode into Chromium.
Official app binaries, signatures, protected installation files, and ACLs
are not modified by this mechanism.

## Confirmed redundancy and cleanup candidates

Line references below describe the audited source commit.

| ID | Finding and evidence | Proposed treatment | Confidence and scope |
| --- | --- | --- | --- |
| C1 | Exact sticky-composer fade CSS block appears twice in [runtime/dream-skin.css](../runtime/dream-skin.css), lines 1368–1375 and 1491–1498. Selectors and declarations are identical and both blocks are top-level. | Remove the earlier duplicate after cascade and visual regression checks. | Confirmed duplication; negligible expected performance benefit. This canonical base CSS is generated for macOS, not the separate Windows base CSS. |
| C2 | Seven custom properties have no repository-internal readers: `--ds-accent-soft` and `--ds-highlight` (base CSS lines 25/27), `--angel-card-surface` (1613), `--angel-sidebar-surface` and `--angel-hud-surface` (2121/2122), and `--angel-line`/`--angel-shadow` ([extension CSS](../runtime/internet-angel-extension.css), lines 10/12). | Check older trusted themes and external compatibility assumptions before removing definitions. | Confirmed unused internally; not proof that every external theme ignores them. Negligible expected performance benefit. |
| C3 | Windows payload assembly replaces three `__DREAM_SKIN_{CSS,ART,THEME}_JSON__` tokens (injector lines 874–876) absent from the shipped [Windows renderer](../windows/assets/renderer-inject.js). The real tokens at renderer line 2626 are `__DREAM_{CSS,ART,THEME}_JSON__`. | Remove the no-op aliases if alternate-template support is not an intentional contract. Keep literal-safe replacement functions and syntax validation. | Confirmed no-ops for the shipped template; low-risk, small cleanup. |
| C4 | Windows `fallbackTargets` stores Boolean values, but reads only membership with `.has(id)` (injector lines 1823, 1897/1901, 1995/1997, 2071). `attachLoadFallback(id, target, session)` at line 1893 does not use `target`. | Use membership-only bookkeeping and remove the unused argument while preserving current behavior. | Confirmed redundant data/argument. Load-event replay itself is intentional and explicitly required by [bootstrap tests](../windows/tests/injector-bootstrap.test.mjs), lines 238–240. |
| C5 | Operation-status helpers are byte-identical across Windows (1328/1337/1346), macOS (1110/1119/1128), and Linux (963/972/981) injectors. Static-asset cache helpers are identical in macOS (866/883) and Linux (739/756). | Generate shared implementations or stage a shared helper; preserve real platform differences. | Confirmed repetition; maintainability benefit, moderate packaging/integration risk. |
| C6 | Runtime dependency inventories recur in [common-windows.ps1](../windows/scripts/common-windows.ps1) line 469, [build-release.ps1](../windows/installer/build-release.ps1) line 372, [setup-bootstrap.ps1](../windows/installer/setup-bootstrap.ps1) line 112, [build-quickfix-patch.ps1](../tools/build-quickfix-patch.ps1) lines 27/38, and [patch-dream-skin.ps1](../windows/scripts/patch-dream-skin.ps1) line 269. | Define one inventory contract with explicit installer/runtime/quick-fix subsets. | Confirmed maintenance duplication. Different scopes are intentional; do not replace them with one blindly identical list. |
| P1 | Base renderer, predicate cache, and Internet Angel extension maintain separate observers and refresh scheduling. The [shared extension](../runtime/internet-angel-extension.js), lines 793–819, runs all component classifiers per full refresh. Optional surface scans at lines 668/681/689 search broad sets of buttons, divs/spans, and editors. | Profile shared scheduling, affected-surface refreshes, and native-anchor gating for optional scans. | Confirmed overlapping work; performance candidate, not dead code. Route mounts, visibility, selection, popovers, and IME behavior need regression coverage. |
| P2 | Some surfaces retain both JavaScript markers and structural CSS detection paths. | Map each fallback to supported app versions and measured usage before consolidating selectors. | Candidate only. A selector unused in one screenshot is not dead across routes or versions. |
| P3 | [Canonical renderer](../runtime/renderer-inject.js) refreshes predicates at line 124 and again during initial `ensure` (1083/1208). Ornament maintenance runs during `ensure` (1086) and an 850ms timer (1243); the same pass repeats home-route queries (968–970 and 1043–1045). | Remove redundant initial work, share resolved landmarks per pass, and investigate event-driven maintenance with a retained recovery fallback. | Confirmed overlap; startup/readiness and DOM-replacement checks required. Canonical-only changes will not automatically accelerate the separate Windows base renderer. |
| P4 | Windows rereads five static assets on payload rebuild (injector lines 817–822) and extracts the trusted predicate manifest during assembly (846–850). macOS/Linux already cache static assets. | Add correctly invalidated asset caching and generate mode-specific stable manifests during packaging. | Startup/theme-switch opportunity; little expected direct typing benefit. |

## Precompilation assessment

Build-time selector substitution and predicate-manifest extraction already
exist in [sync-runtime-assets.mjs](../tools/sync-runtime-assets.mjs), lines
27–60. The stable Windows predicate manifest and static assets are useful
candidates for further preparation or caching.

Minifying JavaScript/CSS can reduce payload size and parsing work.
Compilation caching can reduce repeated script initialization. Neither removes
the continuing cost of DOM queries, CSS matching, layout, paint, or visual
effects. Earlier local traces showed substantial style and layout work during
laggy interactions; they do not establish that compilation is the dominant
remaining bottleneck.

Primary references:

- [V8: code caching for JavaScript developers](https://v8.dev/blog/code-caching-for-devs)
- [Chrome: minimize main-thread work](https://developer.chrome.com/docs/lighthouse/performance/mainthread-work-breakdown)

A startup optimization should be benchmarked separately from typing and
session-switch performance. No speedup percentage is claimed by this audit.

## Cleanup boundaries and suggested sequence

The sequence was revised after reviewing
[fork issue #1](https://github.com/SkinkEBravia/Codex-Dream-Skin-Needy-Girl-Overdose/issues/1).
See the [measurement-first cleanup and enhancement plan](cleanup-enhancement-plan-2026-10-09.md)
for scenario definitions, exact baselines, export boundaries and acceptance
criteria. The findings above remain a record of the original audited source.

1. Freeze the pre-clean baseline and build a reproducible benchmark before
   applying cleanup. Separate first-letter latency, steady typing, IME,
   session switching, scrolling, theme changes and startup.
2. Apply small confirmed C1/C3/C4 cleanups and compatible C2 definitions.
   Check functional behavior and before/after measurements without promising
   a speedup from removing small redundant statements.
3. Use measured evidence to prioritize P1 scheduling/scans, P2 selector work,
   and active paint costs. Change one mechanism per experiment and retain
   negative results.
4. Evaluate P3/P4, constructed stylesheets and compilation preparation against
   their actual startup/rebuild or interaction costs. Consolidate C5/C6
   helpers and inventories separately. The Windows base renderer/CSS remain
   separately maintained; shared extension changes propagate through sync.
5. Confirm native app results, then publish only sanitized valid aggregates.
   Passing fixture timing or local tests alone does not establish native
   cross-platform performance or hosted CI success.

Preserve generated platform assets, independent validation/security boundaries,
Safe CSS contracts, literal-safe template substitution, content hashes,
identity checks, atomic patch/rollback, reload recovery, and animation gates.
The disabled extension path may clean up an old active extension during a
theme/mode change; omitting its payload requires lifecycle investigation.

Each implementation must pass applicable Node and PowerShell checks,
generated-asset synchronization, platform payload checks, and relevant browser
regressions. Observer or CSS changes also need real renderer checks across
typing/IME, scrolling, session switching, retained hidden pages, light/dark
appearance, menus, reload, pause/resume, and theme changes.

This is a pre-cleanup record. The listed changes have not been implemented.
