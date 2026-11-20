// The implementer's own tests for bin/e2e/report-run.mjs (#647): the
// edges the criteria tests in e2e-report-run.test.mjs do not reach.
// Nothing here runs a report_run; the executable check is injected.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UNDER, records, reportRunFor, underReportRun,
} from "../bin/e2e/report-run.mjs";

const HOME = "/home/test";
const SCRIPT = `${HOME}/.bin/report_run`;
const yes = { isExecutable: () => true, home: HOME };

describe("bin/e2e/report-run.mjs", () => {
  it("records only a real e2e run", () => {
    assert.equal(records(["e2e", "e2e/map.spec.mjs"]), true);
    assert.equal(records(["e2e"]), true);
    assert.equal(records(["e2e", "--dry-run=false"]), true);
    assert.equal(records(["e2e", "--dry-run"]), false);
    assert.equal(records(["e2e", "--dry-run=true"]), false);
    assert.equal(records(["e2e", "--help"]), false);
    assert.equal(records(["e2e", "-h"]), false);
    assert.equal(records(["orders", "list"]), false);
    assert.equal(records([]), false);
  });

  it("hands off once: never from its own child", () => {
    assert.equal(reportRunFor(["e2e"], {}, yes), SCRIPT);
    assert.equal(reportRunFor(["e2e"], { [UNDER]: "1" }, yes), null);
  });

  it("hands off nothing without a home or an executable script", () => {
    assert.equal(reportRunFor(["e2e"], {}, { ...yes, home: "" }), null);
    assert.equal(reportRunFor(["e2e"], {},
      { ...yes, isExecutable: () => false }), null);
  });

  it("counts an npm script as recorded only when report_run records "
    + "it as e2e", () => {
    // A path that is not there never matches (realpath fails), so the
    // stand-in script is this test file, which is.
    const self = new URL(import.meta.url).pathname;
    const npm = (event, shell = self) => ({
      "npm_lifecycle_event": event, "npm_config_script_shell": shell,
    });

    assert.equal(underReportRun(npm("e2e"), self), true);
    assert.equal(underReportRun(npm("test:e2e"), self), true);
    assert.equal(underReportRun(npm("verify"), self), false);
    assert.equal(underReportRun(npm("e2e", "/bin/sh"), self), false);
    assert.equal(underReportRun({}, self), false);
  });
});
