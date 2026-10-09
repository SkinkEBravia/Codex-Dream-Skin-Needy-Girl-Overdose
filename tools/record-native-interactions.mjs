import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CdpSession, connectBrowserIdentityAnchor } from "../windows/scripts/injector.mjs";
import { installInteractionProbe, analyzeMetricSnapshots, summarizeSamples } from "./interaction-probe.mjs";

const scenarios = new Set(["first-key", "typing", "ime", "switch", "scroll-dock", "scroll-transcript", "appearance", "theme", "startup", "idle"]);
const kinds = new Set(["keydown-dispatch", "input-two-raf", "event-timing"]);
const counters = ["trustedKeydowns", "untrustedIgnored", "inputs", "compositionStarts", "compositionEnds", "eventTimingEntries", "eventTimingCorrelated", "eventTimingFiltered", "droppedSamples", "droppedCorrelations", "pendingInputs"];
const sampleKeys = ["seq", "kind", "scenario", "scenarioEpoch", "startMs", "durationMs", "trusted", "firstInScenario", "composing", "dispatchDelayMs", "processingDurationMs", "interactionSeq"];
const snapshotKeys = ["version", "active", "fixture", "supported", "thresholds", "durationLimitMs", "maxSamples", "scenario", "scenarioEpoch", "visibilityInvalidated", "counters", "samples"];
const metricNames = new Set(["RecalcStyleCount", "LayoutCount", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration", "JSHeapUsedSize", "Nodes", "JSEventListeners"]);
const finite = number => typeof number === "number" && Number.isFinite(number) && number >= 0;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (object, keys) => plain(object) && Object.keys(object).every(key => keys.includes(key));

/** Fail closed rather than exporting a renderer-supplied string or arbitrary field. */
export function sanitizeProbeSnapshot(value) {
  if (!onlyKeys(value, snapshotKeys) || value.version !== 1 || value.fixture !== false ||
      !["active", "visibilityInvalidated"].every(key => typeof value[key] === "boolean") ||
      !scenarios.has(value.scenario) || !Number.isSafeInteger(value.scenarioEpoch) || value.scenarioEpoch < 0 ||
      !Number.isSafeInteger(value.durationLimitMs) || value.durationLimitMs < 1000 || value.durationLimitMs > 300000 ||
      !Number.isSafeInteger(value.maxSamples) || value.maxSamples < 10 || value.maxSamples > 10000 ||
      !onlyKeys(value.supported, ["eventTiming", "animationFrame"]) ||
      !["eventTiming", "animationFrame"].every(key => typeof value.supported[key] === "boolean") ||
      !onlyKeys(value.thresholds, ["eventTimingDurationMs", "eventTimingQuantizationMs"]) ||
      value.thresholds.eventTimingDurationMs !== 16 || value.thresholds.eventTimingQuantizationMs !== 8 ||
      !onlyKeys(value.counters, counters) || !counters.every(key => Number.isSafeInteger(value.counters[key]) && value.counters[key] >= 0) ||
      !Array.isArray(value.samples) || value.samples.length > value.maxSamples) throw new Error("probe-schema-invalid");
  for (const sample of value.samples) {
    if (!onlyKeys(sample, sampleKeys) || !kinds.has(sample.kind) || !scenarios.has(sample.scenario) ||
        sample.trusted !== true || typeof sample.firstInScenario !== "boolean" || typeof sample.composing !== "boolean" ||
        !["seq", "scenarioEpoch", "startMs", "durationMs"].every(key => finite(sample[key])) ||
        !Number.isSafeInteger(sample.seq) || sample.seq < 1 || !Number.isSafeInteger(sample.scenarioEpoch) ||
        ["dispatchDelayMs", "processingDurationMs", "interactionSeq"].some(key => sample[key] != null && !finite(sample[key]))) throw new Error("probe-schema-invalid");
  }
  return JSON.parse(JSON.stringify(value));
}

export function parseArguments(args) {
  const allowed = new Set(["--port", "--browser-id", "--duration", "--output", "--scenario"]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || Object.hasOwn(values, args[index]) || typeof args[index + 1] !== "string" || args[index + 1].startsWith("--")) throw new Error("arguments-invalid");
    values[args[index]] = args[index + 1];
  }
  const port = Number(values["--port"]);
  const browserId = values["--browser-id"];
  const duration = Number(values["--duration"] ?? 60);
  const output = values["--output"];
  const scenario = values["--scenario"] ?? "typing";
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9._-]{1,200}$/.test(browserId ?? "") ||
      !Number.isInteger(duration) || duration < 30 || duration > 120 || !scenarios.has(scenario) ||
      typeof output !== "string" || path.isAbsolute(output) || /^[A-Za-z]:/.test(output) || output.includes("\\") || output.includes(":") ||
      !/^[A-Za-z0-9_.\/-]+\.json$/.test(output) || output.split("/").some(part => !part || part === ".." || part === ".")) throw new Error("arguments-invalid");
  return { port, browserId, duration, output, scenario };
}

