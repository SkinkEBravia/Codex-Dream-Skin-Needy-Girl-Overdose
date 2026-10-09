import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CdpSession, connectBrowserIdentityAnchor } from "../windows/scripts/injector.mjs";
import { inspectNativeContext, validateOutputPath, sanitizeProbeSnapshot } from "./record-native-interactions.mjs";
import { installInteractionProbe, analyzeMetricSnapshots, summarizeSamples } from "./interaction-probe.mjs";

const SLOT = "__DREAM_SKIN_NATIVE_MACRO_GUARD__";
// Bounded preset draft: lowercase ASCII letters, digits and spaces only.
const PRESET_TEXT = "the quick brown fox jumps over the lazy dog 0123456789";
// Enabled: mocked actor/recovery tests pass; keep the bounded live smoke as the release gate.
export const NATIVE_MACRO_READY = true;
const exactKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o)
  && Object.keys(o).sort().join() === [...keys].sort().join();
const relativeJson = s => typeof s === "string" && !path.isAbsolute(s) && /^[A-Za-z0-9_.\/-]+\.json$/.test(s)
  && !s.split("/").some(p => !p || p === "." || p === "..");
export function parseMacroArguments(args) {
  const flags = new Set(["--port", "--browser-id", "--plan", "--output"]), values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.has(args[i]) || Object.hasOwn(values, args[i]) || !args[i + 1]) throw Error("macro-arguments-invalid");
    values[args[i]] = args[i + 1];
  }
  const port = Number(values["--port"]), browserId = values["--browser-id"], plan = values["--plan"], output = values["--output"];
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9._-]{1,200}$/.test(browserId ?? "")
    || !relativeJson(plan) || !relativeJson(output) || plan === output) throw Error("macro-arguments-invalid");
  return { port, browserId, plan, output };
}
export function validateMacroPlan(plan) {
  if (!exactKeys(plan, ["schema", "viewport", "pinnedClicks", "typingCharacters", "typingCadenceMs", "scrollInputs", "scrollPixels", "scrollCadenceMs", "routeIdleMs", "cycles", "timeoutMs"])
    || plan.schema !== "dream-skin-native-macro-plan/2" || !exactKeys(plan.viewport, ["width", "height"])
    || ![plan.viewport.width, plan.viewport.height].every(n => Number.isInteger(n) && n >= 400 && n <= 8192)) throw Error("macro-plan-invalid");
  for (const [key, low, high] of [["pinnedClicks", 1, 3], ["typingCharacters", 1, 200], ["typingCadenceMs", 20, 200], ["scrollInputs", 0, 10],
    ["scrollPixels", 20, 600], ["scrollCadenceMs", 50, 300], ["routeIdleMs", 0, 3000], ["cycles", 1, 3], ["timeoutMs", 10000, 120000]]) {
    if (!Number.isInteger(plan[key]) || plan[key] < low || plan[key] > high) throw Error("macro-plan-invalid");
  }
  return JSON.parse(JSON.stringify(plan));
}

