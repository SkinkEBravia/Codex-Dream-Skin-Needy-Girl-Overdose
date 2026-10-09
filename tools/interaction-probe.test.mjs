import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installInteractionProbe, analyzeMetricSnapshots, summarizeSamples } from "./interaction-probe.mjs";

function fixture({ eventTiming = true, visible = true } = {}) {
  let clock = 50;
  let id = 0;
  let observer;
  const listeners = new Map();
  const frames = new Map();
  const timers = new Map();
  const document = {
    visibilityState: visible ? "visible" : "hidden",
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  class Observer {
    static supportedEntryTypes = eventTiming ? ["event"] : [];
    records = [];
    constructor(callback) { this.callback = callback; observer = this; }
    observe(options) { this.options = options; this.connected = true; }
    takeRecords() { const entries = this.records; this.records = []; return entries; }
    disconnect() { this.connected = false; }
  }
  const window = {};
  const context = vm.createContext({ window, document, performance: { now: () => clock, timeOrigin: 1700000000000 },
    PerformanceObserver: Observer,
    requestAnimationFrame(callback) { const key = ++id; frames.set(key, callback); return key; },
    cancelAnimationFrame(key) { frames.delete(key); },
    setTimeout(callback, duration) { const key = ++id; timers.set(key, { callback, duration }); return key; },
    clearTimeout(key) { timers.delete(key); },
  });
  const run = options => vm.runInContext(`(${installInteractionProbe.toString()})(${JSON.stringify(options || {})})`, context);
  const privateGetter = () => { throw new Error("private content was read"); };
  function target({ editor = true, composer = true, blocked = false } = {}) {
    const result = {
      closest(selector) {
        if (selector === "#benchmark-editor") return editor ? result : null;
        if (selector === 'textarea, [contenteditable="true"]') return editor ? result : null;
        if (selector.startsWith('input[type="password"]')) return blocked ? result : null;
        return composer ? result : null;
      },
    };
    for (const key of ["textContent", "innerText", "value", "innerHTML", "id", "className"]) Object.defineProperty(result, key, { get: privateGetter });
    return result;
  }
  const editor = target();
  const emit = (name, options = {}) => {
    const event = { target: editor, isTrusted: true, timeStamp: clock, ...options };
    for (const key of ["key", "code", "data", "inputType"]) Object.defineProperty(event, key, { get: privateGetter });
    for (const callback of [...(listeners.get(name) || [])]) callback(event);
  };
  const frame = nextClock => {
    clock = nextClock;
    const batch = [...frames.values()]; frames.clear();
    for (const callback of batch) callback(clock);
  };
  return { run, window, document, listeners, frames, timers, editor, target, emit, frame,
    setClock: value => { clock = value; }, getObserver: () => observer,
    snapshot: () => JSON.parse(JSON.stringify(window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot())),
  };
}

test("probe is CDP-serializable and ignores private text, unrelated fields and untrusted input", () => {
  const env = fixture();
  env.run();
  env.window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario("first-key");
  env.emit("keydown", { timeStamp: 10 });
  env.emit("input");
  env.emit("keydown", { isTrusted: false });
  env.emit("input", { target: env.target({ composer: false }) });
  env.emit("input", { target: env.target({ blocked: true }) });
  env.emit("input", { target: env.target({ editor: false }) });
  env.frame(70); env.frame(90);
  const result = env.snapshot();
  assert.equal(result.counters.trustedKeydowns, 1);
  assert.equal(result.counters.inputs, 1);
  assert.equal(result.counters.untrustedIgnored, 1);
  assert.deepEqual(result.samples.map(item => [item.kind, item.durationMs, item.firstInScenario]),
    [["keydown-dispatch", 40, true], ["input-two-raf", 40, true]]);
  assert.equal(result.samples[0].scenario, "first-key");
  assert.deepEqual(Object.keys(result).sort(), ["version", "active", "fixture", "supported", "thresholds", "durationLimitMs", "maxSamples", "scenario", "scenarioEpoch", "visibilityInvalidated", "counters", "samples"].sort());
  for (const sample of result.samples) assert.deepEqual(Object.keys(sample).filter(key => ![
    "seq", "kind", "scenario", "scenarioEpoch", "startMs", "durationMs", "trusted", "firstInScenario", "composing", "dispatchDelayMs",
  ].includes(key)), []);
  assert.throws(() => env.window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario("private conversation"), /static scenario/);
});

test("first input after a blocked dispatch is separated from steady typing and IME state", () => {
  const env = fixture(); env.run();
  env.window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario("typing");
  env.setClock(300); env.emit("keydown", { timeStamp: 50 }); env.emit("input");
  env.frame(316); env.frame(332);
  env.setClock(350); env.emit("keydown", { timeStamp: 348 }); env.emit("input");
  env.frame(366); env.frame(382);
  env.window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario("ime");
  env.emit("compositionstart"); env.emit("keydown"); env.emit("input"); env.emit("compositionend");
  env.frame(398); env.frame(414);
  const snapshot = env.snapshot();
  const dispatch = snapshot.samples.filter(sample => sample.kind === "keydown-dispatch");
  assert.deepEqual(dispatch.map(sample => [sample.durationMs, sample.firstInScenario, sample.composing]), [[250, true, false], [2, false, false], [0, true, true]]);
  assert.equal(snapshot.counters.compositionStarts, 1);
  assert.equal(snapshot.counters.compositionEnds, 1);
});

test("normalizes epoch timestamps and omits invalid timestamps instead of claiming zero latency", () => {
  const env = fixture(); env.run();
  env.emit("keydown", { timeStamp: 1700000000020 });
  env.emit("keydown", { timeStamp: 999999 });
  env.emit("keydown", { timeStamp: NaN });
  assert.equal(env.snapshot().counters.trustedKeydowns, 3);
  assert.equal(env.snapshot().samples.length, 1);
  assert.equal(env.snapshot().samples[0].durationMs, 30);
});

test("Event Timing uses threshold 16, deduplicates interactions and never exports raw identifiers", () => {
  const env = fixture(); env.run();
  env.window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario("first-key");
  env.emit("keydown", { timeStamp: 45 });
  const observer = env.getObserver();
  assert.equal(observer.options.durationThreshold, 16);
  assert.equal(observer.options.buffered, false);
  observer.records.push(
    { name: "keydown", startTime: 45, duration: 24, processingStart: 50, processingEnd: 55, target: env.editor, interactionId: 98231 },
    { name: "keyup", startTime: 55, duration: 40, processingStart: 55, processingEnd: 65, target: env.editor, interactionId: 98231 },
    { name: "keydown", startTime: 48, duration: 88, processingStart: 50, processingEnd: 60, target: null, interactionId: 98232 },
    { name: "click", startTime: 45, duration: 48, target: env.editor, interactionId: 98233 },
  );
  const snapshot = env.snapshot();
  const timings = snapshot.samples.filter(sample => sample.kind === "event-timing");
  assert.equal(timings.length, 1);
  assert.equal(timings[0].durationMs, 40);
  assert.equal(timings[0].interactionSeq, 1);
  assert.equal(snapshot.counters.eventTimingCorrelated, 2);
  assert.equal(snapshot.counters.eventTimingFiltered, 2);
  assert.equal(JSON.stringify(snapshot).includes("98231"), false);
  assert.equal(snapshot.thresholds.eventTimingQuantizationMs, 8);
  // Null targets can correlate with a captured composer event's exact timestamp.
  observer.records.push({ name: "keydown", startTime: 45, duration: 16, processingStart: 50, processingEnd: 51, target: null, interactionId: 98234 });
  assert.equal(env.snapshot().samples.filter(sample => sample.kind === "event-timing").length, 2);
});

test("health reports lifecycle state without flushing observer records or copying samples", () => {
  const env = fixture(); env.run();
  env.emit("keydown", { timeStamp: 45 });
  const observer = env.getObserver();
  observer.records.push({ name: "keydown", startTime: 45, duration: 24, processingStart: 50, processingEnd: 55, target: env.editor, interactionId: 92 });
  const api = env.window.__DREAM_SKIN_INTERACTION_PROBE__;
  const originalTake = observer.takeRecords;
  observer.takeRecords = () => { throw new Error("health must not flush or process samples"); };
  assert.deepEqual(JSON.parse(JSON.stringify(api.health())), { active: true, visibilityInvalidated: false });
  assert.equal(observer.records.length, 1);
  env.document.visibilityState = "hidden"; env.emit("visibilitychange");
  assert.deepEqual(JSON.parse(JSON.stringify(api.health())), { active: true, visibilityInvalidated: true });
  observer.takeRecords = originalTake;
  api.cleanup();
  assert.deepEqual(JSON.parse(JSON.stringify(api.health())), { active: false, visibilityInvalidated: true });
});

test("cleanup, duration limit and reinjection cancel only owned listeners, frames and observers", () => {
  const env = fixture(); env.run({ durationMs: 1000 });
  const old = env.window.__DREAM_SKIN_INTERACTION_PROBE__;
  const oldObserver = env.getObserver();
  env.emit("input");
  assert.equal(env.frames.size, 1);
  env.run();
  assert.equal(old.snapshot().active, false);
  assert.equal(old.snapshot().counters.droppedSamples, 1);
  assert.equal(oldObserver.connected, false);
  assert.equal(env.frames.size, 0);
  assert.equal(env.timers.size, 1);
  assert.equal(env.listeners.get("keydown").size, 1);
  old.cleanup();
  assert.equal(env.listeners.get("keydown").size, 1);
  env.emit("input");
  env.document.visibilityState = "hidden"; env.emit("visibilitychange");
  const latest = env.window.__DREAM_SKIN_INTERACTION_PROBE__;
  assert.equal(latest.snapshot().visibilityInvalidated, true);
  [...env.timers.values()][0].callback();
  assert.equal(latest.snapshot().active, false);
  assert.equal(latest.snapshot().counters.pendingInputs, 0);
  assert.equal(latest.snapshot().counters.droppedSamples, 1);
  assert.equal(env.frames.size, 0);
  assert.equal(env.getObserver().connected, false);
  assert.equal([...env.listeners.values()].every(set => set.size === 0), true);
  assert.throws(() => latest.markScenario("typing"), /no longer active/);
});

test("bounded collection reports drops and unsupported Event Timing without fabricated zero samples", () => {
  const env = fixture({ eventTiming: false }); env.run({ maxSamples: 10, durationMs: 1e20 });
  for (let index = 0; index < 130; index++) env.emit("keydown");
  const snapshot = env.snapshot();
  assert.equal(snapshot.maxSamples, 10);
  assert.equal(snapshot.durationLimitMs, 300000);
  assert.equal(snapshot.samples.length, 10);
  assert.equal(snapshot.counters.droppedSamples, 120);
  assert.equal(snapshot.counters.droppedCorrelations, 2);
  assert.equal(snapshot.supported.eventTiming, false);
  assert.equal(snapshot.samples.some(sample => sample.kind === "event-timing"), false);
  assert.equal(summarizeSamples(snapshot.samples, { kind: "event-timing" }).sampleCount, 0);
});

test("fixture opt-in permits only the documented isolated editor", () => {
  const env = fixture();
  assert.throws(() => env.run({ editorSelector: "textarea" }), /fixed isolated fixture/);
  assert.throws(() => env.run({ fixture: true, editorSelector: "input" }), /fixed isolated fixture/);
  env.run({ fixture: true, editorSelector: "#benchmark-editor" });
  env.emit("keydown", { target: env.target({ composer: false }) });
  assert.equal(env.snapshot().samples.length, 1);
});

test("metric deltas use seconds-to-ms, preserve gauge endpoints and mark absent metrics null", () => {
  const result = analyzeMetricSnapshots({ metrics: [
    { name: "ScriptDuration", value: 1.2 }, { name: "LayoutCount", value: 9 }, { name: "JSHeapUsedSize", value: 500 }, { name: "Nodes", value: 70 },
  ] }, [{ name: "ScriptDuration", value: 1.5 }, { name: "LayoutCount", value: 12 }, { name: "JSHeapUsedSize", value: 490 }, { name: "Nodes", value: 80 }], { sameEpoch: true });
  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.counters.ScriptDuration.delta - 300) < 1e-9);
  assert.equal(result.counters.ScriptDuration.before, 1200);
  assert.equal(result.counters.ScriptDuration.after, 1500);
  assert.equal(result.counters.ScriptDuration.unit, "ms");
  assert.equal(result.counters.LayoutCount.delta, 3);
  assert.equal(result.counters.TaskDuration.delta, null);
  assert.deepEqual(result.gauges.JSHeapUsedSize, { unit: "bytes", before: 500, after: 490 });
  assert.deepEqual(result.gauges.JSEventListeners, { unit: "count", before: null, after: null });
  assert.equal("totalDurationMs" in result, false);
});

