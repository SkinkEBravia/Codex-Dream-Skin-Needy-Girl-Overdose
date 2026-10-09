/** Passive, content-free interaction timing. This function is serializable for CDP. */
export function installInteractionProbe(options = {}) {
  const slot = "__DREAM_SKIN_INTERACTION_PROBE__";
  const scenarios = new Set(["first-key", "typing", "ime", "switch", "scroll-dock", "scroll-transcript", "appearance", "theme", "startup", "idle"]);
  const fixture = options.fixture === true;
  if (options.editorSelector != null && (!fixture || options.editorSelector !== "#benchmark-editor")) {
    throw new Error("Only the fixed isolated fixture editor selector is allowed");
  }
  const boundedInteger = (value, fallback, low, high) => Number.isFinite(value)
    ? Math.min(high, Math.max(low, Math.floor(value))) : fallback;
  const maxSamples = boundedInteger(options.maxSamples, 2000, 10, 10000);
  const durationLimitMs = boundedInteger(options.durationMs, 60000, 1000, 300000);
  const prior = window[slot];
  if (prior && typeof prior.cleanup === "function") prior.cleanup();
  const composer = '.composer-surface-chrome, [class*="_ComposerLayoutRoot_"], [data-codex-composer-root], [data-ds-part="composer"], [data-composer-surface-variant][data-composer-radius-variant]';
  const editable = 'textarea, [contenteditable="true"]';
  const samples = [];
  const timers = new Set();
  const frames = new Set();
  const listeners = [];
  const recent = [];
  const correlationLimit = Math.min(20000, Math.max(128, maxSamples * 2));
  const interactions = new Map();
  const counters = {
    trustedKeydowns: 0, untrustedIgnored: 0, inputs: 0, compositionStarts: 0,
    compositionEnds: 0, eventTimingEntries: 0, eventTimingCorrelated: 0,
    eventTimingFiltered: 0, droppedSamples: 0, droppedCorrelations: 0, pendingInputs: 0,
  };
  const supported = { eventTiming: false, animationFrame: typeof requestAnimationFrame === "function" };
  let active = true;
  let scenario = "idle";
  let scenarioEpoch = 0;
  let sequence = 0;
  let interactionSequence = 0;
  let firstKey = true;
  let composing = false;
  let visibilityInvalidated = document.visibilityState !== "visible";
  let observer = null;
  const now = () => performance.now();
  const finite = value => Number.isFinite(value) && value >= 0;
  const inEditor = target => {
    if (!target || typeof target.closest !== "function") return false;
    const editor = target.closest(fixture ? "#benchmark-editor" : editable);
    if (!editor || editor.closest('input[type="password"], [hidden], [inert], [aria-hidden="true"], [data-app-shell-active-page="false"]')) return false;
    return fixture || Boolean(editor.closest(composer));
  };
  const normalizeStamp = value => {
    if (!finite(value)) return null;
    const normalized = value > 1e12 ? value - performance.timeOrigin : value;
    // A future timestamp or one outside this document's time domain is not a zero delay.
    return finite(normalized) && normalized <= now() + 1 ? normalized : null;
  };
  const metadata = () => ({ scenario, scenarioEpoch, composing });
  const add = sample => {
    if (!active) return null;
    if (samples.length >= maxSamples) { counters.droppedSamples++; return null; }
    const result = { seq: ++sequence, ...sample };
    samples.push(result);
    return result;
  };
  const remember = (name, startMs, target, details) => {
    if (startMs == null) return;
    recent.push({ name, startMs, target, ...details });
    while (recent.length && now() - recent[0].startMs > 10000) recent.shift();
    while (recent.length > correlationLimit) { recent.shift(); counters.droppedCorrelations++; }
  };
  const accepted = event => {
    if (!active || !inEditor(event.target)) return false;
    if (event.isTrusted !== true) { counters.untrustedIgnored++; return false; }
    return true;
  };
  const onKey = event => {
    if (!accepted(event)) return;
    counters.trustedKeydowns++;
    const startMs = normalizeStamp(event.timeStamp);
    const details = { ...metadata(), firstInScenario: firstKey, trusted: true };
    firstKey = false;
    remember("keydown", startMs, event.target, details);
    if (startMs == null) return;
    const delay = Math.max(0, now() - startMs);
    add({ kind: "keydown-dispatch", startMs, durationMs: delay, dispatchDelayMs: delay, ...details });
  };
  const onInput = event => {
    if (!accepted(event)) return;
    counters.inputs++;
    const startMs = now();
    const latest = [...recent].reverse().find(item => item.name === "keydown" && item.target === event.target && startMs - item.startMs <= 1000);
    const details = { ...metadata(), firstInScenario: latest?.firstInScenario ?? false, trusted: true };
    remember("input", normalizeStamp(event.timeStamp), event.target, details);
    if (!supported.animationFrame || counters.pendingInputs >= 64) { counters.droppedSamples++; return; }
    counters.pendingInputs++;
    const frame = callback => {
      const id = requestAnimationFrame(() => { frames.delete(id); if (active) callback(); });
      frames.add(id);
    };
    frame(() => frame(() => {
      counters.pendingInputs--;
      add({ kind: "input-two-raf", startMs, durationMs: Math.max(0, now() - startMs), ...details });
    }));
  };
  const composition = (event, starting) => {
    if (!accepted(event)) return;
    composing = starting;
    counters[starting ? "compositionStarts" : "compositionEnds"]++;
  };
  const consumeEntries = entries => {
    if (!active) return;
    for (const entry of entries) {
      counters.eventTimingEntries++;
      const name = entry.name;
      if (name !== "keydown" && name !== "input" && name !== "keyup") { counters.eventTimingFiltered++; continue; }
      const match = [...recent].reverse().find(item =>
        (item.name === name || (name === "keyup" && item.name === "keydown")) &&
        (entry.target ? item.target === entry.target : Math.abs(item.startMs - entry.startTime) <= 1) &&
        Math.abs(item.startMs - entry.startTime) <= (name === "keyup" ? 1000 : 8));
      if (!match || (entry.target && !inEditor(entry.target)) || !finite(entry.duration) || !finite(entry.startTime)) {
        counters.eventTimingFiltered++; continue;
      }
      counters.eventTimingCorrelated++;
      const processing = finite(entry.processingStart) && finite(entry.processingEnd) && entry.processingEnd >= entry.processingStart
        ? entry.processingEnd - entry.processingStart : null;
      const dispatch = finite(entry.processingStart) && entry.processingStart >= entry.startTime
        ? entry.processingStart - entry.startTime : null;
      // Raw interaction IDs stay inside this short-lived probe and are never exported.
      const rawId = finite(entry.interactionId) && entry.interactionId > 0 ? entry.interactionId : null;
      const previous = rawId == null ? null : interactions.get(rawId);
      if (previous) {
        if (entry.duration > previous.durationMs) {
          previous.durationMs = entry.duration;
          previous.startMs = entry.startTime;
          previous.dispatchDelayMs = dispatch;
          previous.processingDurationMs = processing;
        }
        previous.firstInScenario ||= match.firstInScenario;
        continue;
      }
      const sample = add({
        kind: "event-timing", scenario: match.scenario, scenarioEpoch: match.scenarioEpoch,
        composing: match.composing, firstInScenario: match.firstInScenario, trusted: true,
        startMs: entry.startTime, durationMs: entry.duration,
        dispatchDelayMs: dispatch, processingDurationMs: processing,
        interactionSeq: rawId == null ? null : ++interactionSequence,
      });
      if (rawId != null && sample) interactions.set(rawId, sample);
    }
  };
  const listen = (name, listener) => {
    document.addEventListener(name, listener, true);
    listeners.push([name, listener]);
  };
  listen("keydown", onKey);
  listen("input", onInput);
  listen("compositionstart", event => composition(event, true));
  listen("compositionend", event => composition(event, false));
  listen("visibilitychange", () => { if (document.visibilityState !== "visible") visibilityInvalidated = true; });
  if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("event")) {
    try {
      observer = new PerformanceObserver(list => consumeEntries(list.getEntries()));
      // Buffered=false excludes interactions that happened before the probe was installed.
      observer.observe({ type: "event", buffered: false, durationThreshold: 16 });
      supported.eventTiming = true;
    } catch { observer?.disconnect(); observer = null; }
  }
  const cleanup = () => {
    if (!active) return;
    if (observer) { consumeEntries(observer.takeRecords()); observer.disconnect(); observer = null; }
    active = false;
    for (const [name, listener] of listeners) document.removeEventListener(name, listener, true);
    listeners.length = 0;
    for (const id of frames) cancelAnimationFrame(id);
    frames.clear();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    counters.droppedSamples += counters.pendingInputs;
    counters.pendingInputs = 0;
    recent.length = 0;
    interactions.clear();
  };
  const api = {
    health() { return { active, visibilityInvalidated }; },
    snapshot() {
      if (observer) consumeEntries(observer.takeRecords());
      return {
        version: 1, active, fixture, supported: { ...supported },
        thresholds: { eventTimingDurationMs: 16, eventTimingQuantizationMs: 8 },
        durationLimitMs, maxSamples, scenario, scenarioEpoch, visibilityInvalidated,
        counters: { ...counters }, samples: samples.map(sample => ({ ...sample })),
      };
    },
    cleanup,
    markScenario(label) {
      if (!active) throw new Error("Interaction probe is no longer active");
      if (!scenarios.has(label)) throw new Error("Unknown static scenario label");
      scenario = label;
      scenarioEpoch++;
      firstKey = true;
      composing = false;
      return scenarioEpoch;
    },
  };
  window[slot] = api;
  const timeout = setTimeout(() => { timers.delete(timeout); cleanup(); }, durationLimitMs);
  timers.add(timeout);
  return api.snapshot();
}

