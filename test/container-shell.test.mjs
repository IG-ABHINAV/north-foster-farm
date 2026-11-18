// Criteria test for #648, "Done when" box 1, written before the change
// from the issue alone. Held out of npm test by its name until the
// change that meets #648 turns it on with
//   git mv test/container-shell.criteria.mjs test/container-shell.test.mjs
//
// In a job with a `container:`, GitHub runs a `run:` step with `sh -e`,
// which on the Playwright image is dash. So every such step must
// resolve to bash, declared in the workflow: the step's `shell`, else
// the job's `defaults.run.shell`, else the workflow's. Exactly `bash`,
// which GitHub runs as `bash -e -o pipefail`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./workflow-yaml.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../.github/workflows");
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

// Each run step of a container job, with the shell it resolves to
// (null when nothing declares one, so GitHub picks sh).
const containerRunSteps = (workflow) => {
  const out = [];

  for (const [id, job] of Object.entries(workflow.jobs || {})) {
    if (!job || !job.container) continue;
    for (const [i, step] of (job.steps || []).entries()) {
      if (!step || step.run === undefined) continue;
      out.push({
        job: id,
        step: step.name || step.id || `step ${i + 1}`,
        shell: step.shell
          ?? job.defaults?.run?.shell
          ?? workflow.defaults?.run?.shell
          ?? null,
      });
    }
  }

  return out;
};

describe("#648: container jobs run their steps under bash", () => {
  it("each run step of a job with a container resolves to bash", () => {
    // The check sees what it must: a container job's undeclared step is
    // caught, and a declaration at any of the three levels counts.
    const job = (extra = "", step = "") => "jobs:\n  j:\n"
      + `    runs-on: ubuntu-latest\n    container: img\n${extra}`
      + `    steps:\n      - name: S\n${step}        run: echo hi\n`;
    const wf = (text) => containerRunSteps(parseYaml(text))[0].shell;

    assert.equal(wf(job()), null);
    assert.equal(wf(job("", "        shell: bash\n")), "bash");
    assert.equal(wf(job("    defaults:\n      run:\n        shell: bash\n")),
      "bash");
    assert.equal(wf(`defaults:\n  run:\n    shell: bash\n${job()}`), "bash");
    assert.equal(wf(`defaults:\n  run:\n    shell: bash\n${job("",
      "        shell: sh\n")}`), "sh");

    // Not vacuous: both e2e workflows have container jobs with run
    // steps, the staging one its Run and Alert.
    const steps = Object.fromEntries(files.map((file) => [file,
      containerRunSteps(parseYaml(readFileSync(join(dir, file), "utf8")))]));

    assert.ok(steps["e2e-run.yml"].length > 0, "e2e-run.yml");
    for (const name of ["Run", "Alert"]) {
      assert.ok(steps["e2e-staging.yml"].some((s) => s.step === name), name);
    }

    const wrong = Object.entries(steps).flatMap(([file, list]) => list
      .filter((s) => s.shell !== "bash")
      .map((s) => `${file}: ${s.job}: ${s.step}: ${s.shell ?? "sh"}`));

    assert.deepEqual(wrong, []);
  });
});
