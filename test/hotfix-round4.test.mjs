// Round 4 of the criteria tests for `bin/nff hotfix start` and `bin/nff
// hotfix finish` (#612): what the second security review of #631
// (2026-11-18, ~/Code/nff/inbound/verdict-631-security-2026-11-18-
// round2.md, items A and C) made criteria, one test each and named for
// it, written by the test lane before the code meets them. The
// implementer may change how a test runs, never what it expects
// (~/.claude/CLAUDE.md, "Tests and implementation come from different
// agents").
//
// Held out of `npm test`, which runs test/**/*.test.mjs, until the
// code meets them. Run it on purpose with
//   node --import ./test/setup.mjs --test test/hotfix-round4.criteria.mjs
// and turn it on with
//   git mv test/hotfix-round4.criteria.mjs test/hotfix-round4.test.mjs
// Nothing else changes: no live test is retired, and no expectation in
// test/hotfix.test.mjs or test/hotfix-round3.test.mjs moved. The harness
// (test/hotfix-world.mjs) now also keeps, with each question asked,
// what was printed before it (`t.asked`).
//
// The contracts of test/hotfix.test.mjs and test/hotfix-round3.test.mjs
// hold, with these additions. Where they differ, these win.
//
// A (adds to round 3's C). Take O old main, M main, H a placeholder's
//    head and R its rebuilt branch. For each path both the hotfix and
//    the placeholders touched that is to be confirmed, finish shows,
//    before it asks, the difference from H to R and also the difference
//    from M to R (what of main's hotfix the rebuild lacks). Each such
//    path where R equals H (git's tree entry, mode and content), so the
//    hotfix's change to that path is gone, is named before the question
//    on a line that holds the path and says the rebuild "drops the
//    hotfix's change". A path where R differs from H is never named so.
//    Decided here: a dropping path is confirmed, not refused, since
//    taking the kept work's side can be right. The one question still
//    goes through deps.confirm, even with --yes; a yes pushes as before
//    and a no refuses, pushing nothing and keeping the placeholders.
//    `--dry-run` asks nothing and names the dropping paths too, when the
//    rebuild's result is known: a rebuild stopped on a conflict that has
//    been resolved and staged. It changes nothing, local or on origin:
//    no branch, no index, and the rebase stays in progress.
// C (extends round 3's E). A flag given any value, empty included, is
//    refused before any git command or GitHub call: `--dry-run=`,
//    `--dry-run=false`, `--yes=no`, `--yes=0`. Only the bare flags are
//    taken (bin/nff hands a bare flag on as `true`). The refusal names
//    the flag. It holds through hotfixCommand and through bin/nff's own
//    parsing of the command line.
//
// Left to the implementer's own tests (the verdict's B and the should
// fixes): overlapping `start` runs (`git push --porcelain`, deleting only
// what this run created), the `stopping` flag for a signal after the
// narrowing, no trim of -z output, and the corrected comment on
// movedAlready.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CONFLICT, PLAIN, RESOLVED, land, ok, refs, refused, run, show, withLine,
  world, write,
} from "./hotfix-world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The placeholder for next's a.txt, as "Reword two" left it.
const PLACEHOLDER_A = withLine(1, "two from next");

// A line that names a path as one where the rebuild drops the hotfix.
const dropping = (lines, path) => lines.some((l) => l.includes(path)
  && /drops? the hotfix/i.test(l));

// The local branches, the index and whether a rebase is in progress.
const local = async (t) => ({
  heads: await t.w(["for-each-ref", "--format=%(refname) %(objectname)",
    "refs/heads"]),
  head: await t.w(["rev-parse", "HEAD"]),
  index: await t.w(["ls-files", "-s"]),
  rebasing: ["rebase-merge", "rebase-apply"]
    .some((name) => existsSync(join(t.work, ".git", name))),
});

// Start, land the hotfix that rewrites a.txt's second line, stop the
// rebuild of next on "Reword two", and stage a.txt as `resolution`.
const resolved = async (resolution) => {
  const t = await world();

  ok(await run(t, "start"));
  await land(t, ...CONFLICT);
  const stop = await run(t, "finish");

  assert.ok(stop.error, "the rebuild stops on Reword two");
  assert.match(stop.text, /Reword two/);
  write(t.work, { "a.txt": resolution });
  await t.w(["add", "a.txt"]);

  return t;
};

// Finish, step 1, with every question answered `answer`: what was seen
// before the one question, and how origin stood before.
const confirmed = async (resolution, { answer = true, flags = {} } = {}) => {
  const t = await resolved(resolution);
  const asked = t.asked.length;
  const before = await refs(t.o);

  t.answer = answer;
  const r = await run(t, "finish", { flags });
  const questions = t.asked.slice(asked);

  assert.equal(questions.length, 1, "it asks once");
  assert.match(questions[0].question, /a\.txt/, "naming a.txt");

  return {
    t, r, before,
    seen: [...questions[0].before, ...questions[0].question.split("\n")],
  };
};

const VALUED = [["dry-run", ""], ["dry-run", "false"], ["yes", "no"],
  ["yes", "0"]];

