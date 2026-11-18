// Round 3 of the criteria tests for `bin/nff hotfix start` and `bin/nff
// hotfix finish` (#612): what the security review of #631
// (2026-11-18, ~/Code/nff/inbound/verdict-631-security-2026-11-18.md)
// made criteria, one test each and named for it, written by the test
// lane before the code meets them. The implementer may change how a
// test runs, never what it expects (~/.claude/CLAUDE.md, "Tests and
// implementation come from different agents").
//
// Held out of `npm test`, which runs test/**/*.test.mjs, until the
// code meets them. Run it on purpose with
//   node --import ./test/setup.mjs --test test/hotfix-round3.criteria.mjs
// and turn it on with
//   git mv test/hotfix-round3.criteria.mjs test/hotfix-round3.test.mjs
// Nothing else changes: this round's commit already took the old test
// of criterion 6 out of test/hotfix.test.mjs ("6. finish refuses to
// push unless the rebuilt next and staging hold every change the
// placeholders did..."), since C below replaces it.
//
// The contract of test/hotfix.test.mjs holds, with these additions.
// Where they differ, these win.
//
// A. The window refuses unless ruleset 25361439's
//    `conditions.ref_name.include` holds exactly refs/heads/next,
//    refs/heads/staging and refs/heads/main, in any order. `start`
//    reads it before it pushes anything, the placeholders included,
//    and step 1 of `finish` before it pushes. A refusal names the
//    ruleset and the refs it found, pushes nothing and writes nothing
//    to GitHub.
// B. The saved copy is kept in a file before the narrowing PUT:
//      <git common dir>/nff-hotfix-ruleset-25361439.json
//    (`git rev-parse --path-format=absolute --git-common-dir`, so every
//    worktree of a checkout finds it), holding exactly the body of the
//    restoring PUT as JSON: the keys name, target, enforcement,
//    conditions, rules and bypass_actors, as the GET returned them, and
//    no other key, so `gh api -X PUT repos/north-foster-farm/
//    north-foster-farm/rulesets/25361439 --input <file>` restores it.
//    It is deleted only once the restore has read back equal to it; a
//    failed restore or a read-back that differs leaves it.
//    Every `start` and `finish` first looks for that file and for a
//    narrowed live ruleset (its include lacking next or staging). On
//    either it refuses, before it pushes, writes to GitHub or rebuilds:
//    the refusal names ruleset 25361439, names the file when there is
//    one, and says how to restore. It never restores by itself. With
//    `--dry-run` it reports the same, and changes nothing.
// C. Criterion 6, restated as a comparison of trees. For each rebuilt
//    branch against its placeholder (the rebuilt staging against
//    `hotfix/staging`, the rebuilt next against `hotfix/next`), at
//    every path, comparing git's tree entries (mode and content, and
//    "absent" as a value), with O old main, M main, H the placeholder's
//    head and R the rebuilt branch:
//    - a path the hotfix did not touch (O = M) must be in R as in H;
//    - a path the placeholders did not touch (O = H) must be in R as in
//      M, so the rebuild never undoes the hotfix;
//    - a path both touched, when R differs from H or from M, is shown
//      (the difference from H to R) and must be confirmed.
//    A path that breaks either of the first two is refused, by name,
//    before anything is pushed. The confirmation goes through
//    deps.confirm, once, naming each such path. It is asked even with
//    `--yes` (decided here: `--yes` answers start's question about the
//    staging site, never this one); a "no" is a refusal. `--dry-run`
//    asks nothing and names the paths both touched.
//    A placeholder commit the rebuild leaves out is reported by its
//    subject: "main already has it" only when its patch-id matches a
//    commit of O..M, and otherwise as emptied by the rebuild, never as
//    already on main.
// D. When `start`'s push of `next` and `staging` fails, `start`
//    fetches again and deletes the placeholders only if `next` and
//    `staging` are both still at the heads they had; if either moved
//    (origin took the push though the client saw it fail), the
//    placeholders stay and the command says so.
// E. A flag other than `dry-run` and `yes` is refused before the
//    command reads or writes anything, git or GitHub: `finish
//    --dryrun` changes nothing.
// F. Step 2 run again after its pushes went through and its delete
//    failed (`next` is `hotfix/rebuilt` and `staging` has moved) only
//    deletes the hotfix branches: it moves neither `staging` nor
//    `next` again.
//
// Left to the implementer's own tests: the restore's retries and the
// runnable recovery command (review item 3), the signal handlers (2),
// printable() on git errors (11), and step 1 when the rebuilt staging
// is main. Left for follow-up issues, untested here: items 8, 9, 10.