/** Renderer-local route identity never crosses CDP. Only booleans/numbers are returned. */
export function installMacroGuard(token) {
  const slot = "__DREAM_SKIN_NATIVE_MACRO_GUARD__";
  if (window[slot]) throw Error("macro-guard-already-present");
  const composer = '.composer-surface-chrome,[class*="_ComposerLayoutRoot_"],[data-codex-composer-root],[data-ds-part="composer"],[data-composer-surface-variant][data-composer-radius-variant]';
  const visible = e => e && !e.closest('[hidden],[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]') && e.getClientRects().length > 0;
  const rect = e => e.getBoundingClientRect();
  const center = e => { const r = rect(e); return { x: Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1), y: Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1) }; };
  const editor = () => [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]')]
    .filter(e => visible(e) && e.closest(composer));
  const text = e => e.tagName === "TEXTAREA" ? e.value : e.textContent;
  const sidebarRoot = () => document.querySelector('aside.app-shell-left-panel,[data-testid="app-shell-floating-left-panel"],.sidebar-navigation');
  const inSidebar = e => { const aside = sidebarRoot(); return !!aside && aside.contains(e); };
  // The active chat surface is the visible main that owns the composer editor,
  // preferring one that already carries message units; the shell also keeps a
  // hidden first main, so falling back to document.querySelector("main") is wrong.
  const surface = () => {
    const editors = editor();
    const mains = [...document.querySelectorAll("main")].filter(m => visible(m) && (editors.length === 0 || editors.some(e => m.contains(e))));
    return mains.find(m => m.querySelector('[data-content-search-unit-key]')) ?? mains[0]
      ?? [...document.querySelectorAll('[data-app-shell-active-page="true"]')].find(visible) ?? null;
  };
  const route = () => {
    const unit = surface()?.querySelector('[data-content-search-unit-key]');
    if (unit) return `${location.href}\n${unit.getAttribute('data-content-search-unit-key')}`;
    // A fresh empty conversation has zero message units; the active thread row
    // is the remaining renderer-local identity anchor.
    const label = threadRows().find(rowActive)?.getAttribute("aria-label");
    return label ? `${location.href}\nrow:${label}` : null;
  };
  const isThread = r => r.dataset ? "appActionSidebarThreadActive" in r.dataset || "appActionSidebarThreadSelected" in r.dataset : false;
  const threadRows = () => { const aside = sidebarRoot(); return aside ? [...aside.querySelectorAll('div[aria-label]')].filter(visible).filter(isThread) : []; };
  const rowActive = r => r.getAttribute("aria-current") === "page"
    || r.getAttribute("data-app-action-sidebar-thread-active") === "true" || r.getAttribute("data-app-action-sidebar-thread-selected") === "true";
  const isSectionHeader = b => /(^|\s)group\/section/.test((b.className || "").toString());
  const isPinnedHeader = b => /^置顶$|^pinned$/i.test((b.textContent || "").trim());
  const pinned = () => {
    const aside = sidebarRoot();
    if (!aside) return { points: [], active: 0 };
    const headers = [...aside.querySelectorAll("button")].filter(visible).filter(isSectionHeader);
    const head = headers.find(isPinnedHeader);
    if (!head) return { points: [], active: 0 };
    const after = rect(head).bottom;
    const next = headers.filter(b => b !== head).map(b => rect(b).top).filter(top => top > after);
    const limit = next.length ? Math.min(...next) : Infinity;
    const rows = threadRows().filter(r => { const top = rect(r).top; return top >= after - 2 && top < limit; }).slice(0, 3);
    const active = rows.findIndex(rowActive);
    return { points: rows.map(center), active: active >= 0 ? active + 1 : 0 };
  };
  const scrollable = e => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY);
  const dock = () => { const aside = sidebarRoot(); return aside ? [...aside.querySelectorAll("*")].filter(visible).filter(scrollable).sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null : null; };
  const transcript = () => {
    const s = surface();
    return s ? [...s.querySelectorAll("*")].filter(visible).filter(scrollable).filter(e => !inSidebar(e) && !e.closest(composer)).sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null : null;
  };
  const initialRowLabel = threadRows().find(rowActive)?.getAttribute("aria-label") ?? null;
  const routeIds = new Map(); const initialRoute = route();
  if (initialRoute !== null) routeIds.set(initialRoute, 1);
  window[slot] = { token,
    restoreInitial() {
      if (initialRowLabel === null) return null;
      const row = threadRows().find(r => r.getAttribute("aria-label") === initialRowLabel);
      if (!row) return null;
      row.scrollIntoView({ block: "center" });
      const r = rect(row);
      return r.top >= 0 && r.bottom <= innerHeight && r.width > 0 ? center(row) : null;
    },
    read(expected = null) {
      const candidates = editor(), e = candidates.length === 1 ? candidates[0] : null, key = route();
      if (key !== null && !routeIds.has(key)) routeIds.set(key, routeIds.size + 1);
      const composerPoint = e ? center(e) : null;
      const pinnedState = pinned(), dockList = dock(), transcriptList = transcript();
      return { width: innerWidth, height: innerHeight, timeOrigin: performance.timeOrigin,
        visible: document.visibilityState === "visible", documentFocused: document.hasFocus(), initialRowKnown: initialRowLabel !== null,
        editorCount: candidates.length, editorEmpty: !!e && text(e).length === 0,
        editorMatchesExpected: !!e && expected !== null && text(e) === expected,
        editorFocused: !!e && (document.activeElement === e || e.contains(document.activeElement)),
        composerPoint, composerPointValid: !!composerPoint && !!document.elementFromPoint(composerPoint.x, composerPoint.y)?.closest(composer),
        routeTrackingSupported: initialRoute !== null && key !== null, route: key === null ? 0 : routeIds.get(key),
        pinnedCount: pinnedState.points.length, pinnedActive: pinnedState.active, pinnedPoints: pinnedState.points,
        dock: dockList ? { top: dockList.scrollTop, max: dockList.scrollHeight - dockList.clientHeight } : null, dockPoint: dockList ? center(dockList) : null,
        transcript: transcriptList ? { top: transcriptList.scrollTop, max: transcriptList.scrollHeight - transcriptList.clientHeight } : null, transcriptPoint: transcriptList ? center(transcriptList) : null };
    } };
  // A force-terminated controller must not retain private route keys indefinitely.
  const timeout = setTimeout(() => { if (window[slot]?.token === token) delete window[slot]; routeIds.clear(); }, 180000);
  window[slot].cleanup = () => { clearTimeout(timeout); routeIds.clear(); if (window[slot]?.token === token) delete window[slot]; };
  return window[slot].read();
}

