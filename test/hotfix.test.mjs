// The criteria tests for `bin/nff hotfix start` and `bin/nff hotfix
// finish` (#612), one per acceptance criterion and named for it,
// written from the criteria before the commands existed. The
// implementer may change how a test runs, never what it expects
// (~/.claude/CLAUDE.md, "Tests and implementation come from different
// agents").
//
// Live in `npm test` since the commands landed on lane/hotfix (it was
// test/hotfix.criteria.mjs, held out, until then; 2026-11-18). The
// harness is test/hotfix-world.mjs.
//
// Round 3 (the security review of #631, 2026-11-18) adds criteria A
// to F and restates criterion 6 in test/hotfix-round3.criteria.mjs,
// whose header holds that part of the contract. Where the two differ,
// round 3 wins: the old test of criterion 6 is gone from this file,
// and "Present by content" below now reads as round 3's C.
//
// The contract these tests fix, and nothing beyond it:
//
// - bin/hotfix.mjs exports
//     USAGE   the lines bin/nff prints for both commands
//     hotfixCommand(action, rest, { flags, out }, deps) -> Promise
//   as promote.mjs's promoteCommand does: `action` is "start" or
//   "finish", `rest` the words after it, `flags` bin/nff's
//   (`dry-run`, `yes`), `out(line)` prints. bin/nff routes `hotfix`
//   to it.
//   A refusal throws an Error whose message starts "Refused:" and
//   changes nothing. A stop on a conflict throws too.
// - The placeholders are branches on origin: `hotfix/next` at the
//   head `next` had and `hotfix/staging` at the head `staging` had
//   when `start` ran. Any `hotfix/*` branch on origin means a hotfix
//   is in progress. Where `start` found `main` is the merge base of
//   `hotfix/next` and `main`, which `start` requires to be old `main`.
// - deps, each replaceable here, with real defaults in the module:
//     git(args)   runs git in the checkout the command was run from,
//                 resolving to its stdout trimmed and rejecting on a
//                 non-zero exit (the error carries stdout and stderr,
//                 as execFile's does). Every git command the module
//                 runs goes through it, the fetch and every push
//                 included, against the remote named `origin`.
//     api(path, { method = "GET", body })
//                 GitHub's REST API, parsed JSON: here only GET and PUT
//                 of repos/north-foster-farm/north-foster-farm/
//                 rulesets/25361439, and GET of repos/north-foster-farm/
//                 north-foster-farm/commits/<full sha>/check-runs, which
//                 may carry ?per_page= and &page= and is paged as
//                 GitHub pages it (30 to a page unless asked).
//     confirm(question) -> Promise<boolean>
//                 asks the person running the command.
// - The force-push exception (coordinator, 2026-11-18, #612). Both
//   commands push `next` and `staging` to commits that are not fast-
//   forwards (`start` moves them back to `main`), so each opens the
//   same window: it saves ruleset 25361439, narrows it to `main` only
//   (`conditions.ref_name.include` is exactly ["refs/heads/main"]) by
//   a PUT before its first push to `next` or `staging`, restores the
//   saved copy by a PUT after its last, in a finally so a failed push
//   restores it too, then reads it back and compares it with the
//   saved copy. A mismatch is an Error naming the ruleset, never a
//   success. No write ever drops `main`, the `non_fast_forward` or
//   `deletion` rule, or adds a bypass actor. `--dry-run` writes
//   nothing to GitHub.
// - The "linear history" ruleset (25898866) covers `next`, `staging`
//   and `main`, and is never relaxed: the placeholders rebased onto a
//   linear `main` hold no merge commit. Were a rebuilt branch to hold
//   one, `finish` refuses rather than relax that ruleset.
// - `start` asks before it changes anything, through deps.confirm,
//   with a question saying the staging site will show production's
//   content until `finish`. A "no" changes nothing. `--yes` skips the
//   question, and `--dry-run` asks nothing.
// - `finish` rebuilds in the checkout. On a conflict it stops with the
//   rebase in progress; once the files are fixed and `git add`ed,
//   `finish` run again carries on from there.
// - `finish` takes two runs, because ruleset 25361919 lets `staging`
//   take only a commit on which lint-and-test, supply-chain and codeql
//   have passed, and those checks run only on a push to `next`,
//   `staging` or `main` (the #611 repair met this: `staging` was
//   refused, "3 of 3 required status checks are expected"). Required
//   checks are never relaxed (coordinator, 2026-11-18).
//   Step 1, the first `finish`: the refusals, the rebuild and the
//   content check, then, inside the window, it force-pushes `next` to
//   the rebuilt `staging` and pushes the rebuilt `next` as the new
//   branch `hotfix/rebuilt`. It keeps the placeholders, leaves
//   `staging` at `main`, and prints that `staging` follows: run
//   `finish` again once the checks on `next` are green.
//   Step 2, `finish` run again while `hotfix/rebuilt` is on origin: it
//   neither rebuilds nor applies criterion 4's refusals. It asks GitHub
//   for the check runs of `next`'s head, the commit it will push to
//   `staging`, and refuses, naming each of the three that has no
//   completed run concluded "success", until all three have one (a
//   name may also have skipped runs, which neither pass nor fail it).
//   Then it moves `staging` to that commit and `next` to
//   `hotfix/rebuilt`, both fast-forwards, deletes the placeholders
//   and `hotfix/rebuilt`, and prints the lanes that must rebase.
//   So the commit `staging` takes is one CI and CodeQL ran on as
//   `next`'s head: the #580 rule ("proven on next") that `staging`
//   takes only what a push to `next` proved. Had step 1 put `next` at
//   the rebuilt `next` instead, the rebuilt `staging` beneath it would
//   never be a head that CI runs on, and step 2 would wait forever
//   whenever `staging` was behind `next` at `start`.
// - The lanes that must rebase are origin's `lane/*` branches holding
//   a commit of the old `next` that `main` did not hold at `start`.
// - "Present by content" (criterion 6) is a comparison of trees, set
//   out as C in test/hotfix-round3.criteria.mjs (2026-11-18: this was
//   left to the implementer, judged by lines, until the security review
//   found the losses that let through).
// - Rebuilt, `staging` stays an ancestor of `next`, as the
//   placeholders were, so `next` can still be promoted to it.
//
// The tests build throwaway repositories in a temp folder: a bare
// "origin" whose pre-receive hook logs every ref update it takes, a
// "seed" clone that wrote its history, the "work" checkout the
// commands run in, and a "lander" clone that lands the hotfix by the
// ordinary means between `start` and `finish`. Nothing reaches the
// network or a real remote. GitHub's ruleset is the recorded GET
// (test/fixtures/github/ruleset-25361439.json says where from); a PUT
// is answered from it, since recording one would change the real
// ruleset. Check runs come from two recorded GETs
// (test/fixtures/github/check-runs-*.json): a commit is answered with
// the green recording once origin has taken it as the head of `next`,
// `staging` or `main` (CI ran there), and with the empty one before.
//
// Criterion 10 names the runbook and roles/coordinator.md. The tracked
// runbook for promotion is "Promoting to staging and e2e" in
// docs/cloud-lanes.md, which test 10 checks; the coordinator checks
// its own role file and the untracked release runbook.
//
// Decided by the coordinator on 2026-11-18, as the test lane
// recommended (James may overrule): the force-push window and the
// confirmation above; criterion 6 as written (restated in round 3);
// the freeze written in docs/cloud-lanes.md; `finish` in
// two steps with required checks never relaxed. Which commit step 1
// puts on `next`, so that step 2's commit has its checks, is the test
// lane's rule above, sent to the coordinator with this change.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { USAGE } from "../bin/hotfix.mjs";
import {
  CONFLICT, F, PLAIN, REQUIRED, RESOLVED, ZERO, branchPushes, changedRefs,
  commit, finishBoth, guards, has, head, isAncestor, land, neverOpens,
  noBareForce, ok, pushTargets, refs, refused, run, show, windowHeld, world,
  withLine,
} from "./hotfix-world.mjs";

