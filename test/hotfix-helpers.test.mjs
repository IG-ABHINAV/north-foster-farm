/* eslint-disable camelcase -- GitHub names its fields its way */
// The implementer's own tests of bin/hotfix.mjs's helpers, beside the
// criteria tests in test/hotfix.test.mjs, which they never replace.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  REQUIRED, RULESET_PATH, addedLines, differences, listed, narrowed,
  unproven,
} from "../bin/hotfix.mjs";

const RULESET = {
  name: "no force-push or deletion: next, staging, main",
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: {
      exclude: [],
      include: ["refs/heads/next", "refs/heads/staging", "refs/heads/main"],
    },
  },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  bypass_actors: [],
  id: 25361439,
};

describe("bin/hotfix.mjs helpers", () => {
  it("reads the lines each file gains, quoted and binary paths too", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -2 +2 @@",
      "-two",
      "+two from next",
      "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"",
      "new file mode 100644",
      "--- /dev/null",
      "+++ \"b/caf\\303\\251.txt\"",
      "@@ -0,0 +1 @@",
      "+bonjour",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const files = addedLines(diff);

    assert.deepEqual(files.get("a.txt"), { lines: ["two from next"] });
    assert.deepEqual(files.get("café.txt"), { lines: ["bonjour"] });
    assert.equal(files.has("gone.txt"), false);
    assert.deepEqual(files.get("logo.png"), { lines: [], binary: true });
  });

  it("narrows to main alone and keeps every rule and no bypass", () => {
    const body = narrowed(RULESET);

    assert.deepEqual(body.conditions.ref_name.include, ["refs/heads/main"]);
    assert.deepEqual(body.rules, RULESET.rules);
    assert.deepEqual(body.bypass_actors, []);
    assert.equal(body.id, undefined, "sends only what a PUT takes");
    assert.deepEqual(RULESET.conditions.ref_name.include.length, 3,
      "leaves the saved copy as it was");
    assert.match(RULESET_PATH, /rulesets\/25361439$/);
  });

  it("names each field that reads back differently", () => {
    const back = structuredClone(RULESET);

    assert.deepEqual(differences(RULESET, back), []);
    back.conditions.ref_name.include.pop();
    back.updated_at = "later";

    const diff = differences(RULESET, back);

    assert.equal(diff.length, 1);
    assert.match(diff[0], /^conditions saved/);
  });

  it("passes a check only on a completed run that succeeded", () => {
    // The recorded runs of a green commit of next, skipped runs first.
    const { check_runs: runs } = JSON.parse(readFileSync(new URL(
      "fixtures/github/check-runs-green.json", import.meta.url), "utf8"))
      .response;
    const without = (name) => runs.filter((run) => run.name !== name
      || run.conclusion !== "success");

    assert.deepEqual(unproven(runs), []);
    assert.deepEqual(unproven([]), REQUIRED);
    assert.deepEqual(unproven(without("codeql")), ["codeql"],
      "a skipped codeql run does not pass it");
    assert.deepEqual(unproven(runs.map((run) => (run.name === "supply-chain"
      ? { ...run, status: "in_progress", conclusion: null } : run))),
    ["supply-chain"], "a run still going does not pass it");
  });

  it("lists names the way a sentence does", () => {
    assert.equal(listed([]), "");
    assert.equal(listed(["a"]), "a");
    assert.equal(listed(["a", "b"]), "a and b");
    assert.equal(listed(["a", "b", "c"]), "a, b and c");
  });
});
