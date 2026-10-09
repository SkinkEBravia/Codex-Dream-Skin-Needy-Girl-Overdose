import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_MACRO_READY, parseMacroArguments, validateMacroPlan, runNativeMacro, main } from "./benchmark-native-macro.mjs";

const plan = () => ({ schema: "dream-skin-native-macro-plan/1", viewport: { width: 1200, height: 800 },
  points: Object.fromEntries(["composer", "sessionA", "sessionB", "dock", "transcript"].map(role => [role, { x: 100, y: 100 }])),
  typingCharacters: 200, typingCadenceMs: 40, scrollInputs: 5, scrollPixels: 120, scrollCadenceMs: 100,
  routeIdleMs: 1000, cycles: 1, timeoutMs: 120000 });

test("unfinished native controller refuses both entry points before touching the app or filesystem", async () => {
  assert.equal(NATIVE_MACRO_READY, false);
  const session = { send() { throw Error("Input must never be sent"); }, evaluate() { throw Error("Renderer must never be touched"); } };
  await assert.rejects(runNativeMacro(session, plan()), /native-macro-not-ready/);
  await assert.rejects(main([]), /native-macro-not-ready/);
});
test("macro plan accepts bounded numeric steps and rejects arbitrary text, unknown fields and out-of-viewport points", () => {
  assert.deepEqual(validateMacroPlan(plan()), plan());
  for (const mutate of [p => { p.text = "private draft"; }, p => { p.typingCharacters = 201; }, p => { p.timeoutMs = 120001; },
    p => { p.points.composer.x = 1200; }, p => { p.points.dock.y = NaN; }, p => { p.cycles = 0; }, p => { p.viewport.height = 0; }]) {
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
