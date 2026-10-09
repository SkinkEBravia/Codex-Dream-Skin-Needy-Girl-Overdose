import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASELINES, sha256, quantile, safeOutputPath } from "./benchmark-baseline-classifier.mjs";
import { fixtureHtml, FIXTURE_PARAMETERS } from "./interaction-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const VARIANTS = Object.freeze(["stock-fixture", "original", "preclean"]);
export const SCENARIOS = Object.freeze(["first-key-immediate", "first-key-idle", "steady-typing", "dom-mutation",
  "synthetic-ime", "session-switch", "dock-scroll", "transcript-scroll", "appearance"]);

// Stage only pinned, trusted Git objects in a fresh collector-owned directory,
// then use that version's production loader, normalization and revision code.
// No checkout, installed engine or native app is modified.
export async function loadPinnedPayloads() {
  const staging = await mkdtemp(path.join(tmpdir(), "dream-skin-interaction-"));
  const sources = {};
  try {
    for (const [label, commit] of Object.entries(BASELINES)) {
      const directory = path.join(staging, label);
      const assets = new Map();
      const stage = async (file) => {
        if (assets.has(file)) return;
        if (!/^windows\/(?:assets|scripts)\/[\w.-]+$/.test(file)) throw new Error("Pinned dependency outside Windows assets/scripts");
        const bytes = execFileSync("git", ["show", `${commit}:${file}`], { cwd: root, timeout: 10000,
          maxBuffer: 12 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
        assets.set(file, { file, bytes: bytes.length, sha256: sha256(bytes) });
        const output = path.join(directory, file);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, bytes, { flag: "wx" });
        if (file.endsWith(".mjs")) {
          const relativeImports = bytes.toString("utf8").matchAll(/\b(?:from\s+|import\s*)["'](\.[^"']+)["']/g);
          for (const [, specifier] of relativeImports) await stage(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
        }
      };
      const required = ["windows/scripts/injector.mjs", "windows/assets/selectors.json", "windows/assets/theme.json",
        "windows/assets/dream-reference.jpg", "windows/assets/dream-skin.css", "windows/assets/renderer-inject.js",
        "windows/assets/internet-angel-extension.css", "windows/assets/internet-angel-extension.js", "windows/assets/internet-angel-acrylic.css"];
      for (const file of required) await stage(file);
      const injector = await import(pathToFileURL(path.join(directory, "windows/scripts/injector.mjs")).href);
      const result = await injector.loadPayload(path.join(directory, "windows/assets"), null, "system");
      if (typeof result.payload !== "string" || result.payload.length > 24 * 1024 * 1024
        || !/^[a-f0-9]{20}$/.test(result.revision)) throw new Error("Invalid pinned production payload");
      const lock = JSON.parse(await readFile(path.join(root, "benchmarks/phase0/baselines.json"), "utf8"));
      const locked = lock.variants.find(v => v.commit === commit);
      for (const asset of assets.values()) {
        const entry = locked?.assets.find(a => a.file === asset.file);
        if (entry && (entry.bytes !== asset.bytes || entry.sha256 !== asset.sha256)) throw new Error("Pinned asset differs from Phase 0 lock");
      }
      sources[label] = { payload: result.payload, identity: { commit, material: "system", runtimeVersion: injector.SKIN_VERSION,
        payloadRevision: result.revision, payloadSha256: sha256(result.payload), assets: [...assets.values()].sort((a, b) => a.file.localeCompare(b.file)) } };
    }
    return sources;
  } finally {
    // The target is the exact absolute directory returned by mkdtemp, beneath
    // the OS temp directory with our fixed prefix; never a user-supplied path.
    if (path.dirname(staging) !== path.resolve(tmpdir()) || !path.basename(staging).startsWith("dream-skin-interaction-")) throw new Error("Unsafe staging cleanup target");
    await rm(staging, { recursive: true, force: true });
  }
}

export function variantOrder(index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid trial index");
  return VARIANTS.map((_, offset) => VARIANTS[(index + offset) % VARIANTS.length]);
}

export function parseOptions(args) {
  const options = { trials: 10, warmups: 2, scenarios: [...SCENARIOS], timeoutMs: 600000 };
  let fixture = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--fixture" && !fixture) { fixture = true; continue; }
    if (!["--output", "--trials", "--warmups", "--scenario", "--timeout-ms"].includes(name) || seen.has(name)) throw new Error("Unknown or duplicate argument");
    seen.add(name);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing argument value");
    if (name === "--output") { if (options.output) throw new Error("Duplicate output"); options.output = value; }
    if (name === "--trials") options.trials = Number(value);
    if (name === "--warmups") options.warmups = Number(value);
    if (name === "--timeout-ms") options.timeoutMs = Number(value);
    if (name === "--scenario") options.scenarios = value.split(",");
  }
  if (!fixture || !options.output || !Number.isSafeInteger(options.trials) || options.trials < 1 || options.trials > 20
    || !Number.isSafeInteger(options.warmups) || options.warmups < 0 || options.warmups > 5
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 600000
    || !options.scenarios.length || options.scenarios.some(s => !SCENARIOS.includes(s)) || new Set(options.scenarios).size !== options.scenarios.length) throw new Error("Invalid fixture options");
  return options;
}

export function distribution(values) {
  if (!values.length) return { count: 0, minMs: null, medianMs: null, p25Ms: null, p75Ms: null, p95Ms: null, maxMs: null };
  if (values.some(n => !Number.isFinite(n) || n < 0 || n > 600000)) throw new Error("Invalid duration");
  return { count: values.length, minMs: Math.min(...values), medianMs: quantile(values, .5), p25Ms: quantile(values, .25),
    p75Ms: quantile(values, .75), p95Ms: values.length >= 100 ? quantile(values, .95) : null, maxMs: Math.max(...values) };
}

const twoFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const state = page => page.evaluate(() => window.__DREAM_SKIN_FIXTURE__.state());
const runtimeMetrics = page => page.evaluate(() => {
  const clean = (obj,keys) => Object.fromEntries(keys.map(key=>[key,obj?.[key]]).filter(([,value]) => typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e12));
  return { renderer:clean(window.__CODEX_DREAM_SKIN_STATE__?.metrics,['ensureCount','ensureTotalMs','ensureLastMs','ensureMaxMs','observerBatches','observerRecords','safePartRefreshCount','safePartPruneCount','fallbackProbeCount','fallbackEnsureCount']),
    predicate:clean(window.__CODEX_DREAM_SKIN_STATE__?.predicateMetrics,['passes','writes','totalMs','lastMs','maxMs']),
    classifier:clean(window.__CODEX_INTERNET_ANGEL_EXTENSION_STATE__?.metrics,['classifyRuns','scheduleRequests','suppressedDuringComposition','markVisits','attributeWrites','attributeRemovals','totalClassifyMs','lastClassifyMs']) };
});

// The probe module is shared with passive native recording. Import lazily so
// pure option/source tests do not require a browser or install observers.
export async function runFixture({ sources, trials = 10, warmups = 2, scenarios = [...SCENARIOS], timeoutMs = 600000, slowInputMs = 0, onProgress = null }) {
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20 || !Number.isSafeInteger(warmups) || warmups < 0 || warmups > 5
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000 || !scenarios.length
    || scenarios.some(s => !SCENARIOS.includes(s)) || new Set(scenarios).size !== scenarios.length
    || (onProgress !== null && typeof onProgress !== "function")
    || !sources || Object.keys(sources).sort().join(",") !== "original,preclean"
    || Object.entries(BASELINES).some(([label,commit]) => sources[label]?.identity?.commit !== commit || typeof sources[label]?.payload !== "string")) throw new Error("Invalid fixture run");
  const probe = await import("./interaction-probe.mjs");
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, timeout: 30000,
    ...(process.env.DREAM_SKIN_BROWSER_EXECUTABLE ? { executablePath: process.env.DREAM_SKIN_BROWSER_EXECUTABLE } : {}) });
  let deadline;
  let expired = false;
  const expiry = new Promise((_, reject) => { deadline = setTimeout(() => { expired = true; reject(new Error("Fixture run deadline exceeded")); void browser.close(); }, timeoutMs); });
  const work = async () => {
    const runs = [];
    for (let trial = 0; trial < warmups + trials; trial++) {
      const warmup = trial < warmups;
      const index = warmup ? trial : trial - warmups;
      const order = variantOrder(trial);
      for (const variant of order) {
        if (expired) throw new Error("Fixture run deadline exceeded");
        const page = await browser.newPage({ viewport: FIXTURE_PARAMETERS.viewport, reducedMotion: "no-preference" });
        page.setDefaultTimeout(15000);
        let cdp;
        try {
          await page.setContent(fixtureHtml({ slowInputMs }), { waitUntil: "load", timeout: 15000 });
          if (variant !== "stock-fixture") await page.evaluate(sources[variant].payload);
          await twoFrames(page);
          await page.waitForFunction(() => window.__DREAM_SKIN_FIXTURE__.ready());
          cdp = await page.context().newCDPSession(page);
          await cdp.send("Performance.enable");
          // The interface is intentionally narrow and shared with native mode.
          await page.evaluate(probe.installInteractionProbe, { fixture: true, editorSelector: "#benchmark-editor", maxSamples: 10000, durationMs: 300000 });
          const observations = [];
          for (const scenario of scenarios) {
            await page.evaluate(() => { window.__DREAM_SKIN_FIXTURE__.resetEditor(); });
            await twoFrames(page);
            await page.locator("#benchmark-editor").focus();
            if (scenario === "first-key-immediate" || scenario === "first-key-idle") {
              await page.locator("#fixture-switch").click();
              await page.waitForFunction(() => window.__DREAM_SKIN_FIXTURE__.ready());
              await page.locator("#benchmark-editor").focus();
              if (scenario === "first-key-idle") await page.waitForTimeout(FIXTURE_PARAMETERS.firstKeyIdleMs);
            }
            const probeLabel = { "first-key-immediate": "first-key", "first-key-idle": "first-key", "steady-typing": "typing",
              "dom-mutation": "typing", "synthetic-ime": "ime", "session-switch": "switch", "dock-scroll": "scroll-dock",
              "transcript-scroll": "scroll-transcript", appearance: "appearance" }[scenario];
            const scenarioEpoch = await page.evaluate(id => window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario(id), probeLabel);
            const beforeProbe = await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot());
            const beforeMetrics = await cdp.send("Performance.getMetrics");
            const runtimeBefore = await runtimeMetrics(page);
            const before = await state(page);
            const epoch = await page.evaluate(() => performance.timeOrigin);
            await page.evaluate(() => { window.__DREAM_SKIN_FIXTURE__.actionStart = performance.now(); });
            let completion = { expectedActions: 1, completedActions: 1, displacementPx: null };
            let appearanceSettled = true;
            if (scenario.startsWith("first-key-")) await page.keyboard.press("x");
            else if (scenario === "steady-typing") {
              for (let i = 0; i < FIXTURE_PARAMETERS.typingCharacters; i++) { await page.keyboard.press("x"); await page.waitForTimeout(FIXTURE_PARAMETERS.typingCadenceMs); }
              completion = { ...completion, expectedActions: FIXTURE_PARAMETERS.typingCharacters, completedActions: FIXTURE_PARAMETERS.typingCharacters };
            } else if (scenario === "dom-mutation") await page.evaluate(() => window.__DREAM_SKIN_FIXTURE__.domMutation());
            else if (scenario === "synthetic-ime") await page.evaluate(() => window.__DREAM_SKIN_FIXTURE__.syntheticComposition());
            else if (scenario === "session-switch") {
              for (let i = 0; i < 2; i++) { await page.locator("#fixture-switch").click(); await page.waitForFunction(() => window.__DREAM_SKIN_FIXTURE__.ready()); await twoFrames(page); }
              completion = { ...completion, expectedActions: 2, completedActions: 2 };
            } else if (scenario.endsWith("-scroll")) {
              const selector = scenario === "dock-scroll" ? "[data-app-action-sidebar-scroll]" : '[data-app-shell-active-page="true"] [data-fixture-transcript]';
              await page.locator(selector).evaluate(el => { el.scrollTop = 0; });
              await page.locator(selector).hover();
              for (let i = 0; i < FIXTURE_PARAMETERS.scrollInputs; i++) { await page.mouse.wheel(0, FIXTURE_PARAMETERS.scrollPixels); await page.waitForTimeout(FIXTURE_PARAMETERS.scrollCadenceMs); }
              const displacementPx = await page.locator(selector).evaluate(el => el.scrollTop);
              completion = { expectedActions: FIXTURE_PARAMETERS.scrollInputs, completedActions: FIXTURE_PARAMETERS.scrollInputs, displacementPx };
            } else if (scenario === "appearance") {
              for (let i = 0; i < 2; i++) {
                await page.locator("#fixture-appearance").click();
                try { await page.waitForFunction(({light,skinned}) => {
                  const root = document.documentElement;
                  return root.classList.contains("light")===light && (!skinned || root.classList.contains(light?"dream-theme-light":"dream-theme-dark"));
                }, {light:i===0,skinned:variant!=="stock-fixture"}, {timeout:5000}); }
                catch { appearanceSettled = false; }
                await twoFrames(page);
              }
              completion = { ...completion, expectedActions: 2, completedActions: 2 };
            }
            await twoFrames(page);
            const actionFrameProxyMs = await page.evaluate(() => performance.now() - window.__DREAM_SKIN_FIXTURE__.actionStart);
            // Observe one bounded classifier catch-up after the action. This
            // counter window includes 160ms settle and is not input latency.
            await page.waitForTimeout(160);
            const after = await state(page);
            const afterMetrics = await cdp.send("Performance.getMetrics");
            const snapshot = await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot());
            const sameEpoch = await page.evaluate(expected => performance.timeOrigin === expected, epoch);
            const reasons = [];
            if (!sameEpoch) reasons.push("document-epoch-change");
            if (snapshot.visibilityInvalidated) reasons.push("visibility-change");
            if (!snapshot.active) reasons.push("probe-duration-expired");
            if (snapshot.counters.droppedSamples > beforeProbe.counters.droppedSamples || snapshot.counters.droppedCorrelations > beforeProbe.counters.droppedCorrelations) reasons.push("collector-overflow");
            if (snapshot.counters.pendingInputs > 0) reasons.push("pending-input-samples");
            if (scenario.startsWith("first-key-") && after.editorLength !== 1) reasons.push("first-key-incomplete");
            if (scenario === "steady-typing" && after.editorLength !== FIXTURE_PARAMETERS.typingCharacters) reasons.push("typing-incomplete");
            if (["dom-mutation","synthetic-ime"].includes(scenario) && after.editorLength !== 1) reasons.push("synthetic-action-incomplete");
            if (scenario === "synthetic-ime" && after.inputCount - before.inputCount !== 1) reasons.push("synthetic-composition-input-incomplete");
            if (scenario.endsWith("-scroll") && Math.abs(completion.displacementPx - FIXTURE_PARAMETERS.scrollInputs * FIXTURE_PARAMETERS.scrollPixels) > 4) reasons.push("scroll-displacement-incomplete");
            if (scenario === "session-switch" && (after.switchCount - before.switchCount !== 2 || after.active !== before.active)) reasons.push("session-cycle-incomplete");
            if (scenario === "appearance" && after.appearanceCount - before.appearanceCount !== 2) reasons.push("appearance-cycle-incomplete");
            if (scenario === "appearance" && !appearanceSettled) reasons.push("appearance-skin-not-settled");
            const workMetrics = probe.analyzeMetricSnapshots(beforeMetrics.metrics, afterMetrics.metrics, { sameEpoch });
            if (workMetrics.valid === false) reasons.push("metric-counter-reset");
            const samples = snapshot.samples.filter(s => s.scenarioEpoch === scenarioEpoch);
            if (scenario.startsWith("first-key-") && (samples.filter(s=>s.kind==="keydown-dispatch").length!==1 || samples.filter(s=>s.kind==="input-two-raf").length!==1)) reasons.push("missing-first-input-evidence");
            if (scenario==="steady-typing" && (samples.filter(s=>s.kind==="keydown-dispatch").length!==FIXTURE_PARAMETERS.typingCharacters || samples.filter(s=>s.kind==="input-two-raf").length!==FIXTURE_PARAMETERS.typingCharacters)) reasons.push("missing-paced-input-evidence");
            const durationByKind = kind => distribution(samples.filter(s => s.kind === kind).map(s => s.durationMs));
            const keyStarts = samples.filter(s=>s.kind==="keydown-dispatch").map(s=>s.startMs);
            observations.push({ scenario, valid: reasons.length === 0, rejectionReasons: reasons, completion,
              actionFrameProxyMs, actionFrameProxyMeaning: "automation action sequence through two animation frames; includes action cadence and driver overhead; not paint or native switch latency",
              inputCounts: Object.fromEntries(Object.entries(snapshot.counters).map(([key,value]) => [key, value - beforeProbe.counters[key]])), supported: snapshot.supported, thresholds: snapshot.thresholds,
              inputTwoRafProxy: durationByKind("input-two-raf"), keydownDispatchProxy: durationByKind("keydown-dispatch"),
              eventTiming: durationByKind("event-timing"), workMetrics,
              observedKeyCadenceMs: distribution(keyStarts.slice(1).map((n,i)=>n-keyStarts[i])),
              synthetic: scenario === "synthetic-ime" || scenario === "dom-mutation",
              runtimeMetrics: { before: runtimeBefore, after: await runtimeMetrics(page), semantics: "endpoints; cumulative counts/total durations differenced separately; last/max durations are gauges; missing instrumentation is absent" } });
          }
          runs.push({ index, warmup, order, variant, observations });
        } finally {
          await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__?.cleanup()).catch(() => {});
          if (cdp) await cdp.detach().catch(() => {});
          await page.close().catch(() => {});
        }
        // Progress runs between trials, outside measured counter/input windows.
        onProgress?.({ index, warmup, variant });
      }
    }
    const collectorOverhead = [];
    // An explicit unskinned idle off/on control observes background collector
    // work. It is not an estimate of per-keystroke overhead or native overhead.
    for (let pair = 0; pair < 2; pair++) for (const enabled of pair % 2 ? [true,false] : [false,true]) {
      const page = await browser.newPage({ viewport: FIXTURE_PARAMETERS.viewport });
      let cdp;
      try {
        await page.setContent(fixtureHtml());
        await twoFrames(page);
        cdp = await page.context().newCDPSession(page);
        await cdp.send("Performance.enable");
        if (enabled) await page.evaluate(probe.installInteractionProbe, { fixture: true, editorSelector: "#benchmark-editor", durationMs: 5000 });
        const before = await cdp.send("Performance.getMetrics");
        await page.waitForTimeout(250);
        const after = await cdp.send("Performance.getMetrics");
        collectorOverhead.push({ pair, enabled, idleWindowMs: 250, workMetrics: probe.analyzeMetricSnapshots(before, after, { sameEpoch: true }) });
      } finally { await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__?.cleanup()).catch(()=>{});if(cdp)await cdp.detach().catch(()=>{});await page.close().catch(()=>{}); }
    }
    return { schema: "dream-skin-interaction-fixture/1", mode: "controlled-browser-fixture", sources: {
      "stock-fixture": { commit: null, skinPayload: false, skinWatcher: false, nativeApp: false },
      ...Object.fromEntries(Object.entries(sources).map(([label, value]) => [label, value.identity])) },
      environment: { nodeVersion: process.version, platform: process.platform, arch: process.arch, browserVersion: browser.version(), headless: true,
        nativeAppVersion: null, deviceScaleFactor: 1, refreshRateHz: null, powerMode: "unavailable", backgroundWorkload: "uncontrolled" },
      fixture: { ...FIXTURE_PARAMETERS, htmlSha256: sha256(fixtureHtml({ slowInputMs })), inducedInputHandlerMs: slowInputMs },
      protocol: { trials, warmups, variantOrder: "three-way-rotating", scenarios, timeoutMs, workCounterSettleMs: 160,
        typingCadenceMeaning: "40ms driver wait after each completed keyboard command; actual cadence includes browser/driver processing" },
      limitations: ["Stock-fixture is an unskinned synthetic Chromium control, not the stock native application",
        "One browser/host; fixed public DOM is not React or ProseMirror and does not replicate native session loading",
        "Trusted Chromium automation keyboard events exercise default contenteditable input; they are not physical Windows keyboard or OS IME input",
        "DOM-only and composition events are synthetic and do not establish input-to-presentation latency",
        "Two-rAF is a scheduling proxy, not proof of pixels presented; Event Timing has threshold/quantization and may omit short or browser-suppressed events",
        "Work counters cover action cadence plus 160ms settle; gauges are endpoints, not work totals; overlapping durations must not be summed",
        "p95 omitted below100 samples; no performance pass/fail threshold; fixture findings require native validation"],
      collectorOverhead: { scope: "two alternating 250ms stock-fixture idle pairs; does not establish typing or native collector overhead", observations: collectorOverhead },
      notApplicable: [{ scenario: "saved-theme", reason: "No native saved-theme chooser or equivalent complete theme contract in this fixture" },
        { scenario: "cold-startup", reason: "Fresh fixture initialization is not official desktop cold launch" },
        { scenario: "native-background", reason: "Headless fixture lifecycle does not model native window compositor/background behavior" }], runs };
  };
  try { return await Promise.race([work(), expiry]); }
  finally { clearTimeout(deadline); await browser.close().catch(() => {}); }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const output = await safeOutputPath(options.output);
  const sources = await loadPinnedPayloads();
  const report = await runFixture({ ...options, sources,
    onProgress: value => console.log(JSON.stringify({ status: "trial-complete", ...value })) });
  const bytes = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Fixture export exceeds size bound");
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "recorded", scope: report.mode, trials: options.trials,
    observations: report.runs.reduce((sum, run) => sum + run.observations.length, 0),
    invalid: report.runs.flatMap(run => run.observations).filter(o => !o.valid).length }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Interaction fixture failed; no native app or drafts were modified"); process.exitCode = 1; });
}
