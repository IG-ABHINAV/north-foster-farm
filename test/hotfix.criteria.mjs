/* eslint-disable camelcase -- GitHub names its fields its way */
// The criteria tests for `bin/nff hotfix start` and `bin/nff hotfix
// finish` (#612), one per acceptance criterion and named for it,
// written from the criteria before the commands existed. The
// implementer may change how a test runs, never what it expects
// (~/.claude/CLAUDE.md, "Tests and implementation come from different
// agents").
//
// Held out of `npm test` until the commands exist: `npm test` runs
// test/**/*.test.mjs and this file is *.criteria.mjs. Run it on
// purpose with
//   node --import ./test/setup.mjs --test test/hotfix.criteria.mjs
// and turn it on by renaming it to test/hotfix.test.mjs.
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
//                 rulesets/25361439.
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
// - The lanes that must rebase are origin's `lane/*` branches holding
//   a commit of the old `next` that `main` did not hold at `start`.
// - "Present by content" (criterion 6) is the implementer's to judge,
//   so long as two cases come out right: a resolution that keeps every
//   line the placeholder commit added passes, and one that loses such
//   a line is refused. A commit git drops because `main` holds a copy
//   of it is reported by its subject on a line saying it was dropped.
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
// ruleset.
//
// Criterion 10 names the runbook and roles/coordinator.md. The tracked
// runbook for promotion is "Promoting to staging and e2e" in
// docs/cloud-lanes.md, which test 10 checks; the coordinator checks
// its own role file and the untracked release runbook.
//
// Decided by the coordinator on 2026-11-18, as the test lane
// recommended (James may overrule): the force-push window and the
// confirmation above; criterion 6 as written, with no flag to accept
// a lost line; the freeze written in docs/cloud-lanes.md.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

import { USAGE, hotfixCommand } from "../bin/hotfix.mjs";

const exec = promisify(execFile);

const F = JSON.parse(readFileSync(new URL(
  "fixtures/github/ruleset-25361439.json", import.meta.url), "utf8"));
const RULESET_PATH =
  /^\/?repos\/north-foster-farm\/north-foster-farm\/rulesets\/25361439$/;

const ZERO = "0".repeat(40);
const ROOT = mkdtempSync(join(tmpdir(), "hotfix-criteria-"));
const GLOBAL = join(ROOT, "gitconfig");

writeFileSync(GLOBAL, "");
after(() => rmSync(ROOT, { recursive: true, force: true }));

// Git with none of this machine's own settings (signing, hooks,
// editors), so the repositories behave the same here and in CI.
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: GLOBAL, GIT_CONFIG_NOSYSTEM: "1",
  GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
};