import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  A, F, PLAIN, ZERO, changedRefs, commit, guards, head, land, lines, ok,
  pushTargets, refs, refused, run, show, withLine, world, write,
} from "./hotfix-world.mjs";

// The ruleset with its include replaced, all else as recorded. The
// narrowed one is the window's own transformation (test/hotfix.test.mjs,
// "The force-push exception": include exactly ["refs/heads/main"]),
// applied to the recorded GET; GitHub was never asked to narrow the
// real ruleset to record it.
const withInclude = (include) => {
  const r = structuredClone(F.ruleset);

  r.conditions.ref_name.include = include;

  return r;
};
const NARROWED = withInclude(["refs/heads/main"]);
const WIDENED = withInclude(
  [...F.ruleset.conditions.ref_name.include, "refs/heads/release"]);

const wrote = (r) => r.events.some((e) => e.kind === "send");
const pushed = (r) => r.gitCalls.some((args) => args[0] === "push");

// The checkout, as a refusal must leave it.
const checkout = async (t) => ({
  head: await t.w(["rev-parse", "HEAD"]),
  branch: await t.w(["symbolic-ref", "-q", "HEAD"]),
  rebasing: ["rebase-merge", "rebase-apply"]
    .some((name) => existsSync(join(t.work, ".git", name))),
});

// Origin, the checkout, the ruleset and the saved copy's file, as a
// run that changes nothing leaves them.
const snapshot = async (t) => ({
  origin: await refs(t.o), checkout: await checkout(t),
  ruleset: t.gh.state(), file: t.saved(),
});

// The world of C's lost changes. `main`'s first commit has files of
// every kind; `next` carries one more placeholder commit, "Tidy", that
// changes each of them and rewrites a.txt's seventh line. The hotfix
// rewrites that line too, so the rebuild of next stops on "Tidy", and
// changes k.txt, which no placeholder touches.
const G = ["g1", "{", "g3", "}", "g5"];
const BYTES = [0, 1, 2, 255, 0, 7];
const BASE = {
  "g.txt": lines(G), "y.yml": "a:\n  b: 1\n", "h.txt": "keep\n",
  "bin.dat": Buffer.from(BYTES), "run.sh": "#!/bin/sh\necho run\n",
  "k.txt": "kay\n",
};
const TIDY = {
  "a.txt": lines(A.map((l, i) => ({ 1: "two from next", 6: "seven tidy" })[i]
    ?? l)),
  // A line deleted, and a line added whose text is already in the file.
  "g.txt": lines(["g1", "{", "}", "g5", "}"]),
  "y.yml": "a:\n    b: 1\n",
  "h.txt": null,
  "bin.dat": Buffer.from([0, 1, 3, 255, 0, 7]),
};
const tidy = async (s, c, dir) => {
  await s(["checkout", "-q", "--detach", c.N2]);
  write(dir, TIDY);
  await s(["add", "-A"]);
  await s(["update-index", "--chmod=+x", "run.sh"]);
  await s(["commit", "-q", "-m", "Tidy"]);
  c.T = await s(["rev-parse", "HEAD"]);
  await s(["push", "-q", "origin", `${c.T}:refs/heads/next`]);
};
const HOTFIX = [{ "a.txt": withLine(6, "seven fixed"), "k.txt": "kay fixed\n" },
  "Fix seven"];
// How a.txt should be resolved: both sides' seventh lines kept.
const SEVENTH = lines(A.map((l, i) => ({
  1: "two from next", 6: "seven fixed, tidy" })[i] ?? l));

// Each way a resolution of "Tidy" can lose a change, by the path it
// loses it in, and how.
const LOSSES = {
  "a deletion restored":
    ["g.txt", { "g.txt": lines(["g1", "{", "g3", "}", "g5", "}"]) }],
  "a dropped line whose text appears elsewhere in the file":
    ["g.txt", { "g.txt": lines(["g1", "{", "}", "g5"]) }],
  "a whitespace-only change": ["y.yml", { "y.yml": BASE["y.yml"] }],
  "a deleted file restored": ["h.txt", { "h.txt": "keep\n" }],
  "a binary changed": ["bin.dat", { "bin.dat": Buffer.from(BYTES) }],
  "a mode changed": ["run.sh", {}, true],
  "the hotfix undone in a file no placeholder touched":
    ["k.txt", { "k.txt": "kay\n" }],
};

// A world where start ran, the hotfix landed and finish stopped on
// "Tidy".
const stoppedOnTidy = async () => {
  const t = await world({ base: BASE, shape: tidy });

  ok(await run(t, "start"));
  await land(t, ...HOTFIX);
  const stop = await run(t, "finish");

  assert.ok(stop.error, "the rebuild stops on Tidy");
  assert.match(stop.text, /Tidy/);

  return t;
};