describe("bin/nff hotfix, round 4 (#612, the second security review of "
  + "#631)", () => {
  it("A. a path both touched where the rebuild equals the placeholder is "
    + "named as dropping the hotfix's change, and main's difference is "
    + "shown, before the question; --dry-run names it and asks nothing",
  async () => {
    // The rebuild took the placeholder's side wholesale: R = H at a.txt.
    const drop = await confirmed(PLACEHOLDER_A);

    assert.ok(dropping(drop.seen, "a.txt"),
      "a.txt is named as dropping the hotfix's change before the question");
    assert.ok(drop.seen.some((l) => /^\s*-\s*two from main\s*$/.test(l)),
      "the difference from main shows the hotfix's line going");
    ok(drop.r);
    assert.equal(await show(drop.t, (await refs(drop.t.o))[
      "refs/heads/hotfix/rebuilt"], "a.txt"), PLACEHOLDER_A,
    "a yes pushes the rebuild as confirmed");

    // A no refuses and pushes nothing.
    const no = await confirmed(PLACEHOLDER_A, { answer: false });

    refused(no.r);
    assert.ok(dropping(no.seen, "a.txt"), "named before a no too");
    assert.deepEqual(await refs(no.t.o), no.before,
      "a no pushes nothing and keeps the placeholders");

    // --yes does not answer it.
    const yes = await confirmed(PLACEHOLDER_A, { flags: { yes: true } });

    ok(yes.r);
    assert.ok(dropping(yes.seen, "a.txt"));

    // The rebuild kept both changes: both differences shown, a.txt not
    // named as dropping.
    const kept = await confirmed(RESOLVED);

    ok(kept.r);
    assert.ok(!dropping(kept.seen, "a.txt"), "a.txt is not named as "
      + "dropping the hotfix's change");
    assert.ok(kept.seen.some((l) => /^\s*\+\s*two from main\s*$/.test(l)),
      "the difference from the placeholder is shown");
    assert.ok(kept.seen.some((l) => /^\s*\+\s*two from next\s*$/.test(l)),
      "the difference from main is shown");

    // --dry-run, once the conflict is resolved and staged: named, nothing
    // asked, nothing changed.
    for (const [resolution, named] of [[PLACEHOLDER_A, true],
      [RESOLVED, false]]) {
      const t = await resolved(resolution);
      const asked = t.questions.length;
      const origin = await refs(t.o);
      const checkout = await local(t);
      const dry = await run(t, "finish", { dryRun: true });

      ok(dry);
      assert.equal(t.questions.length, asked, "--dry-run asks nothing");
      assert.equal(dropping(dry.text.split("\n"), "a.txt"), named,
        named ? "--dry-run names a.txt as dropping the hotfix's change"
          : "--dry-run does not name a.txt when both changes are kept");
      assert.deepEqual(await refs(t.o), origin, "origin is as it was");
      assert.deepEqual(await local(t), checkout,
        "the branches, the index and the rebase in progress are as they were");
    }
  });

  it("C. a flag given any value is refused before any git or GitHub call, "
    + "and the bare flags still work", async () => {
    // Through hotfixCommand.
    for (const action of ["start", "finish"]) {
      for (const [flag, value] of VALUED) {
        const t = await world();

        if (action === "finish") {
          ok(await run(t, "start"));
          await land(t, ...PLAIN);
        }
        const before = await refs(t.o);
        const calls = t.gh.calls.length;
        const asked = t.questions.length;
        const r = await run(t, action, { flags: { [flag]: value } });
        const label = `${action} --${flag}=${value}`;

        refused(r);
        assert.ok(r.error.message.includes(`--${flag}`),
          `${label}: names --${flag}`);
        assert.deepEqual(r.gitCalls, [], `${label}: runs no git`);
        assert.equal(t.gh.calls.length, calls, `${label}: asks GitHub nothing`);
        assert.equal(t.questions.length, asked, `${label}: asks nothing`);
        assert.deepEqual(await refs(t.o), before, `${label}: changes nothing`);
      }
    }

    // The bare flags: --dry-run on both, --yes on start.
    const bare = await world();
    const before = await refs(bare.o);

    ok(await run(bare, "start", { flags: { "dry-run": true } }));
    assert.deepEqual(await refs(bare.o), before, "--dry-run changes nothing");
    ok(await run(bare, "start", { flags: { yes: true } }));
    await land(bare, ...PLAIN);
    ok(await run(bare, "finish", { flags: { "dry-run": true } }));

    // Through bin/nff, with git and gh on PATH replaced by stubs that log
    // and fail, so nothing real can run whatever the code does.
    const dir = mkdtempSync(join(tmpdir(), "hotfix-r4-"));
    const log = join(dir, "calls.log");
    const nff = (args) => {
      writeFileSync(log, "");

      const r = spawnSync(process.execPath, [join(root, "bin/nff"),
        "hotfix", ...args], {
        cwd: root, encoding: "utf8",
        env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin` },
      });

      return { ...r, text: `${r.stdout}${r.stderr}`,
        calls: readFileSync(log, "utf8") };
    };

    try {
      for (const tool of ["git", "gh"]) {
        writeFileSync(join(dir, tool),
          `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`);
        chmodSync(join(dir, tool), 0o755);
      }
      for (const action of ["start", "finish"]) {
        for (const [flag, value] of VALUED) {
          const r = nff([action, `--${flag}=${value}`]);
          const label = `bin/nff hotfix ${action} --${flag}=${value}`;

          assert.notEqual(r.status, 0, `${label}: fails`);
          assert.match(r.text, /Refused:/, `${label}: refuses`);
          assert.ok(r.text.includes(`--${flag}`), `${label}: names --${flag}`);
          assert.equal(r.calls, "", `${label}: runs no git and no gh`);
        }
      }

      // A bare --dry-run is taken, so the command goes on to git or gh.
      const taken = nff(["finish", "--dry-run"]);

      assert.notEqual(taken.calls, "", "a bare --dry-run reaches git or gh");
      assert.ok(!/takes only/.test(taken.text), "and is not refused as a flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
