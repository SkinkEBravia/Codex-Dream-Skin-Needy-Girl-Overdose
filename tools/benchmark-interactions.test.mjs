import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fixtureHtml, FIXTURE_PARAMETERS } from "./interaction-fixture.mjs";
import { VARIANTS, SCENARIOS, distribution, parseOptions, variantOrder, loadPinnedPayloads, runFixture } from "./benchmark-interactions.mjs";
import { installInteractionProbe } from "./interaction-probe.mjs";

test("fixed interaction workload and rotating schedule preserve first-key and typing definitions", () => {
  assert.equal(FIXTURE_PARAMETERS.typingCharacters, 200);
  assert.equal(FIXTURE_PARAMETERS.typingCadenceMs, 40);
  assert.equal(FIXTURE_PARAMETERS.firstKeyIdleMs, 1000);
  assert.equal(FIXTURE_PARAMETERS.retainedPages, 2);
  assert.equal(variantOrder(0).join(), VARIANTS.join());
  for (let i = 0; i < 3; i++) assert.equal(new Set(variantOrder(i)).size, 3);
  assert.deepEqual(variantOrder(3), variantOrder(0));
  const html = fixtureHtml();
  assert.ok(html.includes('id="benchmark-editor"'));
  assert.ok(html.includes('hidden inert aria-hidden="true"'));
  assert.ok(!html.includes("fetch("));
  assert.throws(() => fixtureHtml({ slowInputMs: -1 }));
});

test("fixture options and summaries refuse unbounded counts and fabricated missing latency", () => {
  const options = parseOptions(["--fixture", "--output", "benchmarks/phase1/local.json"]);
  assert.equal(options.trials, 10);
  assert.equal(options.warmups, 2);
  assert.deepEqual(options.scenarios, SCENARIOS);
  for (const args of [[], ["--fixture", "--output", "local.json", "--trials", "1000"],
    ["--fixture", "--output", "local.json", "--scenario", "unknown"],
    ["--fixture", "--output", "local.json", "--trials", "1", "--trials", "2"],
    ["--fixture", "--output", "local.json", "--timeout-ms", "600001"]]) assert.throws(() => parseOptions(args));
  assert.equal(distribution([]).medianMs, null);
  assert.equal(distribution([1,2]).p95Ms, null);
  assert.equal(distribution(Array.from({ length: 100 },()=>20)).p95Ms, 20);
  assert.throws(() => distribution([Infinity]));
});

const browserOptions = { skip: process.env.DREAM_SKIN_INTERACTION_BROWSER !== "1"
  ? "opt in with DREAM_SKIN_INTERACTION_BROWSER=1 and installed Playwright/Chromium" : false };

async function launch() {
  const require = createRequire(import.meta.url);
  return require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright").chromium.launch({ headless: true,
    ...(process.env.DREAM_SKIN_BROWSER_EXECUTABLE ? { executablePath: process.env.DREAM_SKIN_BROWSER_EXECUTABLE } : {}) });
}

test("real Chromium keyboard detects an induced 60ms input handler; direct DOM mutation produces no input timing", browserOptions, async () => {
  const browser = await launch();
  try {
    const snapshots = [];
    for (const slowInputMs of [0,60]) {
      const page = await browser.newPage({ viewport: FIXTURE_PARAMETERS.viewport });
      try {
        await page.setContent(fixtureHtml({ slowInputMs }));
        await page.evaluate(installInteractionProbe, { fixture: true, editorSelector: "#benchmark-editor", durationMs: 10000 });
        await page.locator("#benchmark-editor").focus();
        await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await page.waitForTimeout(100);
        await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario("first-key"));
        for(let i=0;i<5;i++){await page.keyboard.press("x");await page.waitForTimeout(150);}
        await page.waitForTimeout(100);
        const snapshot = await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot());
        assert.equal(snapshot.counters.trustedKeydowns,5);
        assert.equal(snapshot.counters.inputs,5);
        const input = snapshot.samples.find(s => s.kind === "input-two-raf");
        assert.ok(input, "Trusted keyboard produces an input scheduling sample");
        if (slowInputMs === 60) {
          assert.ok(input.durationMs >= 55, "Probe must see induced handler work in the input-to-frame proxy");
          if (snapshot.supported.eventTiming) assert.ok(snapshot.samples.some(s => s.kind === "event-timing" && s.durationMs >= 56), "Event Timing should see the induced slow interaction");
        }
        snapshots.push(snapshot);
        const epoch = await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__.markScenario("typing"));
        await page.evaluate(() => window.__DREAM_SKIN_FIXTURE__.domMutation());
        await page.waitForTimeout(100);
        const mutated = await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot());
        assert.equal(mutated.samples.filter(s => s.scenarioEpoch === epoch).length,0,"DOM-only simulation has no trusted input or Event Timing samples");
        await page.evaluate(() => window.__DREAM_SKIN_FIXTURE__.syntheticComposition());
        await page.waitForTimeout(100);
        const composed = await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__.snapshot());
        assert.ok(composed.counters.untrustedIgnored >= 3,"Synthetic IME is explicitly excluded from trusted input latency");
        assert.equal(composed.samples.filter(s => s.scenarioEpoch === epoch).length,0);
      } finally { await page.evaluate(() => window.__DREAM_SKIN_INTERACTION_PROBE__?.cleanup()).catch(()=>{}); await page.close(); }
    }
    assert.ok(distribution(snapshots[1].samples.filter(s=>s.kind==="input-two-raf").map(s=>s.durationMs)).medianMs > distribution(snapshots[0].samples.filter(s=>s.kind==="input-two-raf").map(s=>s.durationMs)).medianMs + 20,
      "Known 60ms handler regression must be distinguished from the control");
  } finally { await browser.close(); }
});

test("full pinned Windows payload fixture collects stock/original/preclean without claiming native latency", browserOptions, async () => {
  const sources = await loadPinnedPayloads();
  assert.equal(sources.original.identity.commit,"10acfa0a29d9c44e91a53bdc6bebaa42e7adf955");
  assert.equal(sources.preclean.identity.commit,"ac0cc83415deef4df7dbc77cd31be3e4abf7391f");
  assert.ok(sources.preclean.identity.assets.some(a=>a.file.endsWith("css-predicate-cache.mjs")));
  const report = await runFixture({ sources, trials: 1, warmups: 0, scenarios: ["first-key-immediate","dom-mutation","synthetic-ime","session-switch","dock-scroll","transcript-scroll","appearance"], timeoutMs: 90000 });
  assert.equal(report.runs.length,3);
  assert.equal(report.sources["stock-fixture"].nativeApp,false);
  for (const run of report.runs) {
    for (const sample of run.observations) assert.equal(sample.valid,true,`${run.variant}/${sample.scenario}: ${sample.rejectionReasons}`);
    const first = run.observations.find(s=>s.scenario==="first-key-immediate");
    assert.equal(first.inputCounts.trustedKeydowns,1);
    assert.equal(first.inputTwoRafProxy.count,1);
    const mutation = run.observations.find(s=>s.scenario==="dom-mutation");
    assert.equal(mutation.eventTiming.count,0);
    assert.equal(mutation.eventTiming.medianMs,null);
  }
  assert.equal(report.collectorOverhead.observations.length,4);
  assert.ok(report.limitations.some(s=>s.includes("not React or ProseMirror")));
});