export async function runNativeMacro(session, plan, { now = () => performance.now(), pause = ms => new Promise(r => setTimeout(r, ms)), interrupted = () => false } = {}) {
  if (!NATIVE_MACRO_READY) throw Error("native-macro-not-ready");
  validateMacroPlan(plan);
  const token = randomUUID(), deadline = now() + plan.timeoutMs, observations = [];
  let epoch, probeInstalled = false, guardInstalled = false, pendingOwned = "", owningRoute = 0;
  let status = "invalid", reason = "macro-failed", cleanupConfirmed = false, routeRestored = false;
  const checkDeadline = () => { if (interrupted() || session.closed) throw Error("macro-interrupted"); if (now() >= deadline) throw Error("macro-deadline-exceeded"); };
  // Cleanup must also run after the action deadline or an interrupt, so the raw
  // path deliberately bypasses checkDeadline (checkpoint defect 4).
  const rawSend = async (method, params = {}) => { if (session.closed) throw Error("session-closed"); return session.send(method, params, 3000); };
  const rawEvaluate = async expression => { if (session.closed) throw Error("session-closed"); return session.evaluate(expression, 3000); };
  const send = async (method, params = {}) => { checkDeadline(); return rawSend(method, params); };
  const evaluate = async expression => { checkDeadline(); return rawEvaluate(expression); };
  const guardExpression = expected => `(()=>{const s=window.${SLOT};if(s?.token!==${JSON.stringify(token)})throw Error('macro-owner-lost');return s.read(${JSON.stringify(expected)});})()`;
  const read = async (expected = null) => {
    const s = await evaluate(guardExpression(expected));
    if (!s || s.width !== plan.viewport.width || s.height !== plan.viewport.height || !s.visible || s.editorCount !== 1 || !s.composerPointValid
      || !s.routeTrackingSupported || (epoch != null && s.timeOrigin !== epoch)) throw Error("macro-layout-or-document-changed");
    return s;
  };
  const heldKeys = [];
  const key = async (type, keyName, code, vk, modifiers = 0, text) => {
    if (type === "rawKeyDown") heldKeys.push({ keyName, code, vk, modifiers });
    await send("Input.dispatchKeyEvent", { type, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text === undefined ? {} : { text }) });
    if (type === "keyUp") { const at = heldKeys.findIndex(h => h.keyName === keyName && h.vk === vk && h.modifiers === modifiers); if (at >= 0) heldKeys.splice(at, 1); }
  };
  const click = async point => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0
      || point.x >= plan.viewport.width || point.y >= plan.viewport.height) throw Error("macro-layout-or-document-changed");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
  };
  const typeChar = async c => {
    const lower = c.toLowerCase(), digit = /[0-9]/.test(lower), space = c === " ";
    if (!digit && !space && !/[a-z]/.test(lower)) throw Error("macro-plan-invalid");
    const keyName = space ? " " : lower, code = space ? "Space" : digit ? `Digit${lower}` : `Key${lower.toUpperCase()}`;
    const vk = space ? 32 : digit ? 48 + Number(lower) : 65 + (lower.charCodeAt(0) - 97);
    await key("rawKeyDown", keyName, code, vk); await key("char", keyName, code, vk, 0, c); await key("keyUp", keyName, code, vk);
  };
  const frames = async () => evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const probe = async () => sanitizeProbeSnapshot(await evaluate("window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot()"));
  const clearOwned = async (raw = false) => {
    if (!pendingOwned) return;
    const step = raw ? rawSend : send, look = () => (raw ? rawEvaluate : evaluate)(guardExpression(pendingOwned));
    const s = await look();
    if (!s.editorFocused || !s.editorMatchesExpected || s.route !== owningRoute) throw Error("macro-owned-draft-changed");
    await step("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await step("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await step("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await step("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await (raw ? rawEvaluate : evaluate)("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    if (!(await look()).editorEmpty) throw Error("macro-draft-cleanup-incomplete");
    pendingOwned = "";
  };
  const phase = async (scenario, body) => {
    await evaluate(`window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario(${JSON.stringify(scenario)})`);
    const before = await send("Performance.getMetrics"), beforeProbe = await probe();
    const action = await body(); await frames(); await pause(160);
    const s = await read(), after = await send("Performance.getMetrics"), snapshot = await probe();
    if (!snapshot.active || snapshot.visibilityInvalidated || snapshot.counters.droppedSamples || snapshot.counters.droppedCorrelations || snapshot.counters.pendingInputs) throw Error("macro-probe-loss");
    const metrics = analyzeMetricSnapshots(before.metrics, after.metrics, { sameEpoch: s.timeOrigin === epoch });
    if (!metrics.valid) throw Error("macro-counter-reset");
    const samples = snapshot.samples.filter(v => v.scenarioEpoch === snapshot.scenarioEpoch);
    observations.push({ scenario, action, valid: true, source: "cdp-macro", metrics,
      inputs: snapshot.counters.inputs - beforeProbe.counters.inputs, keydowns: snapshot.counters.trustedKeydowns - beforeProbe.counters.trustedKeydowns,
      timings: Object.fromEntries(["keydown-dispatch", "input-two-raf", "event-timing"].map(kind => [kind, summarizeSamples(samples, { kind })])) });
  };
  const wheel = async (point, deltaY) => send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
  const livePoint = async target => { const s = await read(); if (!s[target]) throw Error("macro-scroll-range-insufficient"); return s[target]; };
  try {
    const initial = await evaluate(`(${installMacroGuard.toString()})(${JSON.stringify(token)})`);
    guardInstalled = true; epoch = initial.timeOrigin;
    const s = await read();
    if (!s.initialRowKnown) throw Error("macro-active-row-unknown");
    if (!s.editorEmpty) throw Error("macro-existing-draft");
    if (s.pinnedCount < plan.pinnedClicks) throw Error("macro-pinned-items-unavailable");
    if (s.route !== 1) throw Error("macro-route-tracking-unavailable");
    await send("Performance.enable");
    await evaluate(`(()=>{if(window.__DREAM_SKIN_INTERACTION_PROBE__)throw Error('probe-already-present');(${installInteractionProbe.toString()})({maxSamples:10000,durationMs:125000});window.__DREAM_SKIN_INTERACTION_PROBE__.collectorToken=${JSON.stringify(token)};return true;})()`);
    probeInstalled = true;
    const preset = PRESET_TEXT.slice(0, plan.typingCharacters);
    for (let cycle = 0; cycle < plan.cycles; cycle++) {
      // Sidebar ("项目栏") to the top, then each pinned conversation once in turn.
      let top = await read();
      if (!top.dock || !top.dockPoint) throw Error("macro-scroll-range-insufficient");
      for (let i = 0; top.dock.top > 2 && i < 10; i++) { await wheel(top.dockPoint, -600); await pause(plan.scrollCadenceMs); top = await read(); }
      if (top.dock.top > 2) throw Error("macro-dock-top-unreachable");
      for (let k = 1; k <= plan.pinnedClicks; k++) {
        await phase("switch", async () => {
          const before = await read();
          if (!before.editorEmpty) throw Error("macro-existing-draft");
          await click(before.pinnedPoints[k - 1]);
          const limit = Math.min(deadline, now() + 5000); let afterState;
          do { afterState = await read(); if (afterState.pinnedActive === k) break; await pause(50); } while (now() < limit);
          if (!afterState || afterState.pinnedActive !== k) throw Error("macro-route-incomplete");
          if (!afterState.editorEmpty) throw Error("macro-existing-draft");
          await pause(plan.routeIdleMs);
          return { completedSwitches: k };
        });
      }
      await click((await read()).composerPoint);
      if (!(await read()).editorFocused) throw Error("macro-editor-focus-or-draft");
      owningRoute = (await read()).route;
      await phase("first-key", async () => { pendingOwned = preset[0]; await typeChar(preset[0]); if (!(await read(pendingOwned)).editorMatchesExpected) throw Error("macro-input-incomplete"); return { characters: 1 }; });
      await clearOwned();
      await phase("typing", async () => {
        for (let i = 1; i < preset.length; i++) {
          const draft = await read(pendingOwned);
          if (!draft.editorFocused || draft.route !== owningRoute || !draft.editorMatchesExpected) throw Error("macro-owned-draft-changed");
          pendingOwned += preset[i]; await typeChar(preset[i]); await pause(plan.typingCadenceMs);
        }
        if (!(await read(pendingOwned)).editorMatchesExpected) throw Error("macro-input-incomplete");
        return { characters: preset.length, requestedCadenceMs: plan.typingCadenceMs };
      });
      await clearOwned();
      // Timed wheel phases are the benchmark workload; the pinned-switching and
      // typing smoke runs with scrollInputs 0 skip them entirely.
      for (const target of plan.scrollInputs >= 1 ? ["dock", "transcript"] : []) {
        const start = (await read())[target], pointKey = target === "dock" ? "dockPoint" : "transcriptPoint";
        const distance = plan.scrollInputs * plan.scrollPixels;
        if (!start || start.max < distance) throw Error("macro-scroll-range-insufficient");
        const direction = start.top + distance <= start.max ? 1 : start.top >= distance ? -1 : 0;
        if (!direction) throw Error("macro-scroll-range-insufficient");
        await phase(target === "dock" ? "scroll-dock" : "scroll-transcript", async () => {
          for (let i = 0; i < plan.scrollInputs; i++) { await wheel(await livePoint(pointKey), direction * plan.scrollPixels); await pause(plan.scrollCadenceMs); }
          await frames(); const end = (await read())[target];
          if (!end || Math.abs(end.top - start.top - direction * distance) > 4) throw Error("macro-scroll-incomplete");
          return { wheelInputs: plan.scrollInputs, direction, requestedPixels: distance, observedPixels: end.top - start.top };
        });
        for (let i = 0; i < plan.scrollInputs; i++) { await wheel(await livePoint(pointKey), -direction * plan.scrollPixels); await pause(plan.scrollCadenceMs); }
        await frames(); if (Math.abs((await read())[target].top - start.top) > 4) throw Error("macro-scroll-restore-incomplete");
      }
    }
    status = "completed"; reason = null;
  } catch (e) {
    const allowed = new Set(["macro-interrupted", "macro-deadline-exceeded", "macro-layout-or-document-changed", "macro-existing-draft", "macro-active-row-unknown", "macro-pinned-items-unavailable", "macro-route-tracking-unavailable", "macro-route-incomplete", "macro-editor-focus-or-draft", "macro-owned-draft-changed", "macro-input-incomplete", "macro-draft-cleanup-incomplete", "macro-probe-loss", "macro-counter-reset", "macro-scroll-range-insufficient", "macro-dock-top-unreachable", "macro-scroll-incomplete", "macro-scroll-restore-incomplete"]);
    reason = allowed.has(e.message) ? e.message : "macro-failed";
  } finally {
    try { await clearOwned(true); } catch { if (pendingOwned) reason = "macro-draft-cleanup-unconfirmed"; }
    for (const held of heldKeys.splice(0)) {
      try { await rawSend("Input.dispatchKeyEvent", { type: "keyUp", key: held.keyName, code: held.code, windowsVirtualKeyCode: held.vk, nativeVirtualKeyCode: held.vk, modifiers: held.modifiers }); } catch {}
    }
    try {
      let s = await rawEvaluate(guardExpression(null));
      if (s.route !== 1) {
        const point = await rawEvaluate(`(()=>{const s=window.${SLOT};if(s?.token!==${JSON.stringify(token)})throw Error('macro-owner-lost');return s.restoreInitial();})()`);
        if (point) {
          await rawSend("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
          await rawSend("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
          const limit = now() + 3000;
          do { await pause(100); s = await rawEvaluate(guardExpression(null)); } while (s.route !== 1 && now() < limit);
        }
      }
      routeRestored = s.route === 1;
    } catch {}
    // Cleanup is allowed even after the action deadline; never operate an unowned probe.
    try { cleanupConfirmed = await rawEvaluate(`(()=>{const p=window.__DREAM_SKIN_INTERACTION_PROBE__,g=window.${SLOT};let ok=true;if(${probeInstalled}){if(p?.collectorToken!==${JSON.stringify(token)})ok=false;else{p.cleanup();delete window.__DREAM_SKIN_INTERACTION_PROBE__;}}if(${guardInstalled}){if(g?.token!==${JSON.stringify(token)})ok=false;else g.cleanup();}return ok;})()`); } catch {}
  }
  if (!cleanupConfirmed || pendingOwned || !routeRestored) { status = "invalid"; reason ??= "macro-restoration-unconfirmed"; }
  return { schema: "dream-skin-native-macro/1", source: "cdp-macro", status, reason, plan, observations,
    cleanupConfirmed, draftRestored: pendingOwned === "", routeRestored,
    limitations: ["Targeted trusted Chromium input, not physical Windows keyboard or OS IME.", "Pinned targets and the composer point are calibrated from live DOM rectangles each step.", "Switch verification uses the sidebar active-thread marker and renderer-local route ids.", "Timing proxies are not confirmed displayed pixels; Event Timing is thresholded.", "Input and work metrics exclude screenshots; live app/background workload remain uncontrolled."] };
}

async function boundedRead(file, maxBytes) {
  const handle = await fs.open(file, "r");
  try { const bytes = Buffer.alloc(maxBytes + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); if (!bytesRead || bytesRead > maxBytes) throw Error("macro-file-bound"); return bytes.subarray(0, bytesRead); }
  finally { await handle.close(); }
}
export async function main(args = process.argv.slice(2)) {
  if (!NATIVE_MACRO_READY) throw Error("native-macro-not-ready");
  const options = parseMacroArguments(args), output = await validateOutputPath(options.output);
  const planPath = path.resolve(options.plan), root = process.cwd();
  if (!planPath.startsWith(root + path.sep)) throw Error("macro-plan-path-invalid");
  for (let p = planPath;; p = path.dirname(p)) { if ((await fs.lstat(p)).isSymbolicLink()) throw Error("macro-plan-path-invalid"); if (path.dirname(p) === p) break; }
  const plan = validateMacroPlan(JSON.parse(await boundedRead(planPath, 16384)));
  let anchor, session; let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onInterrupt);
  try {
    anchor = await connectBrowserIdentityAnchor(options.port, options.browserId);
    const response = await fetch(`http://127.0.0.1:${options.port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw Error("macro-targets-unavailable");
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 512 * 1024) throw Error("macro-target-bound"); chunks.push(chunk); }
    const targets = JSON.parse(Buffer.concat(chunks)); if (!Array.isArray(targets) || targets.length > 128) throw Error("macro-target-bound");
    for (const target of targets.filter(t => t.type === "page" && typeof t.url === "string" && t.url.startsWith("app://")).slice(0, 8)) {
      const candidate = await new CdpSession(target, options.port).open();
      let info; try { info = await candidate.evaluate(`(${inspectNativeContext.toString()})()`, 3000); } catch { candidate.close(); continue; }
      if (info?.native && info.brand && info.visible) { if (session) { candidate.close(); throw Error("macro-ambiguous-target"); } session = candidate; }
      else candidate.close();
    }
    if (!session) throw Error("macro-native-target-unavailable");
    console.log("Verified native macro started; pinned switching, fixed unsent text and wheel inputs only.");
    const report = await runNativeMacro(session, plan, { interrupted: () => interrupted || anchor.closed });
    const reportBytes = JSON.stringify(report, null, 2) + "\n"; if (Buffer.byteLength(reportBytes) > 2 * 1024 * 1024) throw Error("macro-report-bound");
    await fs.writeFile(output, reportBytes, { flag: "wx" });
    console.log(report.status === "completed" ? "Native macro completed; owned draft and initial route restored." : "Native macro rejected; bounded numeric report written.");
    return report;
  } finally { session?.close(); anchor?.close(); process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(r => { if (r.status !== "completed") process.exitCode = 1; }).catch(e => { console.error(e.message === "native-macro-not-ready" ? "Native macro is disabled: independent automation module is unfinished." : "Native macro could not start; no private context exported."); process.exitCode = 1; });