export async function validateOutputPath(relative, root = process.cwd()) {
  const absolute = path.resolve(root, relative);
  const relativeCheck = path.relative(root, absolute);
  if (!relativeCheck || relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new Error("output-path-invalid");
  let current = path.resolve(root);
  for (let ancestor = current;; ancestor = path.dirname(ancestor)) {
    if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error("output-path-invalid");
    if (path.dirname(ancestor) === ancestor) break;
  }
  for (const component of relativeCheck.split(path.sep).slice(0, -1)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("output-path-invalid");
  }
  try { await fs.lstat(absolute); throw new Error("output-already-exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return absolute;
}

// Only booleans and numeric context metadata cross CDP; never read titles or draft text.
export function inspectNativeContext() {
  const main = document.querySelector('main:is(.main-surface,[data-app-shell-main-surface],[class*="_MainContentSurface_"])');
  const sidebar = document.querySelector('aside.app-shell-left-panel,[data-testid="app-shell-floating-left-panel"],.sidebar-navigation');
  const native = !!main && !!document.querySelector('[data-app-shell-active-page],[data-codex-composer-root],[data-app-shell-main-surface]') && !!sidebar;
  const brand = !!document.querySelector('[data-testid="app-shell-header-context-menu-surface"]') ||
    (!!document.querySelector('main[data-app-shell-main-surface]') && !!sidebar &&
      !!document.querySelector('header[data-app-shell-header-edge-scroll],header[data-app-shell-application-menu-bar]') &&
      !!document.querySelector('[data-codex-composer-root],.composer-surface-chrome,[class*="_ComposerLayoutRoot_"]'));
  const visible = document.visibilityState === "visible";
  return { native, brand, visible, timeOrigin: performance.timeOrigin };
}

export function classifyNativeContext(context) {
  if (context?.native !== true || context.brand !== true || !finite(context.timeOrigin)) return "unverified";
  return context.visible === true ? "foreground-native" : "background-native";
}

export async function waitForForegroundContext(readContext, expectedEpoch, {
  now = () => performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  interrupted = () => false
} = {}) {
  const deadline = now() + 15000;
  while (now() < deadline) {
    if (interrupted()) throw new Error("recording-interrupted");
    let context;
    try { context = await readContext(Math.max(1, deadline - now())); }
    catch (error) { if (now() >= deadline) return false; throw error; }
    if (now() >= deadline) return false;
    const classification = classifyNativeContext(context);
    if (context?.timeOrigin !== expectedEpoch || classification === "unverified") throw new Error("document-identity-changed");
    if (classification === "foreground-native") return true;
    await pause(Math.min(500, Math.max(0, deadline - now())));
  }
  return false;
}

async function targetList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error("target-list-unavailable");
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new Error("target-list-invalid");
    chunks.push(chunk);
  }
  const targets = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(targets) || targets.length > 128) throw new Error("target-list-invalid");
  return targets.filter(target => target.type === "page" && typeof target.url === "string" && target.url.startsWith("app://")).slice(0, 8);
}

