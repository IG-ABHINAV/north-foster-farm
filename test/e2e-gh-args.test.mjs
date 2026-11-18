// The gh arguments of bin/e2e/dispatch.mjs (#623): every call lets gh
// pass a log's escape sequences, which printable() then strips.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ghArgs } from "../bin/e2e/dispatch.mjs";

describe("bin/e2e/dispatch.mjs ghArgs", () => {
  it("allows escape sequences on a read and a write", () => {
    assert.deepEqual(ghArgs("repos/o/r/actions/jobs/1/logs"), ["api", "-X",
      "GET", "--allow-escape-sequences", "repos/o/r/actions/jobs/1/logs"]);
    assert.deepEqual(ghArgs("repos/o/r/x", { method: "POST", body: {} }),
      ["api", "-X", "POST", "--allow-escape-sequences", "repos/o/r/x",
        "--input", "-"]);
  });
});