test("metric counter resets or unconfirmed document epoch reject all delta comparisons", () => {
  const reset = analyzeMetricSnapshots({ LayoutCount: 10, ScriptDuration: 2 }, { LayoutCount: 3, ScriptDuration: 3 }, { sameEpoch: true });
  assert.equal(reset.valid, false);
  assert.deepEqual(reset.reasons, ["counter-decreased:LayoutCount"]);
  assert.equal(reset.counters.ScriptDuration.delta, null);
  const unknownEpoch = analyzeMetricSnapshots({ ScriptDuration: 2 }, { ScriptDuration: 3 });
  assert.equal(unknownEpoch.valid, false);
  assert.equal(unknownEpoch.counters.ScriptDuration.delta, null);
  const missing = analyzeMetricSnapshots({}, {}, { sameEpoch: true });
  assert.equal(missing.counters.ScriptDuration.before, null);
  assert.equal(missing.counters.ScriptDuration.delta, null);
});

test("summary omits untrusted/missing values and withholds p95 on small observations", () => {
  assert.deepEqual(summarizeSamples([1, 3, null, NaN, -1]).sampleCount, 2);
  const small = summarizeSamples([{ durationMs: 1, trusted: true, kind: "event-timing" }, { durationMs: 300, trusted: false }, { durationMs: null }, { durationMs: 3, trusted: true, kind: "event-timing" }], { kind: "event-timing" });
  assert.equal(small.p50Ms, 2);
  assert.equal(small.p95Ms, null);
  assert.equal(small.p95Qualified, false);
  const large = summarizeSamples(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(large.p50Ms, 50.5);
  assert.ok(Math.abs(large.p95Ms - 95.05) < 1e-9);
  assert.equal(large.p95Qualified, true);
  assert.equal(summarizeSamples([]).p50Ms, null);
  assert.throws(() => summarizeSamples([{ kind: "keydown-dispatch", durationMs: 4 }, { kind: "event-timing", durationMs: 32 }]), /must not be blended/);
});

test("normal steady typing does not exhaust correlation capacity", () => {
  const env = fixture(); env.run();
  for (let index = 0; index < 200; index++) {
    env.setClock(50 + index * 40);
    env.emit("keydown"); env.emit("input");
    env.frame(66 + index * 40); env.frame(82 + index * 40);
  }
  const result = env.snapshot();
  assert.equal(result.counters.trustedKeydowns, 200);
  assert.equal(result.counters.inputs, 200);
  assert.equal(result.counters.droppedCorrelations, 0);
  assert.equal(result.counters.droppedSamples, 0);
  assert.equal(result.samples.length, 400);
});