describe("bin/nff hotfix (#612 acceptance criteria)", () => {
  it("1. start refuses unless next and staging both contain main, the "
    + "working tree is clean, and no hotfix is in progress", async () => {
    // `next` lacks a commit `main` has.
    const a = await world({
      shape: async (s, c, dir) => {
        await s(["checkout", "-q", "--detach", c.M0]);
        c.X = await commit(s, dir, { "g.txt": "gee\n" },
          "Main only");
        await s(["push", "-q", "-f", "origin",
          `${c.X}:refs/heads/main`, `${c.X}:refs/heads/staging`]);
      },
    });
    let before = await refs(a.o);
    let r = await run(a, "start");

    refused(r);
    assert.match(r.error.message, /\bnext\b/, "names next");
    assert.match(r.error.message, /\bmain\b/, "names main");
    assert.deepEqual(await refs(a.o), before, "changes nothing");

    // `staging` lacks a commit `main` has.
    const b = await world({
      shape: async (s, c, dir) => {
        await s(["checkout", "-q", "--detach", c.M0]);
        c.X = await commit(s, dir, { "g.txt": "gee\n" }, "Main only");
        c.Y = await commit(s, dir, { "h.txt": "aitch\n" }, "Next work");
        await s(["push", "-q", "-f", "origin",
          `${c.X}:refs/heads/main`, `${c.Y}:refs/heads/next`]);
      },
    });

    before = await refs(b.o);
    r = await run(b, "start");
    refused(r);
    assert.match(r.error.message, /\bstaging\b/, "names staging");
    assert.deepEqual(await refs(b.o), before, "changes nothing");

    // The working tree has a change.
    const d = await world();

    writeFileSync(join(d.work, "a.txt"), "edited\n");
    before = await refs(d.o);
    r = await run(d, "start");
    refused(r);
    assert.match(r.error.message,
      /working tree|clean|uncommitted|changes/i, "names the working tree");
    assert.deepEqual(await refs(d.o), before, "changes nothing");
    assert.equal(readFileSync(join(d.work, "a.txt"), "utf8"), "edited\n",
      "leaves the change where it was");

    // A hotfix is already in progress.
    const e = await world({
      shape: async (s, c) => {
        await s(["push", "-q", "origin", `${c.N2}:refs/heads/hotfix/next`]);
      },
    });

    before = await refs(e.o);
    r = await run(e, "start");
    refused(r);
    assert.match(r.error.message, /in progress|already/i,
      "names the hotfix in progress");
    assert.deepEqual(await refs(e.o), before, "changes nothing");
  });

  it("2. start records the placeholders as branches, puts next and "
    + "staging at main's commit, prints what it did and what to do next, "
    + "and changes nothing else", async () => {
    const t = await world();
    const before = await refs(t.o);
    const branch = await t.w(["symbolic-ref", "HEAD"]);
    const at = await t.w(["rev-parse", "HEAD"]);
    const r = await run(t, "start");

    ok(r);

    const now = await refs(t.o);

    assert.equal(now["refs/heads/hotfix/next"], t.c.N2);
    assert.equal(now["refs/heads/hotfix/staging"], t.c.S1);
    assert.equal(now["refs/heads/next"], t.c.M0);
    assert.equal(now["refs/heads/staging"], t.c.M0);
    assert.deepEqual(changedRefs(before, now), [
      "refs/heads/hotfix/next", "refs/heads/hotfix/staging",
      "refs/heads/next", "refs/heads/staging",
    ], "no other ref on origin moved, appeared or went");

    assert.equal(await t.w(["symbolic-ref", "HEAD"]), branch,
      "the checkout stays on its branch");
    assert.equal(await t.w(["rev-parse", "HEAD"]), at);
    assert.equal(await t.w(["status", "--porcelain"]), "",
      "the working tree is untouched");

    assert.match(r.text, /hotfix\/next/, "names the placeholder for next");
    assert.match(r.text, /hotfix\/staging/,
      "names the placeholder for staging");
    assert.ok(r.text.includes(t.c.M0.slice(0, 7)),
      "names main's commit, where next and staging now are");
    assert.match(r.text, /hotfix finish/, "says to run finish next");
  });

  it("3. nothing in the commands lands or promotes the hotfix", async () => {
    const t = await world();
    const started = await run(t, "start");

    ok(started);
    assert.equal(await head(t.o, "main"), t.c.M0, "start leaves main");
    assert.equal(await head(t.o, "next"), t.c.M0,
      "start puts nothing on next beyond main");
    assert.ok(!started.pushes.some((p) => p.ref === "refs/heads/main"),
      "start never pushes main");

    const fix = await land(t, ...PLAIN);
    const finished = await finishBoth(t);

    ok(finished);
    assert.ok(finished.two, "both steps of finish ran");
    assert.equal(await head(t.o, "main"), fix,
      "main is where the ordinary means put it");
    assert.ok(!finished.pushes.some((p) => p.ref === "refs/heads/main"),
      "neither step of finish pushes main");
  });

  it("4. finish refuses unless main has moved past where start found it "
    + "and main, staging and next are the same commit", async () => {
    // `main` has not moved.
    const a = await world();

    ok(await run(a, "start"));
    let before = await refs(a.o);
    let r = await run(a, "finish");

    refused(r);
    assert.match(r.error.message, /\bmain\b/, "names main");
    assert.deepEqual(await refs(a.o), before, "changes nothing");

    // `main` moved, and `next` went on past it.
    const b = await world();

    ok(await run(b, "start"));
    await land(b, ...PLAIN);
    await land(b, { "h.txt": "aitch\n" }, "More on next", { to: ["next"] });
    before = await refs(b.o);
    r = await run(b, "finish");
    refused(r);
    assert.match(r.error.message, /\bnext\b/, "names next");
    assert.deepEqual(await refs(b.o), before, "changes nothing");

    // `main` moved, and `staging` was left behind.
    const d = await world();

    ok(await run(d, "start"));
    await land(d, ...PLAIN, { to: ["next", "main"] });
    before = await refs(d.o);
    r = await run(d, "finish");
    refused(r);
    assert.match(r.error.message, /\bstaging\b/, "names staging");
    assert.deepEqual(await refs(d.o), before, "changes nothing");

    // At step 2, `next` has rightly moved past `main` and `staging`:
    // none of these refusals stops it.
    const g = await world();

    ok(await run(g, "start"));
    await land(g, ...PLAIN);
    ok(await run(g, "finish"));
    assert.notEqual(await head(g.o, "next"), await head(g.o, "main"),
      "step 1 moved next past main");
    ok(await run(g, "finish"));
  });

  it("5. finish rebases the placeholders onto main, stops on a conflict "
    + "naming the commit and the files, and can be run again once it is "
    + "resolved", async () => {
    const t = await world();

    ok(await run(t, "start"));

    const fix = await land(t, ...CONFLICT);
    const before = await refs(t.o);
    const stopped = await run(t, "finish");

    assert.ok(stopped.error, "it stops");
    assert.match(stopped.text, /Reword two/, "names the commit");
    assert.match(stopped.text, /a\.txt/, "names the file");
    assert.deepEqual(await refs(t.o), before,
      "pushes nothing and keeps the placeholders while stopped");

    writeFileSync(join(t.work, "a.txt"), RESOLVED);
    await t.w(["add", "a.txt"]);

    ok(await finishBoth(t));

    assert.equal(await head(t.o, "main"), fix);
    const next = await head(t.o, "next");
    const staging = await head(t.o, "staging");

    assert.ok(await isAncestor(t.o, fix, staging), "staging is on main");
    assert.ok(await isAncestor(t.o, staging, next),
      "next is on staging, as the placeholders were");
    assert.equal(await show(t, next, "a.txt"), RESOLVED,
      "next keeps the resolution");
    assert.equal(await show(t, next, "b.txt"), "bee changed on next\n");
    assert.ok(await has(t.o, next, "c.txt"));
    assert.ok(await has(t.o, next, "d.txt"));
    assert.ok(await has(t.o, staging, "c.txt"), "staging holds its own");
    assert.equal(await show(t, staging, "b.txt"), "bee\n",
      "and nothing that was only on next");
    assert.ok(!await has(t.o, staging, "d.txt"));
    assert.equal(await show(t, staging, "a.txt"),
      withLine(1, "two from main"));
  });

  it("7. finish force-pushes next and staging only, then deletes the "
    + "placeholders, and prints the lanes that must rebase (in two steps: "
    + "next first, staging once its checks are green)", async () => {
    const t = await world();

    ok(await run(t, "start"));
    const fix = await land(t, ...PLAIN);
    const before = await refs(t.o);

    // Step 1: `next` moves to the rebuilt staging, the rebuilt next
    // waits as `hotfix/rebuilt`, and nothing else moves.
    const one = await run(t, "finish");

    ok(one);

    const mid = await refs(t.o);
    const next1 = mid["refs/heads/next"];
    const rebuilt = mid["refs/heads/hotfix/rebuilt"];

    assert.deepEqual(changedRefs(before, mid),
      ["refs/heads/hotfix/rebuilt", "refs/heads/next"],
      "step 1 moves next and adds hotfix/rebuilt, and nothing else");
    assert.equal(mid["refs/heads/staging"], fix, "staging stays at main");
    assert.equal(mid["refs/heads/hotfix/next"], t.c.N2,
      "the placeholder for next stays");
    assert.equal(mid["refs/heads/hotfix/staging"], t.c.S1,
      "the placeholder for staging stays");
    assert.ok(await isAncestor(t.o, fix, next1), "next is on main");
    assert.ok(await has(t.o, next1, "c.txt"),
      "next holds what staging held");
    assert.ok(!await has(t.o, next1, "d.txt"),
      "and nothing that was only on next");
    assert.ok(await isAncestor(t.o, next1, rebuilt),
      "hotfix/rebuilt is on next");
    assert.ok(await has(t.o, rebuilt, "d.txt"),
      "and holds what next held");
    assert.equal(one.pushes.filter((p) => p.now === ZERO).length, 0,
      "step 1 deletes nothing");
    assert.match(one.text, /\bstaging\b/, "says staging follows");
    assert.match(one.text, /hotfix finish/, "says to run finish again");
    assert.match(one.text, /check/i, "once the checks are green");

    // Step 2: `staging` takes the commit next held, `next` takes the
    // rebuilt next, and the hotfix branches go.
    const two = await run(t, "finish");

    ok(two);

    const now = await refs(t.o);

    assert.deepEqual(changedRefs(mid, now), [
      "refs/heads/hotfix/next", "refs/heads/hotfix/rebuilt",
      "refs/heads/hotfix/staging", "refs/heads/next", "refs/heads/staging",
    ], "step 2 moves next and staging and deletes the hotfix branches, "
      + "and nothing else");
    assert.deepEqual(changedRefs(before, now),
      ["refs/heads/hotfix/next", "refs/heads/hotfix/staging",
        "refs/heads/next", "refs/heads/staging"],
      "across both steps, no other ref on origin moved, appeared or went");
    assert.equal(now["refs/heads/staging"], next1,
      "staging is the commit next held after step 1");
    assert.equal(now["refs/heads/next"], rebuilt,
      "next is the rebuilt next");

    const at = (ref) => two.pushes.findLastIndex((p) => p.ref === ref);
    const pushed = Math.max(at("refs/heads/next"),
      at("refs/heads/staging"));
    const deleted = two.pushes.map((p, i) => [p, i])
      .filter(([p]) => p.now === ZERO).map(([, i]) => i);

    assert.ok(at("refs/heads/next") >= 0 && at("refs/heads/staging") >= 0,
      "next and staging were pushed");
    assert.equal(deleted.length, 3,
      "both placeholders and hotfix/rebuilt were deleted");
    assert.ok(deleted.every((i) => i > pushed),
      "they go only after next and staging are pushed");

    assert.match(two.text, /lane\/alpha/,
      "names the lane cut from the old next");
    assert.doesNotMatch(two.text, /lane\/beta/,
      "and not the lane cut from main, which needs no rebase");
  });

  it("8. both commands take --dry-run, which prints the plan and changes "
    + "nothing", async () => {
    // Both are offered with it, through bin/nff.
    assert.match(USAGE, /hotfix start[^\n]*--dry-run/);
    assert.match(USAGE, /hotfix finish[^\n]*--dry-run/);
    assert.ok(readFileSync(new URL("../bin/nff", import.meta.url), "utf8")
      .includes("./hotfix.mjs"), "bin/nff routes hotfix to the commands");

    const snapshot = async (t) => ({
      origin: await refs(t.o), work: await refs(t.w),
      status: await t.w(["status", "--porcelain"]),
      head: await t.w(["rev-parse", "HEAD"]),
    });
    const unchanged = async (t, before, r) => {
      assert.deepEqual(await snapshot(t), before,
        "no ref moved, no branch made, the checkout untouched");
      assert.deepEqual(r.pushes, [], "origin took no push");
      assert.deepEqual(t.gh.writes(), [], "GitHub took no write");
      for (const name of ["rebase-merge", "rebase-apply"]) {
        assert.ok(!existsSync(join(t.work, ".git", name)),
          "no rebase is left in progress");
      }
    };

    const a = await world();

    await a.w(["fetch", "-q", "--prune", "origin"]);
    let before = await snapshot(a);
    let r = await run(a, "start", { dryRun: true });

    ok(r);
    assert.match(r.text, /\bnext\b/);
    assert.match(r.text, /\bstaging\b/);
    assert.ok(r.text.includes(a.c.M0.slice(0, 7)),
      "the plan names main's commit");
    await unchanged(a, before, r);

    const b = await world();

    ok(await run(b, "start"));
    await land(b, ...PLAIN);
    await b.w(["fetch", "-q", "--prune", "origin"]);

    before = await snapshot(b);
    b.gh.calls.length = 0;
    r = await run(b, "finish", { dryRun: true });
    ok(r);
    assert.match(r.text, /\bnext\b/);
    assert.match(r.text, /\bstaging\b/);
    await unchanged(b, before, r);

    // Step 2, after a real step 1.
    ok(await run(b, "finish"));
    await b.w(["fetch", "-q", "--prune", "origin"]);
    before = await snapshot(b);
    b.gh.calls.length = 0;
    r = await run(b, "finish", { dryRun: true });
    ok(r);
    assert.match(r.text, /\bstaging\b/, "the plan for step 2 names staging");
    await unchanged(b, before, r);
  });

  it("9. neither command can move main, and neither pushes with force to "
    + "any branch but next and staging", async () => {
    const t = await world();
    const started = await run(t, "start");

    ok(started);
    await land(t, {}, "Hotfix the b line", { pick: t.c.N1 });
    const finished = await finishBoth(t);

    ok(finished);
    assert.ok(finished.two, "both steps of finish ran");

    // What origin took from the commands.
    for (const p of [...started.pushes, ...finished.pushes]) {
      assert.notEqual(p.ref, "refs/heads/main", "main never moves");
      if (p.now === ZERO) {
        assert.match(p.ref, /^refs\/heads\/hotfix\//,
          `only a placeholder is deleted, not ${p.ref}`);
      } else if (p.old !== ZERO && !await isAncestor(t.o, p.old, p.now)) {
        assert.ok(["refs/heads/next", "refs/heads/staging"]
          .includes(p.ref), `${p.ref} is not rewritten`);
      }
    }

    // What the commands asked git to push.
    const pushes = [...started.gitCalls, ...finished.gitCalls]
      .filter((args) => args[0] === "push");

    assert.ok(pushes.length > 0, "every push goes through the seam");
    for (const args of pushes) {
      assert.ok(!args.some((w) => w === "--all" || w === "--mirror"),
        `pushes name their branches: git ${args.join(" ")}`);
      for (const target of pushTargets(args)) {
        assert.notEqual(target.dst, "main",
          `never pushes main: git ${args.join(" ")}`);
        if (target.force && !target.delete) {
          assert.ok(["next", "staging"].includes(target.dst),
            `force only to next and staging: git ${args.join(" ")}`);
        }
      }
    }

    // What the commands asked GitHub to change.
    for (const { body } of t.gh.writes()) {
      const include = body?.conditions?.ref_name?.include;
      const rules = body?.rules;

      if (include) {
        assert.ok(include.includes("refs/heads/main"),
          "main stays in the no force-push ruleset");
      }
      if (rules) {
        assert.ok(rules.some((rule) => rule.type === "non_fast_forward"),
          "the ruleset keeps its no force-push rule");
      }
    }
  });

  it("10. the runbook says landings on next are frozen from hotfix start "
    + "to hotfix finish (\"Promoting to staging and e2e\" in "
    + "docs/cloud-lanes.md)", () => {
    const doc = readFileSync(new URL("../docs/cloud-lanes.md",
      import.meta.url), "utf8");
    const section = doc.split(/^## /m)
      .find((s) => s.startsWith("Promoting to staging and e2e"));

    assert.ok(section, "the section is there");
    const said = section.split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " "))
      .some((p) => /hotfix start/.test(p) && /hotfix finish/.test(p)
        && /\bnext\b/.test(p) && /frozen|freeze/i.test(p));

    assert.ok(said, "one paragraph says landings on next are frozen from "
      + "hotfix start to hotfix finish");
  });

  it("the force-push exception: start and finish narrow ruleset 25361439 "
    + "to main alone around their forced pushes to next and staging, "
    + "restore it even when a push fails, and read it back against the "
    + "saved copy", async () => {
    const t = await world();

    ok(await run(t, "start", { dryRun: true }));
    assert.deepEqual(t.gh.writes(), [],
      "start --dry-run writes nothing to GitHub");

    const started = await run(t, "start");

    ok(started);
    windowHeld(started, "start");
    await land(t, ...PLAIN);
    const written = t.gh.writes().length;

    ok(await run(t, "finish", { dryRun: true }));
    assert.equal(t.gh.writes().length, written,
      "finish --dry-run writes nothing to GitHub");

    const finished = await run(t, "finish");

    ok(finished);
    windowHeld(finished, "finish (step 1)");

    // Step 2 moves `staging` and `next` forward only: neither push is
    // forced past anything, so it needs no window.
    const mid = await refs(t.o);
    const second = await run(t, "finish");

    ok(second);
    noBareForce(second, "finish (step 2)");
    for (const name of ["next", "staging"]) {
      const p = second.pushes.find((x) => x.ref === `refs/heads/${name}`);

      assert.ok(p, `step 2 pushes ${name}`);
      assert.equal(p.old, mid[`refs/heads/${name}`]);
      assert.ok(await isAncestor(t.o, p.old, p.now),
        `step 2 moves ${name} by a fast-forward`);
    }
    neverOpens(t.events);

    // A push that fails part-way still gets the ruleset restored: start's
    // last push moves staging, finish's step 1 moves next.
    for (const [action, target] of [["start", "staging"],
      ["finish", "next"]]) {
      const f = await world();

      if (action === "finish") {
        ok(await run(f, "start"));
        await land(f, ...PLAIN);
      }
      f.failPush = (args) => pushTargets(args)
        .some((x) => x.dst === target && !x.delete);

      const r = await run(f, action);
      const writes = r.events.filter((e) => e.kind === "write");
      const failed = r.events.indexOf(branchPushes(r.events).at(-1));

      assert.ok(r.error, `${action} fails with its push`);
      assert.ok(failed >= 0, `${action} tried to push ${target}`);
      assert.ok(writes.length >= 2
        && r.events.indexOf(writes.at(-1)) > failed,
      `${action} restores the ruleset after the failed push`);
      assert.deepEqual(guards(f.gh.state()), guards(F.ruleset),
        `${action} leaves the ruleset as it found it`);
      neverOpens(f.events);
    }

    // A read-back that differs from the saved copy is never a success.
    for (const action of ["start", "finish"]) {
      const m = await world();

      if (action === "finish") {
        ok(await run(m, "start"));
        await land(m, ...PLAIN);
      }
      m.gh.tamper = true;

      const r = await run(m, action);

      assert.ok(r.error,
        `${action} exits non-zero when the ruleset reads back changed`);
      assert.match(r.error.message, /ruleset|25361439/i,
        "names the ruleset");
      assert.match(r.error.message, /match|differ|restor/i,
        "says it is not as it was saved");
    }
  });

  it("finish never relaxes the linear history ruleset (25898866) and "
    + "pushes no merge commit to next or staging", async () => {
    const t = await world({
      shape: async (s, c, dir) => {
        await s(["checkout", "-q", "-b", "side", c.S1]);
        await commit(s, dir, { "s.txt": "side\n" }, "Side work");
        await s(["checkout", "-q", "--detach", c.N2]);
        await s(["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
        await s(["push", "-q", "origin", "HEAD:refs/heads/next"]);
      },
    });

    ok(await run(t, "start"));

    const fix = await land(t, ...PLAIN);
    const r = await finishBoth(t);

    for (const branch of ["next", "staging"]) {
      assert.equal(await t.o(["rev-list", "--merges",
        `${fix}..refs/heads/${branch}`]), "",
      `${branch} holds no merge commit past main`);
    }
    assert.ok(!t.gh.calls.some((c) => /rulesets\/25898866/.test(c.path)
      && c.method !== "GET"), "the linear history ruleset is never written");
    if (r.error) {
      assert.match(r.error.message, /^Refused:/,
        "a merge commit is refused, not let through");
    }
  });

  it("finish's second step moves staging only to the commit next held, "
    + "once lint-and-test, supply-chain and codeql have passed on it, and "
    + "refuses naming each that has not", async () => {
    const t = await world();

    ok(await run(t, "start"));
    await land(t, ...PLAIN);
    ok(await run(t, "finish"));

    const mid = await refs(t.o);
    const proven = mid["refs/heads/next"];
    const asked = (r) => r.events.filter((e) => e.kind === "checks")
      .map((e) => e.sha);

    // Nothing has run on `next` yet.
    t.ci = "none";
    let r = await run(t, "finish");

    refused(r);
    for (const name of REQUIRED) {
      assert.ok(r.error.message.includes(name), `names ${name}`);
    }
    assert.ok(asked(r).includes(proven),
      "asks GitHub about the commit next holds");
    assert.deepEqual(await refs(t.o), mid, "changes nothing");
    assert.deepEqual(r.pushes, [], "pushes nothing");

    // CI has passed but CodeQL has not run.
    t.ci = "partial";
    r = await run(t, "finish");
    refused(r);
    assert.ok(r.error.message.includes("codeql"), "names codeql");
    assert.deepEqual(await refs(t.o), mid, "changes nothing");

    // All three have passed, among the recording's skipped runs.
    t.ci = "green";
    r = await run(t, "finish");
    ok(r);
    assert.equal(await head(t.o, "staging"), proven,
      "staging is the commit next held");
    assert.equal(asked(r).at(-1), proven,
      "the last commit it asked about is the one staging took");
  });

  it("start asks before the staging site shows production's content, "
    + "changes nothing on a no, and asks nothing with --yes or --dry-run",
  async () => {
    const t = await world();

    t.answer = false;
    ok(await run(t, "start", { dryRun: true }));
    assert.deepEqual(t.questions, [], "--dry-run asks nothing");

    const before = await refs(t.o);
    const no = await run(t, "start");

    assert.equal(t.questions.length, 1, "it asks once");
    assert.match(t.questions[0], /staging/i, "the question names staging");
    assert.match(t.questions[0], /production/i,
      "and says it will show production's content");
    assert.deepEqual(await refs(t.o), before, "a no changes nothing");
    assert.deepEqual(no.pushes, [], "and pushes nothing");
    assert.deepEqual(t.gh.writes(), [], "and writes nothing to GitHub");

    ok(await run(t, "start", { flags: { yes: true } }));
    assert.equal(t.questions.length, 1, "--yes asks nothing");
    assert.equal(await head(t.o, "next"), t.c.M0, "and starts");
  });
});
