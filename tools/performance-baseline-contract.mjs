import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BASELINES, fixtureHtml, PARAMETERS } from "./benchmark-baseline-classifier.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const baselinePath = path.join(projectRoot, "benchmarks/phase0/baselines.json");
export const pinnedVariants = Object.freeze([
  { id: "original-skin", commit: BASELINES.original },
  { id: "performance-only", commit: "265841ba46d1254a7bce205d0f16bcaade1aea3b" },
  { id: "pre-clean", commit: BASELINES.preclean },
]);
const sharedFiles = [
  "runtime/renderer-inject.js", "runtime/dream-skin.css",
  "runtime/internet-angel-extension.js", "runtime/internet-angel-extension.css",
  "tools/selectors.json",
];
const platformFiles = ["windows", "macos", "linux"].flatMap(platform => [
  platform + "/assets/renderer-inject.js", platform + "/assets/dream-skin.css",
  platform + "/assets/internet-angel-extension.js",
  platform + "/assets/internet-angel-extension.css",
  platform + "/assets/selectors.json", platform + "/assets/theme.json",
  platform + "/scripts/injector.mjs",
]);
const files = [...sharedFiles, ...platformFiles,
  "windows/assets/internet-angel-acrylic.css", "windows/assets/dream-reference.jpg"];
const predicateFiles = ["tools/css-predicate-cache.mjs",
  ...["windows", "macos", "linux"].map(platform => platform + "/assets/css-predicate-cache.mjs")];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function git(args) {
  return execFileSync("git", args, { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024,
    timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
}
export function buildBaselineContract() {
  const variants = pinnedVariants.map(({ id, commit }) => {
    const tree = git(["rev-parse", commit + "^{tree}"]).toString("utf8").trim();
    const inventory = new Set(git(["ls-tree", "-r", "--name-only", commit]).toString("utf8").trim().split("\n"));
    const requiredFiles = id === "original-skin" ? files : [...files, ...predicateFiles];
    const assets = requiredFiles.map(file => {
      assert.ok(inventory.has(file), "Pinned variant lacks required baseline source: " + file);
      const bytes = git(["show", commit + ":" + file]);
      return { file, bytes: bytes.length, sha256: sha256(bytes) };
    });
    return { id, commit, tree, runtimeVersion: git(["show", commit + ":windows/VERSION"]).toString("utf8").trim(),
      predicateCachePresent: predicateFiles.every(file => inventory.has(file)), assets };
  });
  return {
    schema: "dream-skin-performance-baselines/1",
    auditedDate: "2026-10-09",
    documentationCheckpoint: "284bff69ae193b457d30adb3ea84d3f88629681c",
    stockControl: { id: "stock-cdp", sourceCommit: null,
      requirements: ["same-official-app-build", "verified-loopback-cdp", "no-skin-payload", "no-skin-watcher"],
      measured: false },
    candidate: null,
    variants,
    scenarioContract: {
      fixtureRevision: "long-chat-classifier/1",
      fixtureHtmlSha256: sha256(fixtureHtml()),
      viewport: PARAMETERS.viewport,
      messages: PARAMETERS.messages, nestedDepth: PARAMETERS.depth, textRepeats: PARAMETERS.textRepeats,
      warmupPairs: PARAMETERS.warmupPairs, measuredPairs: PARAMETERS.measuredPairs, pairOrder: "alternating",
      timingScope: "uninstrumented-synchronous-component-classification",
      nativeInteractionBaseline: "pending-phase1",
    },
  };
}
export function verifyBaselineContract(actual, expected = buildBaselineContract()) {
  assert.deepEqual(actual, expected, "Baseline lock differs from pinned Git sources or scenario contract");
  return actual;
}
export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length === 1 && ["--check", "--write"].includes(args[0]),
    "Usage: node tools/performance-baseline-contract.mjs --check|--write");
  const expected = buildBaselineContract();
  if (args[0] === "--write") {
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify(expected, null, 2) + "\n", { flag: "wx" });
  } else {
    const bytes = await readFile(baselinePath);
    assert.ok(bytes.length <= 128 * 1024, "Baseline lock exceeds its size bound");
    verifyBaselineContract(JSON.parse(bytes.toString("utf8")), expected);
  }
  console.log(JSON.stringify({ pass: true, variants: expected.variants.length,
    assets: expected.variants.reduce((total, variant) => total + variant.assets.length, 0),
    scope: "source-freeze-only", nativeInteractionBaseline: "pending-phase1" }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Baseline contract validation failed"); process.exitCode = 1; });
}
