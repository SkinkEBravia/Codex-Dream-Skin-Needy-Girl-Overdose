import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINES = Object.freeze({
  original: "10acfa0a29d9c44e91a53bdc6bebaa42e7adf955",
  preclean: "ac0cc83415deef4df7dbc77cd31be3e4abf7391f",
});
export const PARAMETERS = Object.freeze({ viewport: Object.freeze({ width: 1200, height: 800 }), messages: 160,
  depth: 40, textRepeats: 64, warmupPairs: 2, measuredPairs: 10, refreshesPerSample: 1 });
const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = "runtime/internet-angel-extension.js";
const placeholder = "__INTERNET_ANGEL_EXTENSION_ENABLED_JSON__";
const text = "Synthetic ordinary assistant output. ";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Same deterministic long-chat workload as internet-angel-performance.test.mjs.
// There are no prototypes patched, text getters counted, or DOM mutations during timing.
export function fixtureHtml() {
  const message = '<div data-perf-container="true">'.repeat(PARAMETERS.depth)
    + `<span>${text.repeat(PARAMETERS.textRepeats)}</span>` + "</div>".repeat(PARAMETERS.depth);
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + '<main class="main-surface"><div id="chat">' + message.repeat(PARAMETERS.messages)
    + '</div></main><div id="portals"></div></body></html>';
}

export function quantile(values, fraction) {
  if (!Array.isArray(values) || !values.length || values.some((n) => !Number.isFinite(n))
    || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error("Invalid quantile input");
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function summarize(values) {
  if (values.some((n) => n < 0)) throw new Error("Durations must be nonnegative");
  const median = quantile(values, 0.5);
  const deviations = values.map((n) => Math.abs(n - median));
  return { count: values.length, minMs: Math.min(...values), medianMs: median,
    p25Ms: quantile(values, 0.25), p75Ms: quantile(values, 0.75), p95Ms: quantile(values, 0.95),
    maxMs: Math.max(...values), medianAbsoluteDeviationMs: quantile(deviations, 0.5) };
}

export function validateSources(sources) {
  if (!sources || Object.keys(sources).sort().join(",") !== "original,preclean") throw new Error("Expected pinned baseline sources");
  for (const [label, commit] of Object.entries(BASELINES)) {
    const source = sources[label];
    if (source?.commit !== commit || typeof source.raw !== "string" || source.raw.length > 2 * 1024 * 1024
      || source.raw.split(placeholder).length !== 2) throw new Error(`Invalid ${label} source identity or template`);
  }
}

export function readSources() {
  const sources = Object.fromEntries(Object.entries(BASELINES).map(([label, commit]) => [label, {
    commit, raw: execFileSync("git", ["show", `${commit}:${sourcePath}`], {
      cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10000,
    }),
  }]));
  validateSources(sources);
  return sources;
}

function validatePair(pair, index, warmup) {
  const expectedOrder = index % 2 === 0 ? ["original", "preclean"] : ["preclean", "original"];
  if (!pair || Object.keys(pair).sort().join(",") !== "index,order,samples,warmup"
    || pair.index !== index || pair.warmup !== warmup || JSON.stringify(pair.order) !== JSON.stringify(expectedOrder)
    || !Array.isArray(pair.samples) || pair.samples.length !== 2) throw new Error("Invalid paired schedule");
  pair.samples.forEach((sample, offset) => {
    if (!sample || Object.keys(sample).sort().join(",") !== "containerCount,durationMs,label,messageCount,refreshCount,textCharacters"
      || sample.label !== expectedOrder[offset] || !Number.isFinite(sample.durationMs) || sample.durationMs < 0 || sample.durationMs > 30000
      || (sample.refreshCount !== 1 && sample.refreshCount !== null)
      || sample.containerCount !== PARAMETERS.messages * PARAMETERS.depth
      || sample.messageCount !== PARAMETERS.messages
      || sample.textCharacters !== PARAMETERS.messages * PARAMETERS.textRepeats * text.length) {
      throw new Error("Invalid classifier sample or workload");
    }
  });
}

export function buildReport({ sources, warmups, pairs, browserVersion }) {
  validateSources(sources);
  if (typeof browserVersion !== "string" || !/^[\w. -]{1,80}$/.test(browserVersion)) throw new Error("Invalid browser version");
  if (!Array.isArray(warmups) || warmups.length !== PARAMETERS.warmupPairs
    || !Array.isArray(pairs) || pairs.length !== PARAMETERS.measuredPairs) throw new Error("Incomplete pair collection");
  warmups.forEach((pair, i) => validatePair(pair, i, true));
  pairs.forEach((pair, i) => validatePair(pair, i, false));
  const byLabel = (label) => pairs.map((pair) => pair.samples.find((sample) => sample.label === label).durationMs);
  const original = byLabel("original");
  const preclean = byLabel("preclean");
  const differences = original.map((value, i) => preclean[i] - value);
  return { schemaVersion: 1, scope: "isolated long-chat extension classifier refresh variability",
    limitations: ["No editor or first-key latency measured", "No CSS, GPU, native app, or stock-app measurements",
      "Timings are informational; no performance pass/fail threshold", "One browser process; paired observations are not independent machines",
      "p95 uses linear interpolation over 10 observations; exploratory only, not a robust tail-latency estimate",
      "refreshCount is null when production instrumentation is absent; null does not mean zero refreshes"],
    environment: { nodeVersion: process.version, platform: process.platform, arch: process.arch,
      browserVersion, headless: true, browserEngine: "Chromium" },
    fixture: { origin: "tools/internet-angel-performance.test.mjs long-chat fixture", parameters: PARAMETERS,
      htmlSha256: sha256(fixtureHtml()), textSha256: sha256(text),
      timing: "performance.now around one synchronous state.refresh after initial injection and two animation frames" },
    sources: Object.fromEntries(Object.entries(sources).map(([label, source]) => [label, {
      commit: source.commit, path: sourcePath, rawSha256: sha256(source.raw),
      injectedSha256: sha256(source.raw.replace(placeholder, "true")),
    }])),
    warmups, pairs, summaries: { original: summarize(original), preclean: summarize(preclean),
      pairedPrecleanMinusOriginalMs: { count: differences.length, minMs: Math.min(...differences),
        medianMs: quantile(differences, 0.5), p25Ms: quantile(differences, 0.25),
        p75Ms: quantile(differences, 0.75), maxMs: Math.max(...differences) } },
    validSamples: pairs.length * 2, validWarmupSamples: warmups.length * 2 };
}

export async function safeOutputPath(relative, directory = root) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)
    || relative.includes(":") || !relative.endsWith(".json")) throw new Error("Output must be a relative JSON file");
  const base = path.resolve(directory);
  const target = path.resolve(base, relative);
  const local = path.relative(base, target);
  if (!local || local === ".." || local.startsWith(`..${path.sep}`)) throw new Error("Output escapes project");
  let current = base;
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error("Output base must be an ordinary directory");
  for (const segment of local.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Output parent must be an existing ordinary directory");
  }
  // Exclusive creation below also refuses existing files and symlink outputs.
  return target;
}

