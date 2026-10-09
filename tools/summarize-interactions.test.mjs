import assert from "node:assert/strict";
import test from "node:test";
import { summarizeReports } from "./summarize-interactions.mjs";
import { BASELINES, sha256 } from "./benchmark-baseline-classifier.mjs";
import { FIXTURE_PARAMETERS, fixtureHtml } from "./interaction-fixture.mjs";

function fixtureReport() {
  const duration = n => ({ count: n === null ? 0 : 1, medianMs: n, p95Ms: null });
  const observation = variant => ({ scenario: "first-key-immediate", valid: true, rejectionReasons: [],
    inputCounts: { trustedKeydowns: 1, inputs: 1 }, actionFrameProxyMs: 200,
    inputTwoRafProxy: duration(variant === "original" ? 90 : 5), keydownDispatchProxy: duration(1),
    eventTiming: duration(null), observedKeyCadenceMs: duration(null),
    workMetrics: { valid: true, counters: Object.fromEntries(["RecalcStyleCount", "LayoutCount", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"]
      .map(name => [name, { unit: name.endsWith("Duration") ? "ms" : "count", delta: 1 }])),
      gauges: Object.fromEntries(["JSHeapUsedSize", "Nodes", "JSEventListeners"].map(name => [name, { unit: name === "JSHeapUsedSize" ? "bytes" : "count", before: 50, after: 55 }])) } });
  return { schema: "dream-skin-interaction-fixture/1", mode: "controlled-browser-fixture",
    fixture: { ...FIXTURE_PARAMETERS, htmlSha256: sha256(fixtureHtml()), inducedInputHandlerMs: 0 },
    sources: { ...Object.fromEntries(Object.entries(BASELINES).map(([key, commit]) => [key, { commit, material: "system",
      payloadRevision: "a".repeat(20), payloadSha256: "a".repeat(64),
      assets: [{ file: "windows/assets/dream-reference.jpg", sha256: "b".repeat(64), bytes: 1000 }] }])), "stock-fixture": { nativeApp: false } },
    environment: { nodeVersion: "v24.17.0", browserVersion: "154.0.8037.98", platform: "win32", arch: "x64", headless: true, nativeAppVersion: null, deviceScaleFactor: 1 },
    protocol: { trials: 10, warmups: 0, variantOrder: "three-way-rotating", scenarios: ["first-key-immediate"] },
    collectorOverhead: { observations: [0, 1].flatMap(pair => [false, true].map(enabled => ({ pair, enabled, idleWindowMs: 250, workMetrics: observation("stock-fixture").workMetrics }))) },
    runs: Array.from({ length: 10 }, (_, index) => ["stock-fixture", "original", "preclean"].map(variant =>
      ({ index, variant, warmup: false, observations: [observation(variant)] }))).flat() };
}

test("sanitized paired aggregates preserve missing events, negative changes, units and small sample limits", () => {
  const report = summarizeReports([fixtureReport()]);
  assert.equal(report.rows.length, 30);
  const result = report.comparisons[0];
  assert.equal(result.pairedPrecleanMinusOriginal.inputTwoRafProxy.count, 10);
  assert.equal(result.pairedPrecleanMinusOriginal.inputTwoRafProxy.median, -85);
  assert.equal(result.variants.original.eventTiming.count, 0);
  assert.equal(result.variants.original.eventTiming.median, null);
  assert.equal(result.pairedPrecleanMinusOriginal.eventTiming.count, 0);
  assert.equal(report.rows[0].eventTiming.p95Ms, null);
  assert.equal(report.rows[0].gaugeEndpoints.JSHeapUsedSize.unit, "bytes");
  assert.equal(report.collections[0].idleCollectorControls.length, 4);
  assert.equal(report.nativeComparison, "not-established");
});

test("invalid, duplicated, missing, altered-source and incomparable trials fail instead of producing success", () => {
  for (const alter of [
    r => { r.runs[0].observations[0].valid = false; },
    r => { r.runs[0].observations[0].inputTwoRafProxy.p95Ms = 10; },
    r => { r.runs[0].observations[0].eventTiming.medianMs = 0; },
    r => { r.runs[0].observations[0].workMetrics.counters.ScriptDuration.unit = "seconds"; },
    r => { r.runs[0].observations[0].workMetrics.counters.ScriptDuration.delta = Infinity; },
    r => { r.runs[1] = structuredClone(r.runs[0]); },
    r => { r.runs.pop(); },
    r => { r.sources.preclean.commit = "moving-main"; },
    r => { r.sources.preclean.payloadRevision = "private URL"; },
    r => { r.sources.original.assets[0].sha256 = "private data"; },
    r => { r.fixture.typingCharacters = 1; },
    r => { r.environment.browserVersion = "private URL"; }
  ]) { const report = fixtureReport(); alter(report); assert.throws(() => summarizeReports([report])); }
  assert.throws(() => summarizeReports([fixtureReport(), fixtureReport()]), /Assertion/);
});

test("arbitrary input properties and private strings cannot enter the constructed export", () => {
  const report = fixtureReport();
  report.privateTitle = "SENSITIVE_SENTINEL";
  report.sources.original.privatePath = "SENSITIVE_SENTINEL";
  report.runs[0].observations[0].rawText = "SENSITIVE_SENTINEL";
  report.environment.privateName = "SENSITIVE_SENTINEL";
  const output = JSON.stringify(summarizeReports([report]));
  assert.ok(!output.includes("SENSITIVE_SENTINEL"));
});