const gitIn = (cwd) => async (args) => (await exec("git", args,
  { cwd, env: ENV, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

const A = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
const lines = (list) => `${list.join("\n")}\n`;
const withLine = (i, text) => lines(A.map((l, j) => (j === i ? text : l)));

// The pre-receive hook: one line per ref update, `<push> <old> <new>
// <ref>`, where <push> tells one push from another.
const HOOK = (log) => [
  "#!/bin/sh",
  "while read old new ref",
  "do",
  `  echo "$$ $old $new $ref" >> "${log}"`,
  "done",
  "exit 0",
  "",
].join("\n");

const write = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
};

const commit = async (g, dir, files, subject) => {
  write(dir, files);
  await g(["add", "-A"]);
  await g(["commit", "-q", "-m", subject]);

  return g(["rev-parse", "HEAD"]);
};

let count = 0;

// The repositories, as they stand when a hotfix is wanted: `staging`
// one commit ahead of `main`, `next` two ahead of `staging`, a lane
// cut from `next` and one cut from `main`, a backup branch and a tag.
// `shape(seed, c, dir)` may rearrange origin before the checkouts clone it.
const world = async ({ shape } = {}) => {
  count += 1;
  const dir = join(ROOT, `w${count}`);
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const work = join(dir, "work");
  const lander = join(dir, "lander");
  const log = join(dir, "pushes.log");

  mkdirSync(seed, { recursive: true });
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin],
    { env: ENV });
  writeFileSync(join(origin, "hooks", "pre-receive"), HOOK(log));
  chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
  writeFileSync(log, "");

  const s = gitIn(seed);

  await s(["init", "-q", "-b", "main"]);
  await s(["remote", "add", "origin", origin]);

  const c = {};

  c.M0 = await commit(s, seed, { "a.txt": lines(A), "b.txt": "bee\n" },
    "Start the site");
  await s(["tag", "v1"]);
  c.S1 = await commit(s, seed, { "c.txt": "sea\n" }, "Add c");
  c.N1 = await commit(s, seed, { "b.txt": "bee changed on next\n" },
    "Change b");
  c.N2 = await commit(s, seed,
    { "a.txt": withLine(1, "two from next"), "d.txt": "dee\n" },
    "Reword two");
  await s(["checkout", "-q", "-b", "lane/alpha"]);
  c.alpha = await commit(s, seed, { "e.txt": "alpha\n" }, "Alpha work");
  await s(["checkout", "-q", "-b", "lane/beta", c.M0]);
  c.beta = await commit(s, seed, { "f.txt": "beta\n" }, "Beta work");
  await s(["checkout", "-q", "--detach", c.M0]);

  await s(["push", "-q", "origin",
    `${c.M0}:refs/heads/main`, `${c.S1}:refs/heads/staging`,
    `${c.N2}:refs/heads/next`, "lane/alpha", "lane/beta",
    `${c.S1}:refs/heads/backup/keep`, "refs/tags/v1"]);

  if (shape) await shape(s, c, seed);

  await exec("git", ["clone", "-q", origin, work], { env: ENV });
  await exec("git", ["clone", "-q", origin, lander], { env: ENV });

  const w = gitIn(work);
  const gitCalls = [];
  const events = [];
  const gh = github(events);
  const t = {
    dir, origin, work, c, gh, gitCalls, events,
    seed: s, w, o: gitIn(origin), l: gitIn(lander), lander,
    // The answer to start's question, the questions asked, and which
    // pushes fail.
    answer: true, questions: [], failPush: () => false,
    deps: {
      // A push is logged with the ruleset as it stood when it was made.
      git: async (args) => {
        gitCalls.push(args);
        if (args[0] === "push") {
          events.push({ kind: "push", args, ruleset: gh.state() });
          if (t.failPush(args)) {
            throw Object.assign(new Error(`git ${args.join(" ")} failed`),
              { stdout: "", stderr: "! [remote rejected]" });
          }
        }

        return w(args);
      },
      api: gh.api,
      confirm: async (question) => {
        t.questions.push(String(question));

        return t.answer;
      },
    },
    pushes: () => readFileSync(log, "utf8").split("\n").filter(Boolean)
      .map((line) => {
        const [push, old, now, ref] = line.split(" ");

        return { push, old, now, ref };
      }),
  };

  return t;
};

// GitHub, answering from the recorded GET of ruleset 25361439. A PUT
// is answered with that recording's shape carrying what was sent, as
// GitHub returns the ruleset it stored; no PUT was recorded, since
// that would change the real ruleset. With `tamper` on, a PUT that
// gives `next` back is stored without `staging`, as if GitHub had not
// taken the restore whole, so the read-back differs from the saved
// copy. Any other call was never recorded.
const github = (events) => {
  let current = structuredClone(F.ruleset);
  const calls = [];
  const gh = { tamper: false };
  const api = async (path, { method = "GET", body } = {}) => {
    calls.push({ path, method, body });
    if (!RULESET_PATH.test(path)) {
      throw new Error(`unrecorded ${method} ${path}`);
    }
    if (method === "GET") {
      events.push({ kind: "read" });

      return structuredClone(current);
    }
    if (method === "PUT") {
      current = { ...current, ...structuredClone(body) };
      const include = current.conditions?.ref_name?.include ?? [];

      if (gh.tamper && include.includes("refs/heads/next")) {
        current.conditions.ref_name.include =
          include.filter((ref) => ref !== "refs/heads/staging");
      }
      events.push({ kind: "write", ruleset: structuredClone(current) });

      return structuredClone(current);
    }
    throw new Error(`unrecorded ${method} ${path}`);
  };

  return Object.assign(gh, {
    api, calls, state: () => structuredClone(current),
    writes: () => calls.filter((c) => c.method !== "GET"),
  });
};