export async function runBaseline(sources) {
  validateSources(sources);
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, timeout: 30000,
    ...(process.env.DREAM_SKIN_BROWSER_EXECUTABLE ? { executablePath: process.env.DREAM_SKIN_BROWSER_EXECUTABLE } : {}) });
  try {
    const sample = async (label) => {
      const page = await browser.newPage({ viewport: PARAMETERS.viewport });
      page.setDefaultTimeout(15000);
      let deadline;
      try {
        const work = async () => {
          await page.setContent(fixtureHtml(), { timeout: 15000 });
          await page.evaluate(sources[label].raw.replace(placeholder, "true"));
          return await page.evaluate(async (sampleLabel) => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const state = window.__CODEX_INTERNET_ANGEL_EXTENSION_STATE__;
            if (!state || typeof state.refresh !== "function") throw new Error("Missing classifier state");
            const before = state.metrics?.classifyRuns;
            const start = performance.now();
            state.refresh();
            const durationMs = performance.now() - start;
            // Workload validation happens outside the timed region and before cleanup.
            const after = state.metrics?.classifyRuns;
            const result = { label: sampleLabel, durationMs,
              refreshCount: Number.isSafeInteger(before) && Number.isSafeInteger(after) ? after - before : null,
              containerCount: document.querySelectorAll("[data-perf-container]").length,
              messageCount: document.querySelectorAll("#chat span").length,
              textCharacters: document.getElementById("chat").textContent.length };
            state.cleanup();
            return result;
          }, label);
        };
        return await Promise.race([work(), new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Classifier sample exceeded 30 seconds")), 30000);
        })]);
      } finally { clearTimeout(deadline); await page.close(); }
    };
    const collect = async (count, warmup) => {
      const results = [];
      for (let index = 0; index < count; index += 1) {
        const order = index % 2 === 0 ? ["original", "preclean"] : ["preclean", "original"];
        const samples = [];
        for (const label of order) samples.push(await sample(label));
        const pair = { index, warmup, order, samples };
        validatePair(pair, index, warmup);
        results.push(pair);
      }
      return results;
    };
    const warmups = await collect(PARAMETERS.warmupPairs, true);
    const pairs = await collect(PARAMETERS.measuredPairs, false);
    return buildReport({ sources, warmups, pairs, browserVersion: browser.version() });
  } finally { await browser.close(); }
}

async function main(args) {
  if (args.length === 1 && args[0] === "--check") {
    const sources = readSources();
    console.log(JSON.stringify({ status: "valid", fixtureSha256: sha256(fixtureHtml()), commits: BASELINES,
      sourceSha256: Object.fromEntries(Object.entries(sources).map(([label, value]) => [label, sha256(value.raw)])) }));
    return;
  }
  if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: node tools/benchmark-baseline-classifier.mjs --check | --output <new-relative-file.json>");
  const output = await safeOutputPath(args[1]);
  const report = await runBaseline(readSources());
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "recorded", validSamples: report.validSamples, summaries: report.summaries }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