/** Counters are cumulative seconds/counts; gauges are endpoint observations, not deltas. */
export function analyzeMetricSnapshots(before, after, { sameEpoch = false } = {}) {
  const metrics = input => {
    const source = Array.isArray(input) ? input : Array.isArray(input?.metrics) ? input.metrics : null;
    const output = Object.create(null);
    if (source) for (const item of source) {
      if (typeof item?.name === "string" && Number.isFinite(item.value) && item.value >= 0) output[item.name] = item.value;
    }
    else if (input && typeof input === "object") for (const [name, value] of Object.entries(input)) {
      if (Number.isFinite(value) && value >= 0) output[name] = value;
    }
    return output;
  };
  const left = metrics(before);
  const right = metrics(after);
  const reasons = sameEpoch === true ? [] : ["document-epoch-not-confirmed"];
  const counters = {};
  for (const name of ["RecalcStyleCount", "LayoutCount", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"]) {
    const start = left[name] ?? null;
    const end = right[name] ?? null;
    const duration = name.endsWith("Duration");
    if (start != null && end != null && end < start) reasons.push(`counter-decreased:${name}`);
    const delta = sameEpoch === true && start != null && end != null && end >= start ? (end - start) * (duration ? 1000 : 1) : null;
    counters[name] = {
      unit: duration ? "ms" : "count",
      before: start == null ? null : start * (duration ? 1000 : 1),
      after: end == null ? null : end * (duration ? 1000 : 1), delta,
    };
  }
  const gauges = {};
  for (const name of ["JSHeapUsedSize", "Nodes", "JSEventListeners"]) {
    gauges[name] = { unit: name === "JSHeapUsedSize" ? "bytes" : "count", before: left[name] ?? null, after: right[name] ?? null };
  }
  // Duration counters overlap; deliberately do not expose a summed "total" duration.
  if (reasons.length) for (const value of Object.values(counters)) value.delta = null;
  return { valid: reasons.length === 0, reasons, counters, gauges };
}

/** Report median for finite observed durations; reserve p95 for at least 100 observations.
 * Event Timing captures entries >=16 ms with 8 ms duration quantization. The first
 * keyboard event has Event Timing latency only when that event was actually emitted;
 * absent entries do not establish either zero latency or a sub-threshold upper bound.
 */
export function summarizeSamples(samples, { kind = null, scenario = null } = {}) {
  if (!kind && Array.isArray(samples)) {
    const kinds = new Set(samples.filter(sample => sample && typeof sample === "object" && sample.trusted !== false).map(sample => sample.kind).filter(Boolean));
    if (kinds.size > 1) throw new Error("Select one timing kind; dispatch, Event Timing and frame proxies must not be blended");
  }
  const values = (Array.isArray(samples) ? samples : [])
    .filter(sample => typeof sample === "number" ||
      (sample && sample.trusted !== false && (!kind || sample.kind === kind) && (!scenario || sample.scenario === scenario)))
    .map(sample => typeof sample === "number" ? sample : sample.durationMs)
    .filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const quantile = fraction => {
    if (!values.length) return null;
    const position = (values.length - 1) * fraction;
    const low = Math.floor(position);
    return values[low] + (values[Math.ceil(position)] - values[low]) * (position - low);
  };
  return {
    sampleCount: values.length, p50Ms: quantile(0.5), p95Ms: values.length >= 100 ? quantile(0.95) : null,
    minMs: values[0] ?? null, maxMs: values.at(-1) ?? null,
    p95Qualified: values.length >= 100,
    notes: ["Observed values only; filtered or missing Event Timing entries are not zero latency.",
      ...(kind === "event-timing" ? ["Event Timing uses a 16 ms reporting threshold and 8 ms duration quantization; first-key latency is available only if its entry was captured."] : []),
      ...(values.length < 100 ? ["Fewer than 100 observations: p95 withheld."] : ["p95 describes this observed sample, not a universal tail estimate."])],
  };
}
