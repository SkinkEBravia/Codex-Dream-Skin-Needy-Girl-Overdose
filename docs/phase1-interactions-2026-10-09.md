# Phase 1 interaction measurement — 2026-10-09

Phase 1 adds controlled browser interaction benchmarks and a passive Windows
native recorder. It does not change the installed skin or clean up runtime code.
The pinned original and pre-clean sources remain those in the
[Phase 0 source lock](../benchmarks/phase0/baselines.json).

## What typing simulation can measure

Directly changing editor text exercises mutation observers, selectors, style,
layout and paint scheduling. It bypasses keyboard dispatch, default editing,
the editor's real input handlers and the OS IME. Those costs are useful to
isolate, but cannot establish real keyboard latency.

The controlled fixture instead uses Chromium-generated trusted keyboard events
for one first key and 200 paced characters. A separate direct-mutation case and
untrusted composition case expose the difference. The passive native recorder
observes human typing in the actual composer without reading or saving text.
Neither path measures physical keyboard-to-display delay.

The probe keeps three distinct distributions:

- **Keydown dispatch proxy:** browser event timestamp to the capture listener.
  This excludes subsequent editing and rendering work.
- **Input-to-two-animation-frames proxy:** input capture to two frame callbacks.
  This observes scheduling and intervening work, without proving presented pixels.
- **Event Timing:** browser-reported interaction duration where emitted. The
  observer requests the 16 ms reporting threshold; durations have 8 ms
  granularity. Missing entries are unavailable, not zero or a proven upper bound.
  Keyboard events belonging to the same interaction are deduplicated.

