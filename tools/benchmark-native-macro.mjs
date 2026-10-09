import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CdpSession, connectBrowserIdentityAnchor } from "../windows/scripts/injector.mjs";
import { inspectNativeContext, validateOutputPath, sanitizeProbeSnapshot } from "./record-native-interactions.mjs";
import { installInteractionProbe, analyzeMetricSnapshots, summarizeSamples } from "./interaction-probe.mjs";

const SLOT = "__DREAM_SKIN_NATIVE_MACRO_GUARD__";
// Checkpoint only. Enable after the independent automation module is verified.
export const NATIVE_MACRO_READY = false;
const roles = ["composer", "sessionA", "sessionB", "dock", "transcript"];
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
  if (!exactKeys(plan, ["schema", "viewport", "points", "typingCharacters", "typingCadenceMs", "scrollInputs", "scrollPixels", "scrollCadenceMs", "routeIdleMs", "cycles", "timeoutMs"])
    || plan.schema !== "dream-skin-native-macro-plan/1" || !exactKeys(plan.viewport, ["width", "height"])
    || ![plan.viewport.width, plan.viewport.height].every(n => Number.isInteger(n) && n >= 400 && n <= 8192)
    || !exactKeys(plan.points, roles)) throw Error("macro-plan-invalid");
  for (const point of Object.values(plan.points)) if (!exactKeys(point, ["x", "y"]) || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.y < 0 || point.x >= plan.viewport.width || point.y >= plan.viewport.height) throw Error("macro-plan-invalid");
  for (const [key, low, high] of [["typingCharacters", 1, 200], ["typingCadenceMs", 20, 200], ["scrollInputs", 1, 10],
    ["scrollPixels", 20, 600], ["scrollCadenceMs", 50, 300], ["routeIdleMs", 0, 3000], ["cycles", 1, 3], ["timeoutMs", 10000, 120000]]) {
    if (!Number.isInteger(plan[key]) || plan[key] < low || plan[key] > high) throw Error("macro-plan-invalid");
  }
  return JSON.parse(JSON.stringify(plan));
}

