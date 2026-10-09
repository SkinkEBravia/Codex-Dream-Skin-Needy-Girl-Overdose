import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_MACRO_READY, parseMacroArguments, validateMacroPlan, runNativeMacro, main } from "./benchmark-native-macro.mjs";

const plan = () => ({ schema: "dream-skin-native-macro-plan/2", viewport: { width: 1200, height: 800 },
  pinnedClicks: 3, typingCharacters: 8, typingCadenceMs: 40, scrollInputs: 5, scrollPixels: 120, scrollCadenceMs: 100,
  routeIdleMs: 100, cycles: 1, timeoutMs: 120000 });

const counterNames = ["RecalcStyleCount", "LayoutCount", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration", "JSHeapUsedSize", "Nodes", "JSEventListeners"];
const near = (a, b) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

/** Minimal renderer stand-in: guard reads, trusted input events, probe snapshots and metrics. */
function fakeRendererSession() {
  const state = { route: 1, activePinned: 0, draft: "", focused: false, selectAll: false, dockTop: 40, transcriptTop: 0,
    metrics: 0, scenario: "idle", scenarioEpoch: 0, guard: false, probe: false, deadlineNow: false, interruptNow: false,
    inputs: 0, keydowns: 0, characters: 0, mouseDown: false, heldKeys: new Set() };
  const pinned = [{ x: 100, y: 100 }, { x: 100, y: 140 }, { x: 100, y: 180 }];
  const initialRow = { x: 100, y: 400 };
  let clock = 0;
  const read = (expected = null) => ({ width: 1200, height: 800, timeOrigin: 1000, visible: true, documentFocused: true,
    initialRowKnown: true, editorCount: 1, editorEmpty: state.draft.length === 0,
    editorMatchesExpected: expected !== null && state.draft === expected, editorFocused: state.focused,
    composerPoint: { x: 600, y: 700 }, composerPointValid: true, routeTrackingSupported: true, route: state.route,
    pinnedCount: pinned.length, pinnedActive: state.activePinned, pinnedPoints: pinned,
    dock: { top: state.dockTop, max: 1600 }, dockPoint: { x: 130, y: 400 },
    transcript: { top: state.transcriptTop, max: 9000 }, transcriptPoint: { x: 600, y: 500 } });
  const session = {
    closed: false,
    get interrupt() { return state.interruptNow; },
    async send(method, params = {}) {
      if (method === "Performance.enable") return {};
      if (method === "Performance.getMetrics") {
        state.metrics += 7;
        return { metrics: counterNames.map((name, i) => ({ name, value: state.metrics * 10 + i })) };
      }
      if (method === "Input.dispatchMouseEvent") {
        if (params.type === "mouseReleased") { state.mouseDown = false; return {}; }
        if (params.type === "mouseWheel") {
          if (near(params, { x: 130, y: 400 })) state.dockTop = Math.min(1600, Math.max(0, state.dockTop + params.deltaY));
          else if (near(params, { x: 600, y: 500 })) state.transcriptTop = Math.min(9000, Math.max(0, state.transcriptTop + params.deltaY));
          else throw Error("wheel missed its container");
          return {};
        }
        if (params.type === "mousePressed") {
          state.mouseDown = true;
          const k = pinned.findIndex(p => near(p, params));
          if (k >= 0) { state.activePinned = k + 1; state.route = 10 + k; state.focused = false; state.draft = ""; return {}; }
          if (near(params, initialRow)) { state.activePinned = 0; state.route = 1; state.focused = false; state.draft = ""; return {}; }
          if (near(params, { x: 600, y: 700 })) { state.focused = true; return {}; }
          throw Error("click missed every known target");
        }
        return {};
      }
      if (method === "Input.dispatchKeyEvent") {
        const held = `${params.key}:${params.modifiers ?? 0}`;
        if (params.type === "rawKeyDown") { state.heldKeys.add(held); if (state.focused) state.keydowns++; }
        if (params.type === "keyUp") state.heldKeys.delete(held);
        if (params.type === "rawKeyDown" && params.key === "a" && params.modifiers === 2) { state.selectAll = true; return {}; }
        if (params.type === "rawKeyDown" && params.key === "Backspace") {
          state.draft = state.selectAll ? "" : state.draft.slice(0, -1);
          if (state.focused) state.inputs++;
          state.selectAll = false;
          return {};
        }
        if (params.type === "char" && typeof params.text === "string") {
          state.characters++;
          if (state.focused) { state.draft += params.text; state.inputs++; }
          if (state.draft.length >= 3) state.deadlineNow = true;
          if (state.draft.length >= 4) state.interruptNow = true;
          return {};
        }
        return {};
      }
      throw Error(`unexpected CDP command: ${method}`);
    },
    async evaluate(expression) {
      // The probe-install expression embeds installInteractionProbe's source, which
      // itself contains "markScenario("; match the install marker first.
      if (expression.includes("probe-already-present")) { state.probe = true; return true; }
      if (expression.includes("macro-guard-already-present")) { state.guard = true; return read(); }
      if (expression.includes("markScenario(")) { state.scenario = JSON.parse(expression.match(/markScenario\((("(?:[^"\\]|\\.)*")|null)\)/)[1]); state.scenarioEpoch++; return state.scenarioEpoch; }
      if (expression.includes("__DREAM_SKIN_INTERACTION_PROBE__.snapshot()")) return { version: 1, active: true, fixture: false,
        supported: { eventTiming: true, animationFrame: true }, thresholds: { eventTimingDurationMs: 16, eventTimingQuantizationMs: 8 },
        durationLimitMs: 125000, maxSamples: 10000, scenario: state.scenario, scenarioEpoch: state.scenarioEpoch, visibilityInvalidated: false,
        counters: { trustedKeydowns: state.keydowns, untrustedIgnored: 0, inputs: state.inputs, compositionStarts: 0, compositionEnds: 0, eventTimingEntries: 0,
          eventTimingCorrelated: 0, eventTimingFiltered: 0, droppedSamples: 0, droppedCorrelations: 0, pendingInputs: 0 }, samples: [] };
      if (expression.includes("collectorToken")) { state.probe = false; state.guard = false; return true; }
      if (expression.includes("restoreInitial()")) { if (!state.guard) throw Error("macro-owner-lost"); return initialRow; }
      if (expression.includes("return s.read(")) {
        if (!state.guard) throw Error("macro-owner-lost");
        const match = expression.match(/return s\.read\((null|"(?:[^"\\]|\\.)*")\)/);
        return read(match && match[1] !== "null" ? JSON.parse(match[1]) : null);
      }
      if (expression.includes("requestAnimationFrame")) return true;
      throw Error(`unexpected renderer evaluation: ${expression.slice(0, 60)}`);
    },
  };
  return { session, state, clock: () => clock, tick: ms => { clock += ms; } };
}

test("smoke plan with scrollInputs 0 runs pinned switching and typing only", async () => {
  const harness = fakeRendererSession();
  const smoke = { ...plan(), scrollInputs: 0 };
  const report = await runNativeMacro(harness.session, smoke, { now: harness.clock, pause: async ms => harness.tick(ms) });
  assert.equal(report.status, "completed");
  assert.deepEqual(report.observations.map(o => o.scenario), ["switch", "switch", "switch", "first-key", "typing"]);
  assert.equal(report.draftRestored, true);
  assert.equal(report.routeRestored, true);
  assert.equal(harness.state.route, 1);
});
test("mocked pinned switching, preset typing and scrolling complete with full restoration", async () => {
  assert.equal(NATIVE_MACRO_READY, true);
  const harness = fakeRendererSession();
  const report = await runNativeMacro(harness.session, plan(), { now: harness.clock, pause: async ms => harness.tick(ms) });
  assert.equal(report.status, "completed");
  assert.equal(report.reason, null);
  assert.deepEqual(report.observations.map(o => o.scenario), ["switch", "switch", "switch", "first-key", "typing", "scroll-dock", "scroll-transcript"]);
  assert.equal(report.observations[2].action.completedSwitches, 3);
  assert.equal(report.observations[4].action.characters, 8);
  assert.equal(report.observations[4].inputs, 8);
  assert.equal(report.observations[4].keydowns, 8);
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.draftRestored, true);
  assert.equal(report.routeRestored, true);
  assert.equal(harness.state.draft, "");
  assert.equal(harness.state.route, 1);
  assert.equal(harness.state.dockTop, 0);
  assert.equal(harness.state.transcriptTop, 0);
  assert.equal(harness.state.guard, false);
  assert.equal(harness.state.probe, false);
});
for (const count of [1, 54, 200]) test(`typing executes exactly ${count} steady characters after the separate first key`, async () => {
  const harness = fakeRendererSession();
  const report = await runNativeMacro(harness.session, { ...plan(), typingCharacters: count, scrollInputs: 0 }, { now: harness.clock, pause: async ms => harness.tick(ms) });
  assert.equal(report.status, "completed");
  const first = report.observations.find(o => o.scenario === "first-key"), typing = report.observations.find(o => o.scenario === "typing");
  assert.equal(first.inputs, 1);
  assert.equal(typing.action.characters, count);
  assert.equal(typing.inputs, count);
  assert.equal(typing.keydowns, count);
  assert.equal(harness.state.characters, count + 1);
  assert.equal(harness.state.draft, "");
});
test("missing trusted input evidence rejects a typing phase even when the draft matches", async () => {
  const harness = fakeRendererSession(), original = harness.session.evaluate;
  harness.session.evaluate = async expression => {
    const value = await original(expression);
    if (expression.includes("__DREAM_SKIN_INTERACTION_PROBE__.snapshot()")) value.counters.inputs = 0;
    return value;
  };
  const report = await runNativeMacro(harness.session, plan(), { now: harness.clock, pause: async ms => harness.tick(ms) });
  assert.equal(report.status, "invalid");
  assert.equal(report.reason, "macro-input-count-mismatch");
  assert.equal(report.draftRestored, true);
  assert.equal(report.routeRestored, true);
});
for (const failure of ["interrupt", "deadline"]) test(`${failure} immediately after mouse press still releases the mouse and restores the route`, async () => {
  const harness = fakeRendererSession(), original = harness.session.send;
  let armed = false;
  harness.session.send = async (method, params) => {
    const value = await original(method, params);
    if (!armed && params?.type === "mousePressed") { armed = true; harness.state.interruptNow = true; harness.state.deadlineNow = true; }
    return value;
  };
  const report = await runNativeMacro(harness.session, plan(), {
    now: () => failure === "deadline" && armed ? 9e12 : harness.clock(),
    pause: async ms => harness.tick(ms), interrupted: () => failure === "interrupt" && armed,
  });
  assert.equal(report.status, "invalid");
  assert.equal(report.reason, failure === "interrupt" ? "macro-interrupted" : "macro-deadline-exceeded");
  assert.equal(harness.state.mouseDown, false);
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.routeRestored, true);
});
test("failed release during restoration is retried by final cleanup", async () => {
  const harness = fakeRendererSession(), original = harness.session.send;
  let restoring = false, failed = false;
  harness.session.send = async (method, params) => {
    if (params?.type === "mousePressed" && params.y === 400) restoring = true;
    if (restoring && !failed && params?.type === "mouseReleased") { failed = true; throw Error("release timeout"); }
    return original(method, params);
  };
  const report = await runNativeMacro(harness.session, { ...plan(), scrollInputs: 0 }, { now: harness.clock, pause: async ms => harness.tick(ms) });
  assert.equal(failed, true);
  assert.equal(harness.state.mouseDown, false);
  assert.equal(report.cleanupConfirmed, true);
  // The restoration command failed; do not claim verified route restoration.
  assert.equal(report.status, "invalid");
});
test("persistent mouse release failure cannot report confirmed cleanup", async () => {
  const harness = fakeRendererSession(), original = harness.session.send;
  harness.session.send = async (method, params) => {
    if (params?.type === "mouseReleased") throw Error("release timeout");
    return original(method, params);
  };
  const report = await runNativeMacro(harness.session, plan(), { now: harness.clock, pause: async ms => harness.tick(ms) });
  assert.equal(report.status, "invalid");
  assert.equal(report.cleanupConfirmed, false);
  assert.equal(harness.state.mouseDown, true);
});
for (const key of ["a", "Backspace"]) test(`interruption during draft cleanup releases held ${key}`, async () => {
  const harness = fakeRendererSession(), original = harness.session.send;
  let armed = false;
  harness.session.send = async (method, params) => {
    const value = await original(method, params);
    if (params?.type === "rawKeyDown" && params.key === key && (key === "Backspace" || params.modifiers === 2)) armed = true;
    return value;
  };
  const report = await runNativeMacro(harness.session, plan(), { now: harness.clock, pause: async ms => harness.tick(ms), interrupted: () => armed });
  assert.equal(report.status, "invalid");
  assert.equal(harness.state.heldKeys.size, 0);
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.draftRestored, true);
  assert.equal(report.routeRestored, true);
});
test("deadline expiry during an owned draft still cleans the draft and restores the route", async () => {
  const harness = fakeRendererSession();
  // The stand-in arms deadlineNow once its draft holds >= 2 characters, mid-typing phase.
  const report = await runNativeMacro(harness.session, plan(), { now: () => (harness.state.deadlineNow ? 9e12 : harness.clock()), pause: async ms => harness.tick(ms) });
  assert.equal(report.status, "invalid");
  assert.equal(report.reason, "macro-deadline-exceeded");
  assert.equal(report.draftRestored, true);
  assert.equal(report.routeRestored, true);
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(harness.state.draft, "");
  assert.equal(harness.state.route, 1);
  assert.equal(harness.state.guard, false);
});
test("interrupt during an owned draft releases cleanup from the deadline gate", async () => {
  const harness = fakeRendererSession();
  const report = await runNativeMacro(harness.session, plan(), { now: harness.clock, pause: async ms => harness.tick(ms), interrupted: () => harness.state.interruptNow });
  assert.equal(report.status, "invalid");
  assert.equal(report.reason, "macro-interrupted");
  assert.equal(report.draftRestored, true);
  assert.equal(report.routeRestored, true);
  assert.equal(harness.state.draft, "");
  assert.equal(harness.state.route, 1);
});
test("macro plan v2 accepts bounded steps and rejects arbitrary text, stale points and out-of-range counts", () => {
  assert.deepEqual(validateMacroPlan(plan()), plan());
  for (const mutate of [p => { p.text = "private draft"; }, p => { p.points = { composer: { x: 1, y: 1 } }; }, p => { p.typingCharacters = 201; },
    p => { p.timeoutMs = 120001; }, p => { p.pinnedClicks = 4; }, p => { p.cycles = 0; }, p => { p.viewport.height = 0; }]) {
    const value = plan(); mutate(value); assert.throws(() => validateMacroPlan(value), /macro-plan-invalid/);
  }
});
test("macro CLI refuses duplicate identity arguments and redirected report paths", () => {
  const args = ["--port", "9333", "--browser-id", "verified-browser", "--plan", "evidence/plan.json", "--output", "evidence/result.json"];
  assert.equal(parseMacroArguments(args).port, 9333);
  for (const bad of [[...args, "--port", "9334"], args.map(v => v === "evidence/result.json" ? "../private.json" : v),
    args.map(v => v === "evidence/plan.json" ? "C:/private.json" : v), args.map(v => v === "9333" ? "80" : v)]) {
    assert.throws(() => parseMacroArguments(bad), /macro-arguments-invalid/);
  }
});
test("macro CLI refuses arguments before touching the app or filesystem", async () => {
  await assert.rejects(main([]), /macro-arguments-invalid/);
});