The [Event Timing specification](https://www.w3.org/TR/event-timing/) limits
these measurements to trusted events. Synthetic `dispatchEvent` composition
does not become trusted by reproducing the same DOM changes. Local observed
durations are not population INP. The tool withholds p95 below 100 observations.

## Controlled fixture

The fixture has a 1200 × 800 viewport, 160 messages per page, 16 wrapper levels,
120 sidebar rows, two retained pages and a Changes pane. It loads each pinned
version through that version's real Windows payload loader, including CSS and
artwork. Temporary payload staging and browser resources are collector-owned
and removed after completion or failure.

The unskinned `stock-fixture` control is synthetic Chromium, not a stock native
ChatGPT launch. The fixture has a contenteditable editor rather than the real
React/ProseMirror editor and fixed sidebar rows rather than native virtualization.
Session transitions toggle known A/B pages rather than loading real chats.
Results must retain those distinctions.

The nine scenarios cover first key immediately after an A-to-B ready transition,
first key after 1000 ms idle, 200 keyboard inputs, direct DOM mutation,
synthetic composition, A-to-B-to-A switching, dock scrolling, transcript
scrolling and dark-to-light-to-dark appearance. Scrolling verifies five
240-pixel displacements from zero. Appearance verifies settled skin classes.
Saved-theme switching, cold native startup and native background behavior are
explicitly not applicable to this fixture.

The 40 ms typing cadence is a driver wait after each completed keyboard command.
Actual browser event spacing includes command processing and is exported
separately. Command round-trip time is not reported as input latency.

## Collected typing baseline

The primary collection completed two warmups and ten measured trials for each
of the three variants: 180 observations, all valid, including 6000 measured
trusted character inputs in the steady-typing scenario. Node 24.17.0 and
headless Chrome 154.0.8037.98 ran on Windows x64 at scale factor 1. The native
app uses Chromium 155; these fixture timings are not native timings.

The table reports medians of ten measured trial medians, in milliseconds:

| Input-to-two-frame scheduling proxy | Unskinned fixture | Original skin | Pre-clean skin |
| --- | ---: | ---: | ---: |
| First key immediately after switching | 21.60 | 83.15 | 18.75 |
| First key after 1000 ms idle | 11.05 | 5.60 | 5.85 |
| Steady 200-character typing | 16.35 | 16.00 | 15.90 |

The immediate first-key range was 82.60–91.50 ms for original and 15.30–30.60 ms
for pre-clean. The median paired pre-clean-minus-original change was −64.40 ms.
The same first-key work window had median style recalculation of 79.75 ms
versus 1.76 ms, while script duration was approximately 1.2 ms for both.
Observed Event Timing trial medians were 96 ms versus 24 ms, with entries in
all ten trials. This supports a reduced style cost in this switch/input fixture.
It does not attribute the change to one individual patch or establish GPU cost.

The steady-typing paired proxy change was only −0.18 ms, and its observed
Event Timing trial median was 24 ms for both skins. The idle first-key proxy
had a +1.35 ms paired change. Neither case establishes an improvement; the
fixture does not reproduce a remaining steady-typing delay. Direct mutation
and synthetic composition produced no trusted input timing in any variant.

First-key distributions have ten trials, so no first-key p95 is claimed.
Per-trial typing p95 requires at least 100 observed inputs; an Event Timing
p95 describes only emitted entries above its reporting threshold.

The second collection covers four surface scenarios with the same trial counts.
Across both collections there are 324 valid observations including warmups,
270 measured trial summaries and no rejected observations. The public
[numeric aggregate](../benchmarks/phase1/interactions-win11.json) includes
paired changes, spread, action counts, actual keyboard cadence, work counters,
gauge endpoints, payload/artwork identities and separate idle collector controls.
Actual typing cadence averaged about 46.5 ms across measured trial medians.

Median style recalculation work, in milliseconds, over each complete action
sequence and its 160 ms settle window was:

| Surface scenario | Original skin | Pre-clean skin |
| --- | ---: | ---: |
| A-to-B-to-A switching | 453.01 | 248.90 |
| Five dock wheel inputs | 11.81 | 11.26 |
| Five transcript wheel inputs | 1.65 | 1.58 |
| Dark-to-light-to-dark appearance | 974.72 | 788.03 |

The switching action/frame proxy had a −259.30 ms median paired change.
That proxy includes automation overhead and both transitions, rather than
measuring native session-load latency. Dock scrolling had a +1.20 ms paired
proxy change; transcript scrolling −6.40 ms; appearance −15.15 ms despite
both complete appearance sequences taking approximately 3.8 seconds.
These cases do not establish a frame-rate or scrolling-smoothness improvement.
They retain neutral/negative findings and identify residual switching and
appearance style work for subsequent diagnostics.

The eight idle collector-control windows reported no script or style work and
0.22–0.676 ms of task work per 250 ms window. Four windows had the probe on and
four off. The small idle sample is not an estimate of typing or native overhead.

Run two bounded collections, sequentially, with Node 22+ and Playwright:

```powershell
$env:PLAYWRIGHT_MODULE_PATH = '<installed Playwright module path>'
$env:DREAM_SKIN_BROWSER_EXECUTABLE = '<installed Chromium executable>'
node tools/benchmark-interactions.mjs --fixture --output .local-evidence/phase1-primary.json --trials 10 --warmups 2 --scenario first-key-immediate,first-key-idle,steady-typing,dom-mutation,synthetic-ime
node tools/benchmark-interactions.mjs --fixture --output .local-evidence/phase1-surfaces.json --trials 10 --warmups 2 --scenario session-switch,dock-scroll,transcript-scroll,appearance
node tools/summarize-interactions.mjs .local-evidence/phase1-summary.json .local-evidence/phase1-primary.json .local-evidence/phase1-surfaces.json
```

Create the ordinary output directories first. Output files must be new files;
the collector refuses overwrites and redirected destinations. Each collection
has a ten-minute deadline. Variant order rotates across trials; two warmups per
variant are excluded from the ten measured trials. Paired comparisons use
matching trial indices. The summary rejects invalid or duplicated trials,
source/workload changes, nonfinite metrics and unsupported p95 claims.
Choose new output names when repeating a collection. Review the local summary
before copying an aggregate to the public benchmark directory.

## Passive native recorder

The Windows entry point reuses Store package, Windows session, root-window and
loopback CDP identity validation. The selected native renderer must be visible
and pass structural app checks. It does not launch, restart, focus, navigate,
type into or submit anything in the app. It preserves the active skin watcher.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File windows/scripts/record-performance-baseline.ps1 -DurationSeconds 75 -Scenario typing -Output .local-evidence/phase1-native.json
```

Bring the native chat renderer to the foreground before starting. After the
fixed readiness message, perform the scenario manually using a disposable
draft. Closing or hiding the native renderer invalidates a foreground trial.
A manual scenario label does not verify the number or completion of session
switches. The first key means the first observed key in the labeled trial;
it does not automatically identify every first key after switching.

The recorder accepts 30–120 seconds, observes only composer inputs, caps sample
storage and checks numeric context/health every two seconds. Counters are
sampled at endpoints. That polling adds some recorder overhead, which is not
removed from reported timings. Cleanup removes only its owned probe and CDP
connections. If its child is terminated, probe listeners self-expire within
five seconds of the requested recording duration.

Reports contain timing numbers, fixed labels and coarse validation facts.
No typed characters, draft text, DOM snapshots, titles, URLs, private paths,
account/session IDs or screenshots are exported. Keep native reports under
ignored `.local-evidence/`; review and sanitize any later public aggregates.
Zero observed inputs means no native typing evidence, not zero latency.

## Automated native switching and typing

The optional Windows macro runs bounded, targeted CDP input through the same
native identity checks. It calibrates visible pinned-chat rows and the composer
from live DOM rectangles, switches up to three pinned chats, then records one
first key and a separate paced draft of 1–200 characters. It never submits the
draft. The fixed ASCII text is generated by the controller, not supplied in the
plan. A nonempty initial draft is rejected. Cleanup clears only a matching owned
draft, releases tracked keys and mouse buttons, and restores the initial chat.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File windows/scripts/run-performance-macro.ps1 -Plan .local-evidence/native-plan.json -Output .local-evidence/native-result.json
```

Create a local plan using schema `dream-skin-native-macro-plan/2`, with the
current CSS viewport, `pinnedClicks`, `typingCharacters`, `typingCadenceMs`,
`scrollInputs`, `scrollPixels`, `scrollCadenceMs`, `routeIdleMs`, `cycles` and
`timeoutMs`. Parameters are strictly bounded; no arbitrary text, coordinates
or selectors are accepted. Use `scrollInputs: 0` for switching/typing until
native transcript scrolling is validated. See the
[automation handoff](handoff-2026-10-09-native-automation.md) for current evidence
and remaining native validation.

Each typing phase requires observed trusted keydown and input counts to match
its requested character count. Missing events invalidate the run; Event Timing
may still be unavailable because it is thresholded. This is trusted Chromium
input in the real editor, not physical Windows keyboard or OS IME input.

P1's measurement tools and controlled fixture evidence are ready for submission.
The plan's full native comparison exit condition remains open: controlled
stock/original/pre-clean trials, corrected workload smoke, and real interruption
recovery have not yet been collected. This submission neither establishes a new
native performance gain nor completes issue #1.

## Observed native typing trial

A timed foreground trial covering the user's agreed 14:11 local interaction
window completed for 120.02 seconds in app 26.1002.7124.0 with the skin active.
The recorder observed 99 trusted keydowns and 85 input events, with no dropped
samples, dropped correlations or pending frame samples. Native identity and
pause state were preserved; collector cleanup was confirmed. Raw numeric
records remain local and are not committed.

The first recorded input had a 240.90 ms input-to-two-frame proxy. Its associated
Event Timing observations reported 248 and 344 ms; the initial keydown capture
delay was 4.10 ms. This is the first input of the recording, rather than a
verified first input after every session switch.

Across the whole manual trial, keydown-dispatch median was 2.70 ms and maximum
165 ms; input-to-two-frame median 21.50 ms and maximum 257.70 ms. Event Timing
reported 160 correlated samples after interaction-ID deduplication, with an
observed median of 32 ms and maximum 720 ms. Some entries lack interaction IDs,
so that count is not 160 distinct keystrokes. These entries are thresholded
observations, not an uncensored keystroke distribution or population INP.
No p95 is claimed for the 99-keydown or 85-input proxy distributions.

The complete mixed-activity window contained 22.31 seconds of style
recalculation, 8.50 seconds of script work and 0.53 seconds of layout work.
Those duration counters overlap with task work and must not be summed. They
include manual switching, conversation updates and collector overhead; they
cannot be attributed solely to typing or to one skin rule.

This trial demonstrates remaining native input delay despite the fixture's
near-neutral steady typing. Low initial dispatch delay and much later frame /
Event Timing completion make post-dispatch editing/rendering work a useful
next diagnostic target. They do not establish a specific selector, paint effect
or cache as the cause. Native stock/original/pre-clean comparison and isolated
selector/paint diagnostics are still needed for causal attribution.

Earlier attempts were retained locally: a completed 75-second trial had no
typing, confirmed by the user; another was rejected when the renderer became
hidden after two seconds. Neither is treated as a typing result.

## Validity and diagnostic boundaries

Work metrics use same-document endpoint deltas for style/layout counts and
script/layout/style/task durations, with CDP seconds explicitly converted to
milliseconds. Heap, node and listener counts remain endpoint gauges.
Overlapping duration counters must not be added together.

The harness rejects document-epoch changes, counter decreases, backgrounding,
collector expiry/overflow, pending samples, incomplete actions and unmet
readiness. Missing supported metrics remain null. Runtime/classifier/predicate
instrumentation is collected where that version exposes it; absent older
instrumentation is expected.

Two alternating 250 ms unskinned idle off/on controls observe idle collector
work. They do not establish per-keystroke or native overhead. Expensive selector
statistics and advanced paint diagnostics belong in separate runs because
[Chrome documents their recording overhead](https://developer.chrome.com/docs/devtools/performance/selector-stats).

Regression tests induce a 60 ms input handler and require the probe to
distinguish it from a warmed control. Other tests cover privacy, strict numeric
export, lifecycle cleanup, metric units/reset handling, missing events, full
pinned payloads, completed actions and Windows PowerShell 5.1 parsing.

Validation completed: 136 portable/Windows Node tests passed, zero failed,
and 12 optional browser tests were skipped in the general suite. The induced
60 ms handler detector passed separately in actual Chrome. Full pinned-payload
browser tests passed, and both actual ten-trial CLI collections completed with
every scenario valid. JavaScript syntax, Phase 0 source-lock consistency and
runtime asset-sync checks passed. No macOS native test or hosted CI success
is claimed; the runtime and generated platform assets were not changed.

Native stock/original/pre-clean comparisons, OS IME, cold startup, saved-theme
switching, GPU presentation and macOS behavior remain separate validation work.
This harness-only phase does not resolve or close issue #1.
