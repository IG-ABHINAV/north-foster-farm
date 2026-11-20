// The implementer's own tests of bin/e2e/retries.mjs (#693), beside
// the criteria tests (promote-retry.test.mjs, e2e-retry-verdict.test.
// mjs): the reader's edges those do not reach. Additions only.
//
// The logs are the recorded ones of test/fixtures/github/e2e-retry*.txt
// (recorded 2026-11-20 for #693); COMPOSED marks a line put in by hand.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  flakyInLog, retriedInLog, shippedPast,
} from "../bin/e2e/retries.mjs";

const log = (name) => readFileSync(new URL(`fixtures/github/${name}`,
  import.meta.url), "utf8");
const GREEN = log("e2e-retry-staging-44828158630.txt");
const RED = log("e2e-retry-staging-44828622221.txt");
const FLAKY = "e2e/zz-retry-flaky.spec.mjs";

// COMPOSED: `line` put in after the line matching `after`.
const withLine = (text, after, line) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => after.test(l));

  lines.splice(at + 1, 0, `2026-11-20T22:24:38.2909560Z ${line}`);

  return lines.join("\n");
};

describe("bin/e2e/retries.mjs", () => {
  it("reads a flaky test once, with both its projects", () => {
    const flaky = flakyInLog(GREEN);

    assert.deepEqual(flaky.map((t) => [t.spec, t.projects.sort()]),
      [[FLAKY, ["desktop", "phone"]]]);
    assert.deepEqual(flakyInLog("no summary here"), []);
    assert.equal(flakyInLog(null), null);
  });

  it("reads failed and flaky apart in a failed run", () => {
    const read = retriedInLog(RED);

    assert.deepEqual(read.failed.map((t) => t.spec),
      ["e2e/zz-retry-fails.spec.mjs"]);
    assert.deepEqual(read.flaky.map((t) => t.spec), [FLAKY]);
  });

  it("cannot read a failed run with another summary line or a bad count",
    () => {
      assert.equal(retriedInLog(withLine(RED, / {2}2 flaky$/,
        "  1 interrupted")), null);
      assert.equal(retriedInLog(RED.replace("Running 4 tests",
        "Running 5 tests")), null);
      assert.equal(retriedInLog(GREEN), null, "a green run has no failed list");
    });

  it("takes only items with a reason, under the heading, up to the next",
    () => {
      const body = ["## Failing tests shipped past", "",
        "- `a › one`: known, fixed next",
        "- `b › two`:   ",
        "* `c › three`: also fine",
        "### Notes", "- `d › four`: past the section"].join("\r\n");

      assert.deepEqual([...shippedPast(body)], [
        ["a › one", "known, fixed next"], ["c › three", "also fine"],
      ]);
      assert.equal(shippedPast("- `a › one`: no heading").size, 0);
      assert.equal(shippedPast(undefined).size, 0);
    });

  // #696, security 2: GitHub shows James none of these as list items.
  it("refuses a list that an HTML comment could hide", () => {
    const heading = "## Failing tests shipped past";
    const item = "- `a › one`: known";

    for (const body of [
      [heading, "<!--", item, "-->"],
      [heading, `${item} <!-- and more -->`],
      ["<!--", heading, item, "-->"],
    ]) {
      assert.throws(() => shippedPast(body.join("\n")),
        /^Error: Refused: .*an HTML comment/);
    }
  });

  it("refuses a list that a code fence could hide", () => {
    const heading = "## Failing tests shipped past";
    const item = "- `a › one`: known";

    for (const body of [
      [heading, "```", item, "```"],
      [heading, "~~~md", item, "~~~"],
      ["```", heading, item],
    ]) {
      assert.throws(() => shippedPast(body.join("\n")),
        /^Error: Refused: .*a code fence/);
    }
  });

  it("reads past a fence or comment only after the section", () => {
    const body = ["## Failing tests shipped past", "- `a › one`: known",
      "## Notes", "<!-- a note -->", "```", "code", "```"].join("\n");

    assert.deepEqual([...shippedPast(body)], [["a › one", "known"]]);
    assert.equal(shippedPast("```\nno heading\n```").size, 0);
  });
});