// The parts of a ruleset that say what it protects.
const guards = (r) => ({
  name: r.name, target: r.target, enforcement: r.enforcement,
  conditions: r.conditions, rules: r.rules, bypass_actors: r.bypass_actors,
});

// Every ref and what it points at.
const refs = async (g) => Object.fromEntries((await g(["for-each-ref",
  "--format=%(refname) %(objectname)"])).split("\n").filter(Boolean)
  .map((line) => line.split(" ")));

const head = (o, name) => o(["rev-parse", `refs/heads/${name}`]);
// A file as origin holds it, to the last byte.
const show = async (t, ref, file) => (await exec("git",
  ["show", `${ref}:${file}`], { cwd: t.origin, env: ENV })).stdout;
const has = async (o, ref, file) => {
  try {
    await o(["cat-file", "-e", `${ref}:${file}`]);

    return true;
  } catch {
    return false;
  }
};
const isAncestor = async (g, a, b) => {
  try {
    await g(["merge-base", "--is-ancestor", a, b]);

    return true;
  } catch {
    return false;
  }
};
const changedRefs = (before, now) => [...new Set([
  ...Object.keys(before), ...Object.keys(now),
])].filter((k) => before[k] !== now[k]).sort();

// One run of a command, as bin/nff would make it.
const run = async (t, action, { dryRun = false, flags = {} } = {}) => {
  const printed = [];
  const from = t.pushes().length;
  const calls = t.gitCalls.length;
  const seen = t.events.length;
  let error;

  try {
    await hotfixCommand(action, [], {
      flags: dryRun ? { ...flags, "dry-run": true } : flags,
      out: (line) => printed.push(String(line)),
    }, t.deps);
  } catch (e) {
    error = e;
  }

  return {
    error, printed,
    text: [...printed, error?.message ?? ""].join("\n"),
    pushes: t.pushes().slice(from),
    gitCalls: t.gitCalls.slice(calls),
    events: t.events.slice(seen),
  };
};

const ok = (r) => assert.ifError(r.error);
const refused = (r) => {
  assert.ok(r.error, "it refuses");
  assert.match(r.error.message, /^Refused:/);
};

// The hotfix, landed by the ordinary means: a commit on `next`, then
// `staging`, then `main`, each a fast-forward. `to` picks the branches.
const land = async (t, files, subject,
  { to = ["next", "staging", "main"], pick } = {}) => {
  await t.l(["fetch", "-q", "origin"]);
  await t.l(["checkout", "-q", "-B", "hot", "origin/next"]);

  let sha;

  if (pick) {
    await t.l(["cherry-pick", pick]);
    await t.l(["commit", "-q", "--amend", "-m", subject]);
    sha = await t.l(["rev-parse", "HEAD"]);
  } else {
    sha = await commit(t.l, t.lander, files, subject);
  }
  for (const branch of to) {
    await t.l(["push", "-q", "origin", `${sha}:refs/heads/${branch}`]);
  }

  return sha;
};

const PLAIN = [{ "a.txt": withLine(7, "eight fixed") }, "Fix eight"];
const CONFLICT = [{ "a.txt": withLine(1, "two from main") }, "Fix two"];

// A resolution of CONFLICT that keeps both sides' lines, so the rebuilt
// next holds every line the placeholder added.
const RESOLVED = lines(
  [A[0], "two from main", "two from next", ...A.slice(2)]);

