# Phase 0 baseline checkpoint — 2026-10-09

The source versions and one existing synthetic workload are frozen. A paired
classifier-only run establishes initial repeatability without changing the
installed skin. Real first-letter, IME, session-switch, scrolling and theme
comparisons remain Phase 1 work; no native interaction speedup is claimed.

## Source and workload lock

[baselines.json](../benchmarks/phase0/baselines.json) pins:

- Original Overdose v1.5.20: `10acfa0a29d9c44e91a53bdc6bebaa42e7adf955`.
- Performance-only fix: `265841ba46d1254a7bce205d0f16bcaade1aea3b`.
- Pre-clean runtime: `ac0cc83415deef4df7dbc77cd31be3e4abf7391f`.

Each variant includes its Git tree identity and SHA-256/size for selected shared
sources and Windows/macOS/Linux renderer, CSS, selector, theme and injector
assets. The lock contains 92 asset entries. Default Windows artwork and the
acrylic stylesheet are included; the predicate helper is explicitly absent
from the original and present in the two fixed variants.

These source commits are immutable references, not moving branch names.
Documentation checkpoint `284bff6` describes the pre-clean source.
Stock-CDP is defined as the same official app build with validated local
debugging but no skin payload or skin watcher. It has not been measured.
No cleanup/enhancement candidate is selected yet.

The locked classifier fixture has 160 synthetic messages, 40 wrappers per
message, 64 repeats of public synthetic text, 6,400 wrappers and 378,880 text
characters in a 1200×800 viewport. Its HTML SHA-256 is
`334219777b52606c664419b594269fab4fa2d783359a6c5863afa8be0837d702`.
The sampler derives this workload from the existing long-chat performance test;
it does not read user conversations or attach to the native application.

Check the lock against Git source objects:

```powershell
node tools/performance-baseline-contract.mjs --check
node tools/benchmark-baseline-classifier.mjs --check
```

The checker rejects changes to commits, assets, hashes, workload parameters,
stock-measurement claims and unexpected fields. A working-tree source edit
does not silently change the pinned baseline.

## Initial measured variability

[classifier-variability-win11.json](../benchmarks/phase0/classifier-variability-win11.json)
contains actual measured pairs and warmups, exact source/fixture hashes,
environment and scope limits. It contains no private text, native traces,
screenshots, account identifiers or personal paths.

| One synchronous classifier refresh | Original | Pre-clean |
| --- | ---: | ---: |
| Measured observations | 10 | 10 |
| Median | 26.25 ms | 8.40 ms |
| Interquartile range | 26.00–26.575 ms | 8.40–8.475 ms |
| Observed range | 25.80–26.80 ms | 8.20–8.60 ms |
| Median absolute deviation | 0.30 ms | 0.05 ms |

The median paired pre-clean-minus-original difference was −17.85 ms.
There were two additional warmup pairs (four samples) excluded from these
statistics. Pair order alternated original/pre-clean and pre-clean/original.
Each sample used a fresh isolated page; timing started after initial injection
and two animation frames and covered one explicit synchronous refresh.
No text getter instrumentation or CSS was added to the timed fixture.

Environment: Windows x64, Node 24.17.0, headless Chromium 154.0.8037.98.
This is one browser process on one host. The p95 field in JSON is an
exploratory interpolation over ten observations, not a reliable tail-latency
estimate. This measured spread is only an initial variability range for this
fixture, not a universal CI threshold.

The result supports a narrower conclusion: the fixed classifier finishes sooner
on this synthetic long-chat workload. It does not measure input delay,
first-letter presentation, editor behavior, style recalculation, GPU paint,
stock-app overhead, cross-platform performance or a new cleanup candidate.
The performance-only source is locked but was not separately sampled here.

Reproduce with an installed Playwright module and compatible Chromium:

```powershell
$env:PLAYWRIGHT_MODULE_PATH='<installed Playwright module>'
$env:DREAM_SKIN_BROWSER_EXECUTABLE='<Chrome or Edge executable>'
node tools/benchmark-baseline-classifier.mjs --output benchmarks/phase0/classifier-local.json
```

The output must be a new project-relative JSON file in an existing ordinary
directory. Existing destinations are refused. Actual timing will vary; compare
paired observations on the same environment rather than expecting these exact
milliseconds.

## Native environment observation

A bounded, read-only probe reused the project's verified managed CDP identity.
It did not type, switch chats, pause/reinstall the skin, capture screenshots,
restart the app or leave a collector running. Private connection/state data and
the full local observation remain untracked.

| Observed setting | Value |
| --- | --- |
| Official app version | 26.1002.7124.0 |
| App Chromium / CDP protocol | 155.0.8059.27 / 1.3 |
| OS | Windows build 26200 |
| Viewport / device scale factor | 1707×1019 CSS pixels / 1.5 |
| Material / appearance | System / dark, requested appearance auto |
| Reduced motion / pause | False / false |
| Artwork | Matches pinned default Internet Angel artwork |
| Installed runtime comparison | Six of seven selected files match exact Git bytes; injector differs only by CRLF line endings and matches after LF normalization |

Line-ending normalization was diagnostic only. Installer byte-hash validation
and security checks were not changed. The native app and fixture use different
Chromium builds, so fixture results are not native timing evidence.

The current live conversation and background workload were uncontrolled.
Display refresh rate, power mode, active decorative animation activity and
native latency distributions were not measured. These values must be recorded
or marked unavailable when actual native comparison trials are run.

## Phase 1 entry conditions

The source lock and this limited repeatability checkpoint are ready. The full
[cleanup/enhancement plan](cleanup-enhancement-plan-2026-10-09.md) still requires
a scenario collector before claiming a controlled interaction baseline.

Use the following fixed initial fixture parameters in that collector, with a
new fixture revision when extending the workload:

- First key: A-to-B ready transition, immediate input and a separate 1000 ms
  idle-delay case; preserve the first measured event.
- Steady typing: 200 keyboard inputs at 40 ms spacing; no paste or submission.
- Switching: A-to-B-to-A with the same seeded content and pane configuration;
  wait for native composer and target-surface readiness, with a bounded timeout.
- Scrolling: dock and transcript separately, start at zero, five 240-pixel
  downward inputs at 100 ms spacing; verify displacement and avoid clamping.
- Appearance: native dark-to-light-to-dark; saved theme A-to-B-to-A separately
  for skin variants only, with payload-revision and settled-surface checks.
- Composition/background/startup: separate scenarios with their own readiness
  and completion contract; do not blend them into warmed typing distributions.

Keep these action definitions equivalent across variants and publish a scenario
as not applicable or invalid when native UI behavior cannot satisfy them.
Synthetic keyboard/composition and scroll input are not a replacement for
user-performed native keyboard, OS IME or wheel validation.

Retain the plan's alternating paired trials, counter/gauge and document-epoch
rules, lightweight timing versus separate diagnostic runs, bounded collection
and allowlisted exports. No runtime cleanup or enhancement was performed in
Phase 0, and issue #1 remains open.

The subsequent [Phase 1 interaction checkpoint](phase1-interactions-2026-10-09.md)
adds the scenario collectors and repeated fixture evidence. It retains the
native-versus-fixture boundaries defined here; this Phase 0 lock is unchanged.
