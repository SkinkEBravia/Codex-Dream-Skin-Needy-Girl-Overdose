import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BASELINES, PARAMETERS, buildReport, fixtureHtml, quantile, safeOutputPath, sha256,
  summarize, validateSources } from "./benchmark-baseline-classifier.mjs";

const sources = () => Object.fromEntries(Object.entries(BASELINES).map(([label, commit]) => [label,
  { commit, raw: 'const enabled = __INTERNET_ANGEL_EXTENSION_ENABLED_JSON__;' }]));
const pair = (index, warmup = false) => {
  const order = index % 2 === 0 ? ["original", "preclean"] : ["preclean", "original"];
  return { index, warmup, order, samples: order.map((label) => ({ label,
    durationMs: label === "original" ? 10 + index : 4 + index,
    refreshCount: 1, containerCount: 6400, messageCount: 160, textCharacters: 378880 })) };
};
const input = () => ({ sources: sources(), warmups: Array.from({ length: 2 }, (_, i) => pair(i, true)),
  pairs: Array.from({ length: 10 }, (_, i) => pair(i)), browserVersion: "140.0.1" });

test("linear quantiles and spread are correct without mutating samples", () => {
  const values = [9, 1, 5, 3];
  assert.equal(quantile(values, 0.5), 4);
  assert.equal(quantile(values, 0.25), 2.5);
  assert.equal(quantile(values, 1), 9);
  assert.deepEqual(values, [9, 1, 5, 3]);
  assert.deepEqual(summarize([1, 3, 5, 9]), { count: 4, minMs: 1, medianMs: 4, p25Ms: 2.5,
    p75Ms: 6, p95Ms: 8.399999999999999, maxMs: 9, medianAbsoluteDeviationMs: 2 });
  for (const bad of [[], [NaN], [Infinity]]) assert.throws(() => quantile(bad, 0.5));
  assert.throws(() => quantile(values, -1));
  assert.throws(() => summarize([-1, 2]));
});

test("fixture preserves exact long-chat workload and has stable identity", () => {
  const html = fixtureHtml();
  assert.equal((html.match(/data-perf-container="true"/g) || []).length, PARAMETERS.messages * PARAMETERS.depth);
  assert.equal((html.match(/<span>/g) || []).length, PARAMETERS.messages);
  assert.equal((html.match(/Synthetic ordinary assistant output\. /g) || []).length, PARAMETERS.messages * PARAMETERS.textRepeats);
  assert.equal(sha256(html), sha256(fixtureHtml()));
  assert.match(sha256(html), /^[a-f0-9]{64}$/);
  assert.notEqual(sha256(html), sha256(`${html} `));
});

test("paired report excludes warmups and retains order, identities, valid counts and limits", () => {
  const report = buildReport(input());
  assert.equal(report.validSamples, 20);
  assert.equal(report.validWarmupSamples, 4);
  assert.equal(report.summaries.original.medianMs, 14.5);
  assert.equal(report.summaries.preclean.medianMs, 8.5);
  assert.equal(report.summaries.pairedPrecleanMinusOriginalMs.medianMs, -6);
  assert.equal(report.summaries.pairedPrecleanMinusOriginalMs.minMs, -6);
  assert.equal(report.sources.original.commit, BASELINES.original);
  assert.notEqual(report.sources.original.rawSha256, report.sources.original.injectedSha256);
  assert.deepEqual(report.pairs[1].order, ["preclean", "original"]);
  assert.ok(report.limitations.some((value) => value.includes("first-key")));
  assert.equal(report.environment.headless, true);
  assert.equal(JSON.stringify(report).includes(process.cwd()), false);
  assert.ok(report.limitations.some((value) => value.includes("exploratory")));
  const noMetrics = input(); noMetrics.pairs[0].samples[0].refreshCount = null;
  assert.equal(buildReport(noMetrics).pairs[0].samples[0].refreshCount, null);
});

test("wrong source refs, duplicate placeholders and extra sources fail closed", () => {
  const bad = sources(); bad.original.commit = "main";
  assert.throws(() => validateSources(bad), /source identity/);
  const duplicate = sources(); duplicate.original.raw += "__INTERNET_ANGEL_EXTENSION_ENABLED_JSON__";
  assert.throws(() => validateSources(duplicate));
  assert.throws(() => validateSources({ ...sources(), native: { commit: "unknown" } }));
});

test("incomplete, wrong-order, invalid duration and altered-workload observations are rejected", () => {
  const mutations = [
    (value) => value.pairs.pop(),
    (value) => value.pairs[0].order.reverse(),
    (value) => value.pairs[1].samples[0].durationMs = NaN,
    (value) => value.pairs[1].samples[0].durationMs = -1,
    (value) => value.pairs[1].samples[0].durationMs = 30001,
    (value) => value.pairs[0].samples[0].privatePath = "unexpected",
    (value) => value.pairs[0].privateText = "unexpected",
    (value) => value.pairs[1].samples[0].refreshCount = 2,
    (value) => value.pairs[1].samples[0].refreshCount = 0,
    (value) => value.warmups[0].samples[0].messageCount = 159,
    (value) => value.pairs[0].samples[0].textCharacters = 1,
    (value) => value.browserVersion = "private/path",
  ];
  for (const mutate of mutations) { const value = input(); mutate(value); assert.throws(() => buildReport(value)); }
});

test("output permits only ordinary existing parents and a relative JSON destination", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-classifier-output-"));
  try {
    await mkdir(path.join(directory, "results"));
    assert.equal(await safeOutputPath("results/result.json", directory), path.join(directory, "results", "result.json"));
    for (const invalid of ["../result.json", "result.txt", "", path.join(directory, "result.json"), "C:result.json"])
      await assert.rejects(safeOutputPath(invalid, directory));
    await assert.rejects(safeOutputPath("missing/result.json", directory));
    // Windows commonly requires special permissions for links; test links only where creation works.
    let created = false;
    try { await symlink(path.join(directory, "results"), path.join(directory, "link"), "junction"); created = true; }
    catch (error) { if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error; }
    if (created) await assert.rejects(safeOutputPath("link/result.json", directory), /ordinary directory/);
  } finally {
    const resolved = await realpath(directory);
    const relative = path.relative(await realpath(tmpdir()), resolved);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
    assert.ok(path.basename(resolved).startsWith("dream-classifier-output-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