// A placeholder commit's subject and the word that says it was dropped,
// on one printed line.
const reportsDropped = (text, subject) => text.split("\n").some((line) =>
  line.includes(subject) && /drop|already/i.test(line));

const FORCE = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes)$/;

// The destinations of one `git push` the seam saw, each with whether it
// was pushed with force and whether it was a deletion.
const pushTargets = (args) => {
  const words = args.slice(1);
  const forced = words.some((w) => FORCE.test(w));
  const deleting = words.includes("-d") || words.includes("--delete");
  const plain = words.filter((w) => !w.startsWith("-")).slice(1);

  return plain.map((spec) => {
    const dst = (spec.includes(":") ? spec.split(":").at(-1) : spec)
      .replace(/^\+/, "").replace(/^refs\/heads\//, "");

    return {
      spec, dst,
      force: forced || spec.startsWith("+"),
      delete: deleting || spec.startsWith(":"),
    };
  });
};

// The pushes among a run's events that move `next` or `staging`.
const branchPushes = (events) => events.filter((e) => e.kind === "push"
  && pushTargets(e.args)
    .some((x) => !x.delete && ["next", "staging"].includes(x.dst)));

// One run kept its pushes to `next` and `staging` inside the window:
// narrowed to `main` alone before the first, restored to the saved
// copy after the last, and read back after that.
const windowHeld = (r, label) => {
  const pushes = branchPushes(r.events);
  const writes = r.events.filter((e) => e.kind === "write");
  const at = (e) => r.events.indexOf(e);

  assert.ok(pushes.length > 0, `${label} pushes next or staging`);
  assert.ok(writes.length >= 2, `${label} narrows and restores the ruleset`);
  assert.ok(at(writes[0]) < at(pushes[0]),
    `${label} narrows the ruleset before its first push`);
  for (const p of pushes) {
    assert.deepEqual(p.ruleset.conditions.ref_name.include,
      ["refs/heads/main"], `${label} pushes while it covers main alone`);
  }
  assert.ok(at(writes.at(-1)) > at(pushes.at(-1)),
    `${label} restores the ruleset after its last push`);
  assert.deepEqual(guards(writes.at(-1).ruleset), guards(F.ruleset),
    `${label} restores the saved copy`);
  assert.ok(r.events.slice(at(writes.at(-1)) + 1)
    .some((e) => e.kind === "read"), `${label} reads it back after`);
};

// No write ever left `main` open: it stays covered, both rules stay,
// and no one may bypass them.
const neverOpens = (events) => {
  for (const { ruleset } of events.filter((e) => e.kind === "write")) {
    const types = (ruleset.rules ?? []).map((rule) => rule.type);

    assert.ok(ruleset.conditions.ref_name.include
      .includes("refs/heads/main"), "main stays in the ruleset");
    assert.ok(types.includes("non_fast_forward"),
      "the no force-push rule stays");
    assert.ok(types.includes("deletion"), "the no deletion rule stays");
    assert.deepEqual(ruleset.bypass_actors, [], "no bypass actor");
  }
};

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
    const finished = await run(t, "finish");

    ok(finished);
    assert.equal(await head(t.o, "main"), fix,
      "main is where the ordinary means put it");
    assert.ok(!finished.pushes.some((p) => p.ref === "refs/heads/main"),
      "finish never pushes main");
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

    ok(await run(t, "finish"));

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

  it("6. finish refuses to push unless the rebuilt next and staging hold "
    + "every change the placeholders did, each present by content or "
    + "reported by name as dropped because main already has it",
  async () => {
    // A placeholder commit main already has, as a copy, is reported.
    const a = await world();

    ok(await run(a, "start"));

    const fix = await land(a, {}, "Hotfix the b line", { pick: a.c.N1 });
    const done = await run(a, "finish");

    ok(done);
    assert.ok(reportsDropped(done.text, "Change b"),
      "names Change b as dropped because main has it");
    const next = await head(a.o, "next");

    assert.ok(await isAncestor(a.o, fix, next));
    assert.ok(await has(a.o, next, "c.txt"), "Add c is present");
    assert.ok(await has(a.o, next, "d.txt"), "Reword two is present");
    assert.equal(await show(a, next, "a.txt"),
      withLine(1, "two from next"));
    assert.deepEqual(new Set((await a.o(["log", "--format=%s",
      `${fix}..${next}`])).split("\n")), new Set(["Add c", "Reword two"]),
    "and Change b is not made again on top of its copy");

    // A resolution that loses a placeholder's change is refused.
    const b = await world();

    ok(await run(b, "start"));
    await land(b, ...CONFLICT);
    const before = await refs(b.o);

    assert.ok((await run(b, "finish")).error, "stops on the conflict");
    writeFileSync(join(b.work, "a.txt"), withLine(1, "two from main"));
    await b.w(["add", "a.txt"]);

    const r = await run(b, "finish");

    refused(r);
    assert.match(r.text, /Reword two/, "names the commit whose change "
      + "the rebuilt next lacks");
    assert.deepEqual(await refs(b.o), before,
      "pushes nothing and keeps the placeholders");
  });

  it("7. finish force-pushes next and staging only, then deletes the "
    + "placeholders, and prints the lanes that must rebase", async () => {
    const t = await world();

    ok(await run(t, "start"));
    await land(t, ...PLAIN);
    const before = await refs(t.o);
    const r = await run(t, "finish");

    ok(r);

    const now = await refs(t.o);

    assert.deepEqual(changedRefs(before, now), [
      "refs/heads/hotfix/next", "refs/heads/hotfix/staging",
      "refs/heads/next", "refs/heads/staging",
    ], "no other ref on origin moved, appeared or went");
    assert.equal(now["refs/heads/hotfix/next"], undefined,
      "the placeholder for next is gone");
    assert.equal(now["refs/heads/hotfix/staging"], undefined,
      "the placeholder for staging is gone");

    const at = (ref) => r.pushes.findLastIndex((p) => p.ref === ref);
    const pushed = Math.max(at("refs/heads/next"),
      at("refs/heads/staging"));
    const deleted = r.pushes.map((p, i) => [p, i])
      .filter(([p]) => p.now === ZERO).map(([, i]) => i);

    assert.ok(at("refs/heads/next") >= 0 && at("refs/heads/staging") >= 0,
      "next and staging were pushed");
    assert.equal(deleted.length, 2, "both placeholders were deleted");
    assert.ok(deleted.every((i) => i > pushed),
      "the placeholders go only after next and staging are pushed");

    assert.match(r.text, /lane\/alpha/,
      "names the lane cut from the old next");
    assert.doesNotMatch(r.text, /lane\/beta/,
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
  });

  it("9. neither command can move main, and neither pushes with force to "
    + "any branch but next and staging", async () => {
    const t = await world();
    const started = await run(t, "start");

    ok(started);
    await land(t, {}, "Hotfix the b line", { pick: t.c.N1 });
    const finished = await run(t, "finish");

    ok(finished);

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
    + "to main alone around their pushes to next and staging, restore it "
    + "even when a push fails, and read it back against the saved copy",
  async () => {
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
    windowHeld(finished, "finish");
    neverOpens(t.events);

    // A push that fails part-way still gets the ruleset restored.
    for (const action of ["start", "finish"]) {
      const f = await world();

      if (action === "finish") {
        ok(await run(f, "start"));
        await land(f, ...PLAIN);
      }
      f.failPush = (args) => pushTargets(args)
        .some((x) => x.dst === "staging" && !x.delete);

      const r = await run(f, action);
      const writes = r.events.filter((e) => e.kind === "write");
      const failed = r.events.indexOf(branchPushes(r.events).at(-1));

      assert.ok(r.error, `${action} fails with its push`);
      assert.ok(failed >= 0, `${action} tried to push staging`);
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
    const r = await run(t, "finish");

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