const resolve = async (t, files, unexec) => {
  write(t.work, { "a.txt": SEVENTH, ...files });
  if (unexec) chmodSync(join(t.work, "run.sh"), 0o644);
  await t.w(["add", "-A"]);
};

// The world of the newer code: a placeholder commit sets a line the
// hotfix then rewrites, and the resolution rightly keeps the hotfix's,
// which empties the placeholder commit.
const retry = async (s, c, dir) => {
  await s(["checkout", "-q", "--detach", c.N2]);
  c.R = await commit(s, dir, {
    "a.txt": lines(A.map((l, i) => ({ 1: "two from next", 6: "retry=3" })[i]
      ?? l)),
  }, "Set retry");
  await s(["push", "-q", "origin", `${c.R}:refs/heads/next`]);
};
const LOWER = [{ "a.txt": withLine(6, "retry=1") }, "Lower retry"];
const KEPT = lines(A.map((l, i) => ({ 1: "two from next", 6: "retry=1" })[i]
  ?? l));

describe("bin/nff hotfix, round 3 (#612, the security review of #631)",
  () => {
    it("A. the window refuses unless ruleset 25361439 covers exactly next, "
      + "staging and main, and then pushes nothing and writes nothing to "
      + "GitHub", async () => {
      const refusesWith = async (t, ruleset, action) => {
        t.gh.set(ruleset);
        const before = await refs(t.o);
        const r = await run(t, action);

        refused(r);
        assert.match(r.error.message, /25361439/, "names the ruleset");
        for (const ref of ruleset.conditions.ref_name.include) {
          assert.ok(r.error.message.includes(ref.replace("refs/heads/", "")),
            `names ${ref}, which it found`);
        }
        assert.ok(!pushed(r), `${action} pushes nothing`);
        assert.deepEqual(r.pushes, [], "origin took nothing");
        assert.ok(!wrote(r), `${action} writes nothing to GitHub`);
        assert.deepEqual(await refs(t.o), before, "no ref moved");
        assert.deepEqual(t.gh.state(), ruleset, "the ruleset stays as found");
      };

      // Narrowed already, at start.
      await refusesWith(await world(), NARROWED, "start");

      // Narrowed already, at step 1 of finish.
      const t = await world();

      ok(await run(t, "start"));
      await land(t, ...PLAIN);
      await refusesWith(t, NARROWED, "finish");

      // Covering a branch more than the three.
      await refusesWith(await world(), WIDENED, "start");
    });

    it("B. a run stopped inside the window leaves the saved copy in a "
      + "file, and a later start or finish finds it, or the narrowed "
      + "ruleset, and refuses before anything else, saying how to "
      + "restore", async () => {
      // The file holds the saved copy when the narrowing PUT is sent,
      // and goes once the restore reads back equal.
      const t = await world();
      const kept = (r, label) => {
        const narrowing = r.events.find((e) => e.kind === "send"
          && e.body?.conditions?.ref_name?.include?.length === 1);

        assert.ok(narrowing, `${label} narrows the ruleset`);
        assert.ok(narrowing.file, `${label} wrote the file before the PUT`);
        assert.deepEqual(JSON.parse(narrowing.file), guards(F.ruleset),
          `${label}'s file is the restoring PUT's body, exactly`);
        assert.equal(t.saved(), null, `${label} deletes it once restored`);
      };

      kept(await run(t, "start"), "start");
      await land(t, ...PLAIN);
      kept(await run(t, "finish"), "finish (step 1)");

      const refusesFirst = async (w, action, { file = true } = {}) => {
        const before = await snapshot(w);
        const r = await run(w, action);

        refused(r);
        assert.match(r.error.message, /25361439/, "names the ruleset");
        if (file) {
          assert.ok(r.error.message.includes(w.leftover), "names the file");
        }
        assert.match(r.error.message, /restor/i, "says how to restore");
        assert.ok(!pushed(r), `${action} pushes nothing`);
        assert.ok(!wrote(r), `${action} writes nothing to GitHub`);
        assert.deepEqual(await snapshot(w), before,
          "origin, the checkout, the ruleset and the file stay as found");
      };
      const reportsDry = async (w, action) => {
        const before = await snapshot(w);
        const r = await run(w, action, { dryRun: true });

        assert.ok(r.text.includes(w.leftover), `${action} --dry-run `
          + "reports the file");
        assert.ok(!pushed(r) && !wrote(r), "and changes nothing");
        assert.deepEqual(await snapshot(w), before);
      };

      // When start's restore failed, the ruleset stays narrowed and the
      // file stays. Later runs find it, whatever else they would refuse.
      const f = await world();

      f.gh.failRestore = true;
      assert.ok((await run(f, "start")).error, "start fails");
      assert.deepEqual(f.gh.state().conditions.ref_name.include,
        ["refs/heads/main"], "the ruleset is left narrowed");
      assert.ok(f.saved(), "the file is left");
      assert.deepEqual(JSON.parse(f.saved()), guards(F.ruleset));
      f.gh.failRestore = false;
      await reportsDry(f, "start");
      await reportsDry(f, "finish");
      await refusesFirst(f, "finish");
      await refusesFirst(f, "start");

      // Step 1's restore failed, after it pushed: the next run would be
      // step 2, and finds the file first.
      const h = await world();

      ok(await run(h, "start"));
      await land(h, ...PLAIN);
      h.gh.failRestore = true;
      assert.ok((await run(h, "finish")).error, "step 1 fails");
      assert.ok(h.saved(), "the file is left");
      h.gh.failRestore = false;
      await refusesFirst(h, "finish");

      // The restore read back different: the file stays.
      const m = await world();

      m.gh.tamper = true;
      assert.ok((await run(m, "start")).error);
      assert.ok(m.saved(), "a read-back that differs leaves the file");

      // Narrowed with no file (stopped in another checkout): refused,
      // saying how to restore.
      const g = await world();

      g.gh.set(NARROWED);
      await refusesFirst(g, "start", { file: false });
      g.gh.set(F.ruleset);
      ok(await run(g, "start"));
      await land(g, ...PLAIN);
      g.gh.set(NARROWED);
      await refusesFirst(g, "finish", { file: false });
    });

    it("C (criterion 6, restated). finish compares trees: a path the "
      + "hotfix did not touch must be as the placeholder had it, a path "
      + "the placeholders did not touch as main has it, and a path both "
      + "touched is shown and confirmed, even with --yes; \"main already "
      + "has it\" only for a patch-id copy", async () => {
      // A resolution that keeps everything goes through.
      const control = await stoppedOnTidy();

      await resolve(control, {});
      const passed = await run(control, "finish");

      ok(passed);
      assert.ok((await refs(control.o))["refs/heads/hotfix/rebuilt"],
        "step 1 pushed the rebuilt next");

      // Each loss, outside the paths both touched, is refused by name,
      // though every question is answered yes.
      await Promise.all(Object.entries(LOSSES)
        .map(async ([label, [path, files, unexec]]) => {
          const t = await stoppedOnTidy();
          const before = await refs(t.o);

          await resolve(t, files, unexec);
          const r = await run(t, "finish");

          refused(r);
          assert.ok(r.error.message.includes(path),
            `${label}: names ${path}`);
          assert.deepEqual(await refs(t.o), before,
            `${label}: pushes nothing and keeps the placeholders`);
          assert.ok(!wrote(r), `${label}: writes nothing to GitHub`);
        }));

      // The hotfix rewrote a line a placeholder commit set: the rebuild
      // keeps the hotfix's, which is shown and confirmed, not refused,
      // and the emptied commit is not said to be on main.
      const newer = async ({ answer = true, flags = {} } = {}) => {
        const t = await world({ shape: retry });

        ok(await run(t, "start"));
        await land(t, ...LOWER);
        t.answer = answer;

        // --dry-run asks nothing and names the path both touched.
        const asked = t.questions.length;
        const dry = await run(t, "finish", { dryRun: true });

        ok(dry);
        assert.equal(t.questions.length, asked, "--dry-run asks nothing");
        assert.match(dry.text, /a\.txt/, "--dry-run names a.txt");

        assert.ok((await run(t, "finish", { flags })).error,
          "the rebuild stops on Set retry");
        write(t.work, { "a.txt": KEPT });
        await t.w(["add", "a.txt"]);
        const before = await refs(t.o);
        const r = await run(t, "finish", { flags });
        const questions = t.questions.slice(asked);

        assert.equal(questions.length, 1, "it asks once");
        assert.match(questions[0], /a\.txt/, "naming a.txt");
        const shown = `${r.printed.join("\n")}\n${questions[0]}`;

        assert.ok(shown.includes("retry=3") && shown.includes("retry=1"),
          "and showing the difference");

        return { t, r, before };
      };

      const yes = await newer();

      ok(yes.r);
      assert.equal(await show(yes.t, (await refs(yes.t.o))[
        "refs/heads/hotfix/rebuilt"], "a.txt"), KEPT,
      "the rebuilt next keeps the hotfix's line");
      const said = yes.r.text.split("\n");

      assert.ok(!said.some((l) => l.includes("Set retry")
        && /already has it/i.test(l)), "Set retry is not said to be on main");
      assert.ok(said.some((l) => l.includes("Set retry") && /empt/i.test(l)),
        "Set retry is reported as emptied by the rebuild");

      const no = await newer({ answer: false });

      refused(no.r);
      assert.deepEqual(await refs(no.t.o), no.before,
        "a no pushes nothing and keeps the placeholders");

      ok((await newer({ flags: { yes: true } })).r);

      // A copy of a placeholder commit on main is said to be there.
      const copy = await world();

      ok(await run(copy, "start"));
      await land(copy, {}, "Hotfix the b line", { pick: copy.c.N1 });
      const asked = copy.questions.length;
      const done = await run(copy, "finish");

      ok(done);
      assert.ok(done.text.split("\n").some((l) => l.includes("Change b")
        && /main already has it/i.test(l)), "Change b is on main already");
      assert.equal(copy.questions.length, asked, "b.txt, which both "
        + "touched, is rebuilt as main and the placeholder both have it, "
        + "so nothing is asked");
    });

    it("D. start keeps the placeholders when its push of next and staging "
      + "fails but origin took it, and deletes them only when neither "
      + "moved", async () => {
      const moves = (args) => pushTargets(args)
        .some((x) => !x.delete && ["next", "staging"].includes(x.dst));

      // Origin refused the push: next and staging did not move.
      const a = await world();
      const before = await refs(a.o);

      a.failPush = moves;
      assert.ok((await run(a, "start")).error, "start fails");
      assert.deepEqual(await refs(a.o), before,
        "the placeholders are deleted, since nothing moved");

      // Origin took the push and the client saw it fail.
      const b = await world();

      b.failAfter = moves;
      const r = await run(b, "start");

      assert.ok(r.error, "start fails");
      const now = await refs(b.o);

      assert.equal(now["refs/heads/next"], b.c.M0, "next moved to main");
      assert.equal(now["refs/heads/staging"], b.c.M0);
      assert.equal(now["refs/heads/hotfix/next"], b.c.N2,
        "the placeholder for next stays");
      assert.equal(now["refs/heads/hotfix/staging"], b.c.S1,
        "the placeholder for staging stays");
      assert.match(r.text, /hotfix\/next/);
      assert.match(r.text, /hotfix\/staging/);
      assert.match(r.text, /kept|keep|stay/i, "and says they stay");
      assert.deepEqual(guards(b.gh.state()), guards(F.ruleset),
        "the ruleset is restored");
    });

    it("E. a flag other than --dry-run and --yes is refused before "
      + "anything is read or written", async () => {
      for (const [action, flag] of [["finish", "dryrun"], ["start", "force"],
        ["finish", "dry_run"]]) {
        const t = await world();

        if (action === "finish") {
          ok(await run(t, "start"));
          await land(t, ...PLAIN);
        }
        const before = await refs(t.o);
        const calls = t.gh.calls.length;
        const r = await run(t, action, { flags: { [flag]: true } });

        refused(r);
        assert.ok(r.error.message.includes(flag), `names --${flag}`);
        assert.deepEqual(r.gitCalls, [], "runs no git");
        assert.equal(t.gh.calls.length, calls, "asks GitHub nothing");
        assert.deepEqual(await refs(t.o), before, "changes nothing");
      }
    });

    it("F. step 2 run again after its pushes went through and its delete "
      + "failed only deletes the hotfix branches", async () => {
      const t = await world();

      ok(await run(t, "start"));
      await land(t, ...PLAIN);
      ok(await run(t, "finish"));
      t.failPush = (args) => pushTargets(args).some((x) => x.delete);
      assert.ok((await run(t, "finish")).error, "the delete fails");
      t.failPush = () => false;

      const mid = await refs(t.o);

      assert.equal(mid["refs/heads/next"], mid["refs/heads/hotfix/rebuilt"],
        "next is hotfix/rebuilt");
      assert.notEqual(mid["refs/heads/staging"], mid["refs/heads/main"],
        "staging has moved");

      const r = await run(t, "finish");

      ok(r);
      const now = await refs(t.o);

      assert.deepEqual(changedRefs(mid, now), [
        "refs/heads/hotfix/next", "refs/heads/hotfix/rebuilt",
        "refs/heads/hotfix/staging",
      ], "only the hotfix branches go");
      assert.equal(await head(t.o, "staging"), mid["refs/heads/staging"],
        "staging does not move again");
      assert.ok(r.pushes.every((p) => p.now === ZERO), "every push deletes");
    });
  });
