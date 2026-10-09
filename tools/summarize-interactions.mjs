import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINES, quantile, sha256, safeOutputPath } from "./benchmark-baseline-classifier.mjs";
import { VARIANTS, SCENARIOS } from "./benchmark-interactions.mjs";
import { FIXTURE_PARAMETERS, fixtureHtml } from "./interaction-fixture.mjs";

const timingKinds = ["inputTwoRafProxy", "keydownDispatchProxy", "eventTiming", "actionFrameProxyMs"];
const counters = ["RecalcStyleCount", "LayoutCount", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"];
const gauges = ["JSHeapUsedSize", "Nodes", "JSEventListeners"];
const finite = n => Number.isFinite(n) && Math.abs(n) <= 1e12;
const nonnegative = n => finite(n) && n >= 0;
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 100000;
function spread(values) {
  assert.ok(values.every(finite), "Invalid numeric aggregate");
  return { count: values.length, min: values.length ? Math.min(...values) : null,
    median: values.length ? quantile(values, .5) : null,
    p25: values.length ? quantile(values, .25) : null,
    p75: values.length ? quantile(values, .75) : null,
    max: values.length ? Math.max(...values) : null };
}
function timing(value) {
  assert.ok(integer(value?.count), "Missing sample count");
  assert.ok(value.count === 0 ? value.medianMs === null : nonnegative(value.medianMs), "Missing timing is not zero");
  assert.ok(value.p95Ms === null || (value.count >= 100 && nonnegative(value.p95Ms)), "Unqualified p95");
  return { count: value.count, medianMs: value.medianMs, p95Ms: value.p95Ms };
}
function workCounters(value) {
  assert.equal(value.valid, true);
  return Object.fromEntries(counters.map(name => {
    const item = value.counters[name];
    assert.equal(item.unit, name.endsWith("Duration") ? "ms" : "count");
    assert.ok(item.delta === null || nonnegative(item.delta));
    return [name, item.delta];
  }));
}
function gaugeEndpoints(value) {
  return Object.fromEntries(gauges.map(name => {
    const item = value.gauges[name];
    assert.equal(item.unit, name === "JSHeapUsedSize" ? "bytes" : "count");
    assert.ok([item.before, item.after].every(n => n === null || nonnegative(n)));
    return [name, { unit: item.unit, before: item.before, after: item.after }];
  }));
}

/** Public synthetic aggregates only. No arbitrary renderer strings or objects are copied. */
export function summarizeReports(reports) {
  assert.ok(Array.isArray(reports) && reports.length >= 1 && reports.length <= 9);
  const rows = [], scenarios = new Set(), collections = [];
  let environment, payloadIdentities;
  for (const report of reports) {
    assert.equal(report.schema, "dream-skin-interaction-fixture/1");
    assert.equal(report.mode, "controlled-browser-fixture");
    assert.deepEqual(report.fixture, { ...FIXTURE_PARAMETERS, htmlSha256: sha256(fixtureHtml()), inducedInputHandlerMs: 0 });
    for (const [variant, commit] of Object.entries(BASELINES)) assert.equal(report.sources?.[variant]?.commit, commit);
    assert.equal(report.sources?.["stock-fixture"]?.nativeApp, false);
    const identities = Object.fromEntries(Object.keys(BASELINES).map(variant => {
      const source = report.sources[variant];
      assert.equal(source.material, "system");
      assert.ok(/^[a-f0-9]{20}$/.test(source.payloadRevision) && /^[a-f0-9]{64}$/.test(source.payloadSha256));
      const artwork = source.assets.find(a => a.file === "windows/assets/dream-reference.jpg");
      assert.ok(artwork && /^[a-f0-9]{64}$/.test(artwork.sha256));
      assert.ok(Number.isSafeInteger(artwork.bytes) && artwork.bytes > 0 && artwork.bytes <= 10 * 1024 * 1024);
      return [variant, { material: "system", payloadRevision: source.payloadRevision,
        payloadSha256: source.payloadSha256, defaultArtworkSha256: artwork.sha256 }];
    }));
    if (payloadIdentities) assert.deepEqual(identities, payloadIdentities, "Collections use different payloads");
    payloadIdentities = identities;
    const p = report.protocol;
    assert.ok(integer(p?.trials) && p.trials >= 1 && p.trials <= 20 && integer(p.warmups) && p.warmups <= 5);
    assert.equal(p.variantOrder, "three-way-rotating");
    assert.ok(Array.isArray(p.scenarios) && p.scenarios.length >= 1 && new Set(p.scenarios).size === p.scenarios.length);
    for (const scenario of p.scenarios) { assert.ok(SCENARIOS.includes(scenario) && !scenarios.has(scenario)); scenarios.add(scenario); }
    const e = report.environment;
    assert.ok(/^v\d+\.\d+\.\d+$/.test(e.nodeVersion) && /^\d+(\.\d+){2,3}$/.test(e.browserVersion));
    assert.ok(["win32", "linux", "darwin"].includes(e.platform) && ["x64", "arm64"].includes(e.arch));
    assert.equal(e.headless, true); assert.equal(e.nativeAppVersion, null); assert.equal(e.deviceScaleFactor, 1);
    const current = { nodeVersion: e.nodeVersion, browserVersion: e.browserVersion, platform: e.platform, arch: e.arch,
      headless: true, deviceScaleFactor: 1, refreshRateHz: null, powerMode: "unavailable", backgroundWorkload: "uncontrolled" };
    if (environment) assert.deepEqual(current, environment, "Collections use different environments");
    environment = current;
    assert.equal(report.runs.length, (p.trials + p.warmups) * VARIANTS.length);
    const seen = new Set();
    for (const run of report.runs) {
      assert.ok(VARIANTS.includes(run.variant) && typeof run.warmup === "boolean" && integer(run.index));
      assert.ok(run.index < (run.warmup ? p.warmups : p.trials));
      const key = `${run.warmup}/${run.index}/${run.variant}`;
      assert.ok(!seen.has(key), "Duplicate trial"); seen.add(key);
      assert.equal(run.observations.length, p.scenarios.length);
      assert.deepEqual(run.observations.map(o => o.scenario).sort(), [...p.scenarios].sort());
      for (const o of run.observations) {
        assert.equal(o.valid, true, "Invalid trial cannot become a successful baseline");
        assert.deepEqual(o.rejectionReasons, []);
        if (run.warmup) continue;
        const metrics = workCounters(o.workMetrics);
        assert.ok(nonnegative(o.actionFrameProxyMs));
        assert.ok(integer(o.inputCounts.trustedKeydowns) && integer(o.inputCounts.inputs));
        rows.push({ scenario: o.scenario, trial: run.index, variant: run.variant,
          trustedKeydowns: o.inputCounts.trustedKeydowns, inputs: o.inputCounts.inputs,
          inputTwoRafProxy: timing(o.inputTwoRafProxy), keydownDispatchProxy: timing(o.keydownDispatchProxy),
          eventTiming: timing(o.eventTiming), actionFrameProxyMs: o.actionFrameProxyMs,
          observedKeyCadence: timing(o.observedKeyCadenceMs), workCounters: metrics, gaugeEndpoints: gaugeEndpoints(o.workMetrics) });
      }
    }
    const controls = report.collectorOverhead.observations;
    assert.equal(controls.length, 4);
    assert.deepEqual(controls.map(c => `${c.pair}/${c.enabled}`).sort(), ["0/false", "0/true", "1/false", "1/true"]);
    collections.push({ scenarios: [...p.scenarios], measuredTrialsPerVariant: p.trials, warmupsPerVariant: p.warmups,
      idleCollectorControls: controls.map(c => {
        assert.equal(c.idleWindowMs, 250);
        return { pair: c.pair, enabled: c.enabled, idleWindowMs: 250, workCounters: workCounters(c.workMetrics), gaugeEndpoints: gaugeEndpoints(c.workMetrics) };
      }) });
  }
  const metrics = [...timingKinds, ...counters];
  const value = (row, name) => counters.includes(name) ? row.workCounters[name]
    : name === "actionFrameProxyMs" ? row[name] : row[name].medianMs;
  const comparisons = [...scenarios].map(scenario => {
    const subset = rows.filter(row => row.scenario === scenario);
    const variants = Object.fromEntries(VARIANTS.map(variant => [variant, Object.fromEntries(metrics.map(name =>
      [name, spread(subset.filter(row => row.variant === variant).map(row => value(row, name)).filter(n => n !== null))]))]));
    const pairedPrecleanMinusOriginal = Object.fromEntries(metrics.map(name => {
      const changes = subset.filter(row => row.variant === "original").flatMap(original => {
        const preclean = subset.find(row => row.variant === "preclean" && row.trial === original.trial);
        assert.ok(preclean, "Missing paired trial");
        const a = value(original, name), b = value(preclean, name);
        return a === null || b === null ? [] : [b - a];
      });
      return [name, spread(changes)];
    }));
    return { scenario, variants, pairedPrecleanMinusOriginal };
  });
  return { schema: "dream-skin-interaction-aggregate/1", scope: "controlled-browser-fixture-only", environment,
    sources: { "stock-fixture": { nativeApp: false, skinPayload: false }, ...BASELINES }, payloadIdentities,
    fixture: { ...FIXTURE_PARAMETERS, htmlSha256: sha256(fixtureHtml()) }, collections,
    aggregation: "Spread of measured per-trial medians; paired differences use matching trial indices. Event Timing is censored, not population INP. Counts have count units; durations have ms units. Action-frame proxy includes driver/cadence overhead.",
    nativeComparison: "not-established", rows, comparisons };
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length >= 2 && args.length <= 10, "Usage: summarize-interactions.mjs OUTPUT INPUT...");
  const output = await safeOutputPath(args[0]);
  const reports = [];
  for (const file of args.slice(1)) {
    const bytes = await readFile(file); assert.ok(bytes.length <= 4 * 1024 * 1024);
    reports.push(JSON.parse(bytes));
  }
  const report = summarizeReports(reports);
  const bytes = JSON.stringify(report, null, 2) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024);
  await writeFile(output, bytes, { flag: "wx" });
  console.log(JSON.stringify({ scope: report.scope, measuredRows: report.rows.length, scenarios: report.comparisons.length }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Interaction aggregation rejected input or output"); process.exitCode = 1; });
}
