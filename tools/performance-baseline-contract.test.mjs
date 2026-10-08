import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { baselinePath, buildBaselineContract, verifyBaselineContract } from "./performance-baseline-contract.mjs";

test("baseline lock binds exact original/performance/pre-clean sources and known predicate introduction", async () => {
  const expected = buildBaselineContract();
  const actual = JSON.parse(await readFile(baselinePath, "utf8"));
  verifyBaselineContract(actual, expected);
  assert.deepEqual(actual.variants.map(variant => variant.predicateCachePresent), [false, true, true]);
  assert.equal(actual.candidate, null);
  assert.equal(actual.stockControl.measured, false);
  assert.equal(actual.scenarioContract.nativeInteractionBaseline, "pending-phase1");
});

test("baseline verification rejects changed source, missing assets, moving refs and accidental stock measurement claims", () => {
  const expected = buildBaselineContract();
  for (const mutate of [
    actual => { actual.variants[0].assets[0].sha256 = "0".repeat(64); },
    actual => { actual.variants[1].assets.pop(); },
    actual => { actual.variants[2].commit = "main"; },
    actual => { actual.stockControl.measured = true; },
    actual => { actual.scenarioContract.messages = 80; },
    actual => { actual.privatePath = "unexpected"; },
  ]) {
    const actual = structuredClone(expected);
    mutate(actual);
    assert.throws(() => verifyBaselineContract(actual, expected), /Baseline lock differs/);
  }
});