/** Renderer-local route identity never crosses CDP. Only booleans/numbers are returned. */
export function installMacroGuard(token, points) {
  const slot = "__DREAM_SKIN_NATIVE_MACRO_GUARD__";
  if (window[slot]) throw Error("macro-guard-already-present");
  const composer = '.composer-surface-chrome,[class*="_ComposerLayoutRoot_"],[data-codex-composer-root],[data-ds-part="composer"],[data-composer-surface-variant][data-composer-radius-variant]';
  const visible = e => e && !e.closest('[hidden],[inert],[aria-hidden="true"],[data-app-shell-active-page="false"]') && e.getClientRects().length > 0;
  const editor = () => [...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]')]
    .filter(e => visible(e) && e.closest(composer));
  const route = () => {
    const page = [...document.querySelectorAll('[data-app-shell-active-page="true"]')].find(visible);
    const unit = (page ?? document.querySelector('main')).querySelector('[data-content-search-unit-key]');
    // The private key and URL stay only in this collector-owned renderer closure.
    return unit ? `${location.href}\n${unit.getAttribute('data-content-search-unit-key')}` : null;
  };
  const initialRoute = route(), routeIds = new Map();
  if (initialRoute !== null) routeIds.set(initialRoute, 1);
  const sidebar = e => !!e?.closest('aside.app-shell-left-panel,[data-testid="app-shell-floating-left-panel"],.sidebar-navigation');
  const nearestScroll = p => {
    let e = document.elementFromPoint(p.x, p.y);
    for (let i = 0; e && i < 24; i++, e = e.parentElement) {
      if (e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return e;
    }
    return null;
  };
  const text = e => e.tagName === "TEXTAREA" ? e.value : e.textContent;
  window[slot] = { token, read(expected = null) {
    const candidates = editor(), e = candidates.length === 1 ? candidates[0] : null, key = route();
    if (key !== null && !routeIds.has(key)) routeIds.set(key, routeIds.size + 1);
    const dock = nearestScroll(points.dock), transcript = nearestScroll(points.transcript);
    const pointElement = document.elementFromPoint(points.composer.x, points.composer.y);
    return { width: innerWidth, height: innerHeight, timeOrigin: performance.timeOrigin,
      visible: document.visibilityState === "visible", documentFocused: document.hasFocus(),
      editorCount: candidates.length, editorEmpty: !!e && text(e).length === 0,
      editorMatchesExpected: !!e && expected !== null && text(e) === expected,
      editorFocused: !!e && (document.activeElement === e || e.contains(document.activeElement)),
      composerPointValid: !!pointElement?.closest(composer),
      sessionAPointValid: sidebar(document.elementFromPoint(points.sessionA.x, points.sessionA.y)),
      sessionBPointValid: sidebar(document.elementFromPoint(points.sessionB.x, points.sessionB.y)),
      routeTrackingSupported: initialRoute !== null && key !== null, route: key === null ? 0 : routeIds.get(key),
      dock: dock && sidebar(dock) ? { top: dock.scrollTop, max: dock.scrollHeight - dock.clientHeight } : null,
      transcript: transcript && !sidebar(transcript) && !transcript.closest(composer)
        ? { top: transcript.scrollTop, max: transcript.scrollHeight - transcript.clientHeight } : null };
  } };
  // A force-terminated controller must not retain private route keys indefinitely.
  const timeout = setTimeout(() => { if (window[slot]?.token === token) delete window[slot]; routeIds.clear(); }, 125000);
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
  const send = async (method, params = {}) => { checkDeadline(); return session.send(method, params, Math.min(3000, Math.max(1, deadline - now()))); };
  const evaluate = async expression => { checkDeadline(); return session.evaluate(expression, Math.min(3000, Math.max(1, deadline - now()))); };
  const guardExpression = expected => `(()=>{const s=window.${SLOT};if(s?.token!==${JSON.stringify(token)})throw Error('macro-owner-lost');return s.read(${JSON.stringify(expected)});})()`;
  const read = async (expected = null) => {
    const s = await evaluate(guardExpression(expected));
    if (!s || s.width !== plan.viewport.width || s.height !== plan.viewport.height || !s.visible || s.editorCount !== 1 || !s.composerPointValid
      || !s.sessionAPointValid || !s.sessionBPointValid || (epoch != null && s.timeOrigin !== epoch)) throw Error("macro-layout-or-document-changed");
    return s;
  };
  const click = async point => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  const key = async (type, key, code, windowsVirtualKeyCode, modifiers = 0, text = undefined) =>
    send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers, ...(text === undefined ? {} : { text }) });
  const x = async () => { await key("rawKeyDown", "x", "KeyX", 88); await key("char", "x", "KeyX", 88, 0, "x"); await key("keyUp", "x", "KeyX", 88); };
  const frames = async () => evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const probe = async () => sanitizeProbeSnapshot(await evaluate("window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot()"));
  const clearOwned = async () => {
    if (!pendingOwned) return;
    const s = await read(pendingOwned);
    if (!s.editorFocused || !s.editorMatchesExpected || s.route !== owningRoute) throw Error("macro-owned-draft-changed");
    await key("rawKeyDown", "a", "KeyA", 65, 2); await key("keyUp", "a", "KeyA", 65, 2);
    await key("rawKeyDown", "Backspace", "Backspace", 8); await key("keyUp", "Backspace", "Backspace", 8);
    await frames(); if (!(await read()).editorEmpty) throw Error("macro-draft-cleanup-incomplete");
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
  try {
    const initial = await evaluate(`(${installMacroGuard.toString()})(${JSON.stringify(token)},${JSON.stringify(plan.points)})`);
    guardInstalled = true; epoch = initial.timeOrigin;
    const s = await read();
    if (!s.editorEmpty) throw Error("macro-existing-draft");
    if (!s.routeTrackingSupported || s.route !== 1) throw Error("macro-route-tracking-unavailable");
    await send("Performance.enable");
    await evaluate(`(()=>{if(window.__DREAM_SKIN_INTERACTION_PROBE__)throw Error('probe-already-present');(${installInteractionProbe.toString()})({maxSamples:10000,durationMs:125000});window.__DREAM_SKIN_INTERACTION_PROBE__.collectorToken=${JSON.stringify(token)};return true;})()`);
    probeInstalled = true;
    const waitRoute = async expected => {
      const limit = Math.min(deadline, now() + 5000); let state;
      do { state = await read(); if (state.route === expected) { await pause(plan.routeIdleMs); return state; } await pause(50); } while (now() < limit);
      throw Error("macro-route-incomplete");
    };
    for (let cycle = 0; cycle < plan.cycles; cycle++) {
      await phase("switch", async () => {
        if (!(await read()).editorEmpty) throw Error("macro-existing-draft");
        await click(plan.points.sessionB); let b;
        const limit = Math.min(deadline, now() + 5000);
        do { b = await read(); if (b.route !== 1 && b.route > 0) break; await pause(50); } while (now() < limit);
        if (!b || b.route === 1 || !b.route) throw Error("macro-route-incomplete");
        if (!b.editorEmpty) throw Error("macro-existing-draft");
        await pause(plan.routeIdleMs); await click(plan.points.sessionA); await waitRoute(1);
        return { completedSwitches: 2 };
      });
      await click(plan.points.composer);
      if (!(await read()).editorFocused || !(await read()).editorEmpty) throw Error("macro-editor-focus-or-draft");
      owningRoute = 1;
      await phase("first-key", async () => { pendingOwned = "x"; await x(); if (!(await read(pendingOwned)).editorMatchesExpected) throw Error("macro-input-incomplete"); return { characters: 1 }; });
      await clearOwned();
      await phase("typing", async () => {
        for (let i = 0; i < plan.typingCharacters; i++) {
          const s = await read(pendingOwned);
          if (!s.editorFocused || s.route !== owningRoute || !(pendingOwned ? s.editorMatchesExpected : s.editorEmpty)) throw Error("macro-owned-draft-changed");
          pendingOwned += "x"; await x(); await pause(plan.typingCadenceMs);
        }
        if (!(await read(pendingOwned)).editorMatchesExpected) throw Error("macro-input-incomplete");
        return { characters: plan.typingCharacters, requestedCadenceMs: plan.typingCadenceMs };
      });
      await clearOwned();
      for (const target of ["dock", "transcript"]) {
        const start = (await read())[target], distance = plan.scrollInputs * plan.scrollPixels;
        if (!start || start.max < distance) throw Error("macro-scroll-range-insufficient");
        const direction = start.top + distance <= start.max ? 1 : start.top >= distance ? -1 : 0;
        if (!direction) throw Error("macro-scroll-range-insufficient");
        const wheel = deltaY => send("Input.dispatchMouseEvent", { type: "mouseWheel", ...plan.points[target], deltaX: 0, deltaY });
        await phase(target === "dock" ? "scroll-dock" : "scroll-transcript", async () => {
          for (let i = 0; i < plan.scrollInputs; i++) { await read(); await wheel(direction * plan.scrollPixels); await pause(plan.scrollCadenceMs); }
          await frames(); const end = (await read())[target];
          if (!end || Math.abs(end.top - start.top - direction * distance) > 4) throw Error("macro-scroll-incomplete");
          return { wheelInputs: plan.scrollInputs, direction, requestedPixels: distance, observedPixels: end.top - start.top };
        });
        for (let i = 0; i < plan.scrollInputs; i++) { await wheel(-direction * plan.scrollPixels); await pause(plan.scrollCadenceMs); }
        await frames(); if (Math.abs((await read())[target].top - start.top) > 4) throw Error("macro-scroll-restore-incomplete");
      }
    }
    status = "completed"; reason = null;
  } catch (e) {
    const allowed = new Set(["macro-interrupted", "macro-deadline-exceeded", "macro-layout-or-document-changed", "macro-existing-draft", "macro-route-tracking-unavailable", "macro-route-incomplete", "macro-editor-focus-or-draft", "macro-owned-draft-changed", "macro-input-incomplete", "macro-draft-cleanup-incomplete", "macro-probe-loss", "macro-counter-reset", "macro-scroll-range-insufficient", "macro-scroll-incomplete", "macro-scroll-restore-incomplete"]);
    reason = allowed.has(e.message) ? e.message : "macro-failed";
  } finally {
    try { await clearOwned(); } catch { if (pendingOwned) reason = "macro-draft-cleanup-unconfirmed"; }
    try { const s = await read(); if (s.route !== 1 && !pendingOwned) { await click(plan.points.sessionA); await pause(300); } routeRestored = (await read()).route === 1; } catch {}
    // Cleanup is allowed even after the action deadline; never operate an unowned probe.
    try { cleanupConfirmed = await session.evaluate(`(()=>{const p=window.__DREAM_SKIN_INTERACTION_PROBE__,g=window.${SLOT};let ok=true;if(${probeInstalled}){if(p?.collectorToken!==${JSON.stringify(token)})ok=false;else{p.cleanup();delete window.__DREAM_SKIN_INTERACTION_PROBE__;}}if(${guardInstalled}){if(g?.token!==${JSON.stringify(token)})ok=false;else g.cleanup();}return ok;})()`, 3000); } catch {}
  }
  if (!cleanupConfirmed || pendingOwned || !routeRestored) { status = "invalid"; reason ??= "macro-restoration-unconfirmed"; }
  return { schema: "dream-skin-native-macro/1", source: "cdp-macro", status, reason, plan, observations,
    cleanupConfirmed, draftRestored: pendingOwned === "", routeRestored,
    limitations: ["Targeted trusted Chromium input, not physical Windows keyboard or OS IME.", "Timing proxies are not confirmed displayed pixels; Event Timing is thresholded.", "Cadence is a driver wait after completed commands; guards add overhead.", "Input and work metrics exclude screenshots; live app/background workload remain uncontrolled."] };
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
    console.log("Verified native macro started; fixed unsent text and wheel inputs only.");
    const report = await runNativeMacro(session, plan, { interrupted: () => interrupted || anchor.closed });
    const reportBytes = JSON.stringify(report, null, 2) + "\n"; if (Buffer.byteLength(reportBytes) > 2 * 1024 * 1024) throw Error("macro-report-bound");
    await fs.writeFile(output, reportBytes, { flag: "wx" });
    console.log(report.status === "completed" ? "Native macro completed; owned draft and initial route restored." : "Native macro rejected; bounded numeric report written.");
    return report;
  } finally { session?.close(); anchor?.close(); process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(r => { if (r.status !== "completed") process.exitCode = 1; }).catch(e => { console.error(e.message === "native-macro-not-ready" ? "Native macro is disabled: independent automation module is unfinished." : "Native macro could not start; no private context exported."); process.exitCode = 1; });
