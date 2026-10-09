import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseArguments, sanitizeProbeSnapshot, validateOutputPath, inspectNativeContext, classifyNativeContext, waitForForegroundContext } from "./record-native-interactions.mjs";

const argumentsFor = overrides => {
  const options = { "--port": "9333", "--browser-id": "verified-browser", "--duration": "60", "--output": "evidence/trial.json", ...overrides };
  return Object.entries(options).flat();
};
const validSnapshot = () => ({
  version: 1, active: true, fixture: false,
  supported: { eventTiming: true, animationFrame: true },
  thresholds: { eventTimingDurationMs: 16, eventTimingQuantizationMs: 8 },
  durationLimitMs: 65000, maxSamples: 2000, scenario: "typing", scenarioEpoch: 1, visibilityInvalidated: false,
  counters: { trustedKeydowns: 0, untrustedIgnored: 0, inputs: 0, compositionStarts: 0, compositionEnds: 0,
    eventTimingEntries: 0, eventTimingCorrelated: 0, eventTimingFiltered: 0, droppedSamples: 0, droppedCorrelations: 0, pendingInputs: 0 },
  samples: []
});

test("recorder bounds identity arguments, fixed labels, duration, and relative report paths", () => {
  assert.deepEqual(parseArguments(argumentsFor()), { port: 9333, browserId: "verified-browser", duration: 60, output: "evidence/trial.json", scenario: "typing" });
  for (const invalid of [
    { "--port": "80" }, { "--port": "9333.1" }, { "--browser-id": "ws://localhost/private" },
    { "--duration": "29" }, { "--duration": "121" }, { "--duration": "Infinity" },
    { "--scenario": "private chat title" }, { "--output": "../state.json" }, { "--output": "C:/private/report.json" },
    { "--output": "/tmp/private.json" }, { "--output": "evidence/report.json:stream" },
    { "--output": "evidence/./report.json" }, { "--output": "evidence//report.json" }, { "--output": "evidence\\report.json" }
  ]) assert.throws(() => parseArguments(argumentsFor(invalid)), /arguments-invalid/);
  assert.throws(() => parseArguments([...argumentsFor(), "--duration", "60"]), /arguments-invalid/);
  assert.throws(() => parseArguments([...argumentsFor(), "--unknown", "1"]), /arguments-invalid/);
  assert.throws(() => parseArguments(["--port"]), /arguments-invalid/);
});

test("sanitizer retains absent observations as empty samples and accepts numeric latency only", () => {
  const empty = sanitizeProbeSnapshot(validSnapshot());
  assert.equal(empty.counters.trustedKeydowns, 0);
  assert.deepEqual(empty.samples, []);
  const source = validSnapshot();
  source.samples.push({ seq: 1, kind: "event-timing", scenario: "first-key", scenarioEpoch: 2,
    startMs: 234, durationMs: 32, trusted: true, firstInScenario: true, composing: false,
    dispatchDelayMs: null, processingDurationMs: 18, interactionSeq: 1 });
  const safe = sanitizeProbeSnapshot(source);
  assert.deepEqual(safe.samples, source.samples);
  safe.samples[0].durationMs = 100;
  assert.equal(source.samples[0].durationMs, 32, "sanitizer returns a detached numeric record");
});

test("sanitizer rejects private text, URLs, arbitrary properties, malformed counters and samples", () => {
  const alterations = [
    value => { value.browserId = "private"; }, value => { value.supported.url = "app://private"; },
    value => { value.counters.trustedKeydowns = -1; }, value => { delete value.counters.inputs; },
    value => { value.scenario = "a user's session title"; }, value => { value.fixture = true; },
    value => { value.thresholds.eventTimingDurationMs = 0; }, value => { value.maxSamples = 10001; },
    value => { value.samples = [{ seq: 1, kind: "event-timing", scenario: "typing", scenarioEpoch: 1,
      startMs: 23, durationMs: 16, trusted: true, firstInScenario: true, composing: false, key: "secret" }]; },
    value => { value.samples = [{ seq: 1, kind: "keydown-dispatch", scenario: "typing", scenarioEpoch: 1,
      startMs: 23, durationMs: NaN, trusted: true, firstInScenario: true, composing: false }]; },
    value => { value.samples = [{ seq: 1, kind: "keydown-dispatch", scenario: "typing", scenarioEpoch: 1,
      startMs: 23, durationMs: 16, trusted: false, firstInScenario: true, composing: false }]; }
  ];
  for (const alter of alterations) {
    const value = validSnapshot(); alter(value);
    assert.throws(() => sanitizeProbeSnapshot(value), /probe-schema-invalid/);
  }
});

test("native context requires structural app markers plus branding without reading document title", () => {
  const run = (matches, visibility = "visible") => vm.runInNewContext(`(${inspectNativeContext.toString()})()`, {
    document: { get title() { throw new Error("Private title must never be read"); }, visibilityState: visibility, querySelector: selector => matches(selector) ? {} : null },
    performance: { timeOrigin: 12345 }
  });
  const branded = run(() => true);
  assert.equal(branded.native, true); assert.equal(branded.brand, true);
  assert.equal(JSON.stringify(branded).includes("private"), false);
  const fake = run(selector => selector.includes("app-shell-header-context-menu-surface"));
  assert.equal(fake.native, false, "brand alone cannot validate a renderer");
  const unbranded = run(selector => !selector.includes("app-shell-header-context-menu-surface") && !selector.includes("main[data-app-shell-main-surface]"));
  assert.equal(unbranded.brand, false, "structural similarities alone cannot validate an app");
  assert.equal(run(() => true, "hidden").visible, false);
});

