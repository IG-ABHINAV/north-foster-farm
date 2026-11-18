// Criteria test for #648, "Done when" box 2, written before the change
// from the issue alone. It passes today and must keep passing: the Run
// and Alert steps of e2e-staging.yml are bash, and the change declares
// the shell rather than rewriting them.
//
// Each body is taken from the workflow as written. GitHub replaces a
// `${{ ... }}` expression before the shell sees the script, so each is
// replaced with the word EXPR, which any shell reads as a plain word.
// Then each body is parsed by bash -n, and run by `bash -e` (what
// `shell: bash` adds to, with pipefail) and by `dash -e` (what a
// container job uses with no shell declared: `sh -e`, and sh is dash
// on the Playwright image, Ubuntu and macOS alike). npx and curl are
// stubs on PATH that record their arguments, so nothing reaches
// Playwright or the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./workflow-yaml.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const workflow = parseYaml(readFileSync(
  join(root, ".github/workflows/e2e-staging.yml"), "utf8"));
const body = (name) => workflow.jobs["e2e-staging"].steps
  .find((s) => s.name === name).run
  .replace(/\$\{\{.*?\}\}/g, "EXPR");

const dash = ["/bin/dash", "/usr/bin/dash"].find((p) => existsSync(p));
const stubs = mkdtempSync(join(tmpdir(), "nff-648-"));

after(() => rmSync(stubs, { recursive: true, force: true }));
for (const tool of ["npx", "curl"]) {
  const file = join(stubs, tool);

  writeFileSync(file,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${stubs}/${tool}.args"\n`);
  chmodSync(file, 0o755);
}

const run = (shell, name, env) => {
  const script = join(stubs, `${name}.sh`);

  writeFileSync(script, body(name));
  for (const tool of ["npx", "curl"]) {
    rmSync(join(stubs, `${tool}.args`), { force: true });
  }
  const parse = spawnSync(shell, ["-n", script], { encoding: "utf8" });
  const res = spawnSync(shell, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ...env },
  });
  const args = (tool) => {
    const file = join(stubs, `${tool}.args`);

    return existsSync(file)
      ? readFileSync(file, "utf8").trimEnd().split("\n")
      : null;
  };

  return { parse, res, args };
};

const sha = "0123456789abcdef0123456789abcdef01234567";
const alertEnv = {
  PING: "https://ping.invalid/check",
  OUTCOME: "failure",
  GITHUB_SHA: sha,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "north-foster-farm/north-foster-farm",
  GITHUB_RUN_ID: "44373881861",
};

describe("#648: e2e-staging.yml's Run and Alert are bash", () => {
  it("the Run and Alert scripts run under bash and are refused by sh", () => {
    assert.ok(dash, "dash, the sh of a container job, is installed");

    const specs = readdirSync(join(root, "e2e"))
      .filter((f) => f.endsWith(".spec.mjs")).sort()
      .map((f) => `e2e/${f}`);

    // Run, every spec (as on e2e/staging-full).
    const bashRun = run("bash", "Run", { FULL: "1" });

    assert.equal(bashRun.parse.status, 0, bashRun.parse.stderr);
    assert.equal(bashRun.res.status, 0, bashRun.res.stderr);
    assert.match(bashRun.res.stdout,
      new RegExp(`Running ${specs.length} specs`));
    assert.deepEqual(bashRun.args("npx"), [
      "playwright", "test", "--project=desktop", "--project=phone",
      "--retries=0", "--workers=2", "--trace=off", "--reporter=list,json",
      ...specs,
    ]);

    const dashRun = run(dash, "Run", { FULL: "1" });

    assert.notEqual(dashRun.parse.status, 0, "dash -n refuses Run");
    assert.notEqual(dashRun.res.status, 0);
    assert.equal(dashRun.args("npx"), null, "no spec runs under dash");

    // Alert, a failed run.
    const bashAlert = run("bash", "Alert", alertEnv);

    assert.equal(bashAlert.parse.status, 0, bashAlert.parse.stderr);
    assert.equal(bashAlert.res.status, 0, bashAlert.res.stderr);
    assert.deepEqual(bashAlert.args("curl").slice(-2), [
      `e2e-staging failure at ${sha.slice(0, 12)}: https://github.com/`
        + "north-foster-farm/north-foster-farm/actions/runs/44373881861",
      "https://ping.invalid/check/fail",
    ]);

    // Dash parses Alert (its "Bad substitution" comes at run time, as
    // it did in run 44373881861), then refuses it when it runs.
    const dashAlert = run(dash, "Alert", alertEnv);

    assert.notEqual(dashAlert.res.status, 0);
    assert.match(dashAlert.res.stderr, /Bad substitution/);
    assert.equal(dashAlert.args("curl"), null, "no alert is sent under dash");
  });
});