function ownedProbeExpression(token, operation) {
  const encoded = JSON.stringify(token);
  if (operation === "cleanup") return `(()=>{const p=window.__DREAM_SKIN_INTERACTION_PROBE__;if(p?.collectorToken!==${encoded})return false;p.cleanup();delete window.__DREAM_SKIN_INTERACTION_PROBE__;return true;})()`;
  if (operation === "health") return `(()=>{const p=window.__DREAM_SKIN_INTERACTION_PROBE__;return p?.collectorToken===${encoded}?p.health():null;})()`;
  return `(()=>{const p=window.__DREAM_SKIN_INTERACTION_PROBE__;return p?.collectorToken===${encoded}?p.snapshot():null;})()`;
}

async function metrics(session) {
  const result = await session.send("Performance.getMetrics", {}, 3000);
  if (!Array.isArray(result.metrics) || result.metrics.length > 128) throw new Error("metrics-invalid");
  return result.metrics.filter(item => metricNames.has(item?.name) && finite(item.value)).map(({ name, value }) => ({ name, value }));
}

/** Record a human-performed trial. Never invoke Input, navigation, focus, or skin APIs. */
export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const output = await validateOutputPath(options.output);
  const token = randomUUID();
  let anchor, session, started, recordingDuration, before, after, snapshot, epoch;
  const backgroundSessions = [];
  let probeInstalled = false;
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  const report = {
    schema: "dream-skin-native-interactions/1", source: "human-manual", status: "invalid", reason: "collector-failed",
    requestedDurationSeconds: options.duration, scenario: options.scenario, controlledActionCounts: false,
    nativeEvidence: "no-native-evidence", metrics: null, probe: null,
    limitations: ["Manual scenario label is not verification of session-switch completion or action counts.", "Input-to-two-animation-frames is a proxy, not confirmed presentation latency.", "Keydown dispatch samples do not include all editor processing or presentation.", "Event Timing omits events below its supported threshold; missing entries are not zero."]
  };
  let cleanupConfirmed = false;
  try {
    anchor = await connectBrowserIdentityAnchor(options.port, options.browserId);
    const candidates = await targetList(options.port);
    const selectionDeadline = performance.now() + 10000;
    for (const target of candidates) {
      if (performance.now() > selectionDeadline) throw new Error("native-target-selection-timeout");
      const candidate = await new CdpSession(target, options.port).open();
      let info;
      try { info = await candidate.evaluate(`(${inspectNativeContext.toString()})()`, 3000); }
      catch { candidate.close(); continue; }
      const classification = classifyNativeContext(info);
      if (classification === "foreground-native") {
        if (session) { candidate.close(); throw new Error("multiple-visible-native-renderers"); }
        session = candidate; epoch = info.timeOrigin;
      } else if (classification === "background-native") backgroundSessions.push({ session: candidate, epoch: info.timeOrigin });
      else candidate.close();
    }
    if (!session && backgroundSessions.length > 1) throw new Error("multiple-background-native-renderers");
    if (!session && backgroundSessions.length === 1) {
      const candidate = backgroundSessions[0];
      console.log("Waiting for the verified native conversation to become visible; no interactions recorded yet.");
      const foreground = await waitForForegroundContext(
        remaining => candidate.session.evaluate(`(${inspectNativeContext.toString()})()`, Math.min(2000, remaining)), candidate.epoch,
        { interrupted: () => interrupted || anchor.closed || candidate.session.closed });
      if (foreground) { session = candidate.session; epoch = candidate.epoch; }
    }
    for (const candidate of backgroundSessions) if (candidate.session !== session) candidate.session.close();
    if (!session) throw new Error(backgroundSessions.length ? "native-renderer-backgrounded" : "native-renderer-unavailable");
    session.on("Runtime.executionContextsCleared", () => { interrupted = true; });
    await session.send("Performance.enable", { timeDomain: "timeTicks" }, 3000);
    before = await metrics(session);
    const installation = `(()=>{if(window.__DREAM_SKIN_INTERACTION_PROBE__)throw Error("probe-already-present");(${installInteractionProbe.toString()})(${JSON.stringify({ durationMs: options.duration * 1000 + 5000, maxSamples: 2000 })});const p=window.__DREAM_SKIN_INTERACTION_PROBE__;p.collectorToken=${JSON.stringify(token)};p.markScenario(${JSON.stringify(options.scenario)});return p.snapshot();})()`;
    const initialSnapshot = await session.evaluate(installation, 5000);
    probeInstalled = true;
    snapshot = sanitizeProbeSnapshot(initialSnapshot);
    started = performance.now();
    console.log("Native interaction recording ready; passive composer observation only.");
    while (performance.now() - started < options.duration * 1000) {
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, options.duration * 1000 - (performance.now() - started))));
      if (interrupted || anchor.closed || session.closed) throw new Error("recording-interrupted");
      const context = await session.evaluate(`(${inspectNativeContext.toString()})()`, 3000);
      if (context?.timeOrigin !== epoch || !context.native || !context.brand) throw new Error("document-identity-changed");
      const health = await session.evaluate(ownedProbeExpression(token, "health"), 3000);
      if (!onlyKeys(health, ["active", "visibilityInvalidated"]) || typeof health.active !== "boolean" || typeof health.visibilityInvalidated !== "boolean") throw new Error("probe-schema-invalid");
      if (!context.visible || health.visibilityInvalidated) throw new Error("foreground-scenario-backgrounded");
      if (!health.active) throw new Error("probe-stopped-early");
    }
    recordingDuration = (performance.now() - started) / 1000;
    after = await metrics(session);
    const context = await session.evaluate(`(${inspectNativeContext.toString()})()`, 3000);
    if (context?.timeOrigin !== epoch || !context.native || !context.brand || !context.visible) throw new Error("document-identity-changed");
    snapshot = sanitizeProbeSnapshot(await session.evaluate(ownedProbeExpression(token, "snapshot"), 3000));
    report.metrics = analyzeMetricSnapshots(before, after, { sameEpoch: true });
    report.status = report.metrics.valid && !snapshot.visibilityInvalidated && snapshot.counters.droppedSamples === 0 && snapshot.counters.droppedCorrelations === 0 && snapshot.counters.pendingInputs === 0 ? "completed" : "invalid";
    report.reason = report.status === "completed" ? null : "counter-reset-or-probe-loss";
  } catch (error) {
    const safeReasons = new Set(["multiple-visible-native-renderers", "multiple-background-native-renderers", "native-renderer-unavailable", "native-renderer-backgrounded", "native-target-selection-timeout", "recording-interrupted", "document-identity-changed", "foreground-scenario-backgrounded", "probe-stopped-early", "probe-schema-invalid", "metrics-invalid", "target-list-unavailable", "target-list-invalid"]);
    report.reason = safeReasons.has(error.message) ? error.message : "collector-failed";
  } finally {
    if (session && !session.closed) {
      // Preserve numeric partial evidence on invalid trials, without accepting another owner's probe.
      if (report.status !== "completed") {
        try { snapshot = sanitizeProbeSnapshot(await session.evaluate(ownedProbeExpression(token, "snapshot"), 3000)); } catch {}
      }
      try { cleanupConfirmed = await session.evaluate(ownedProbeExpression(token, "cleanup"), 3000); } catch {}
      // Performance domain state is connection-local; closing this session releases it.
      session.close();
    }
    anchor?.close();
    for (const candidate of backgroundSessions) candidate.session.close();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
  if (snapshot) {
    report.probe = snapshot;
    report.nativeEvidence = snapshot.counters.trustedKeydowns > 0 || snapshot.counters.inputs > 0 ? "observed" : "no-native-evidence";
    report.distributions = Object.fromEntries([...kinds].map(kind => [kind, summarizeSamples(snapshot.samples, { kind })]));
  }
  report.observedDurationSeconds = recordingDuration ?? (started ? (performance.now() - started) / 1000 : null);
  report.cleanupConfirmed = cleanupConfirmed;
  report.cleanupRequired = probeInstalled;
  if (!cleanupConfirmed && snapshot) {
    if (report.status === "completed") report.reason = "collector-cleanup-unconfirmed";
    report.status = "invalid";
  }
  if (report.status !== "completed") report.metrics = before && after ? analyzeMetricSnapshots(before, after, { sameEpoch: false }) : null;
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(report.status === "completed" ? "Native interaction recording completed; sanitized report written." : "Native interaction recording invalid; sanitized reason written.");
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(report => { if (report.status !== "completed") process.exitCode = 1; }).catch(() => {
    console.error("Native interaction recorder could not start or write its bounded report.");
    process.exitCode = 1;
  });
}