test("observed hidden native renderer cannot be replaced by visible unbranded utility pages", () => {
  const nativeHidden = { native: true, brand: true, visible: false, timeOrigin: 1000 };
  const visibleUtility = { native: false, brand: false, visible: true, timeOrigin: 2000 };
  assert.equal(classifyNativeContext(nativeHidden), "background-native");
  assert.equal(classifyNativeContext(visibleUtility), "unverified");
  assert.equal(classifyNativeContext({ ...nativeHidden, visible: true }), "foreground-native");
  assert.equal(classifyNativeContext({ ...nativeHidden, timeOrigin: NaN }), "unverified");
  assert.equal(classifyNativeContext({ ...visibleUtility, native: true }), "unverified");
});

test("foreground readiness waits at most 15 seconds without changing document, focus, or routes", async () => {
  let time = 0; let polls = 0; const waits = [];
  const clock = { now: () => time, pause: async milliseconds => { waits.push(milliseconds); time += milliseconds; } };
  const native = { native: true, brand: true, visible: false, timeOrigin: 1000 };
  assert.equal(await waitForForegroundContext(async () => { polls++; return { ...native, visible: polls === 3 }; }, 1000, clock), true);
  assert.equal(time, 1000); assert.equal(polls, 3);
  time = 0; polls = 0; waits.length = 0;
  assert.equal(await waitForForegroundContext(async () => { polls++; return native; }, 1000, clock), false);
  assert.equal(time, 15000); assert.equal(polls, 30);
  assert.ok(waits.every(milliseconds => milliseconds === 500));
  await assert.rejects(waitForForegroundContext(async () => ({ ...native, visible: true, timeOrigin: 2000 }), 1000, clock), /document-identity-changed/);
  await assert.rejects(waitForForegroundContext(async () => ({ ...native, visible: true, brand: false }), 1000, clock), /document-identity-changed/);
  await assert.rejects(waitForForegroundContext(async () => native, 1000, { ...clock, interrupted: () => true }), /recording-interrupted/);
  assert.equal(await waitForForegroundContext(async remaining => { assert.equal(remaining, 15000); time += 15001; return { ...native, visible: true }; }, 1000, clock), false);
});

test("output validator refuses overwrites, missing directories and linked destinations", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-recorder-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "evidence"));
  assert.equal(await validateOutputPath("evidence/trial.json", root), path.join(root, "evidence", "trial.json"));
  await fs.writeFile(path.join(root, "evidence", "trial.json"), "preserve");
  await assert.rejects(validateOutputPath("evidence/trial.json", root), /output-already-exists/);
  await assert.rejects(validateOutputPath("missing/trial.json", root));
  await assert.rejects(validateOutputPath("../outside.json", root), /output-path-invalid/);
  await fs.symlink(path.join(root, "evidence"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validateOutputPath("linked/new.json", root), /output-path-invalid/);
  assert.equal(await fs.readFile(path.join(root, "evidence", "trial.json"), "utf8"), "preserve");
});

test("recorder and wrapper have no input, app-launch, skin-install, or state-write operations", async () => {
  const collector = await fs.readFile(new URL("./record-native-interactions.mjs", import.meta.url), "utf8");
  const wrapper = await fs.readFile(new URL("../windows/scripts/record-performance-baseline.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(collector, /(?:send|evaluate)\(\s*["'](?:Input\.|Page\.navigate|Page\.captureScreenshot)/);
  assert.doesNotMatch(collector, /\.focus\(|\.click\(|\.textContent|\.innerText|\.value\s*=/);
  assert.doesNotMatch(wrapper, /Stop-DreamSkin|Write-DreamSkinState|start-dream-skin|patch-dream-skin|Start-Process|ExecutionPolicy\s+Bypass/i);
  assert.match(wrapper, /Get-DreamSkinCodexInstall/);
  assert.match(wrapper, /Get-DreamSkinVerifiedCdpIdentity[\s\S]*-ExpectedSessionId/);
  assert.match(wrapper, /StartTimeFileTimeUtc -ne \[long\]\$taskState\.codexStartTimeFileTimeUtc/);
  assert.match(wrapper, /WaitForExit\(\(\$DurationSeconds \+ 60\) \* 1000\)/);
  assert.match(wrapper, /\$taskChild\.Kill\(\)/);
  assert.doesNotMatch(wrapper, /Stop-Process|taskkill/i);
  assert.match(collector, /collectorToken/);
  assert.match(collector, /snapshot\.visibilityInvalidated/);
  assert.match(collector, /no-native-evidence/);
});

test("Windows wrapper parses in Windows PowerShell 5.1", { skip: process.platform !== "win32" }, () => {
  const script = '$taskParseErrors=$null;$taskTokens=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD "windows/scripts/record-performance-baseline.ps1"),[ref]$taskTokens,[ref]$taskParseErrors);if($taskParseErrors.Count){Write-Output "Parser rejected recorder wrapper";exit 1}';
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 10000, stdio: "pipe" });
});
