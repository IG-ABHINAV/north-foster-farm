// The implementer's own tests of round 4 of bin/hotfix.mjs (the second
// security review of #631, 2026-11-18): its B and the should-fixes the
// review left to the implementer, beside the criteria tests, which they
// never replace. They use the criteria tests' harness,
// test/hotfix-world.mjs, unchanged.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  compare, createdRefs, realDeps, tidy,
} from "../bin/hotfix.mjs";
import {
  CONFLICT, F, guards, land, ok, pushTargets, refs, refused, run, world,
} from "./hotfix-world.mjs";

const moves = (args) => args[0] === "push" && pushTargets(args)
  .some((x) => !x.delete && ["next", "staging"].includes(x.dst));

// Signal handlers the test fires itself, and the exit they would make.
const fakeSignals = (t) => {
  const s = { handlers: new Map(), exited: undefined };

  s.done = new Promise((resolve) => {
    t.deps.signals = {
      on: (name, handler) => s.handlers.set(name, handler),
      off: (name) => s.handlers.delete(name),
      exit: (code) => {
        s.exited = code;
        resolve();
      },
    };
  });
  t.deps.sleep = async () => {};

  return s;
};

describe("bin/hotfix.mjs, round 4: the implementer's own", () => {
  it("reads git push --porcelain: only * is a ref the push created", () => {
    const out = [
      "To /tmp/origin.git",
      "*\tabc:refs/heads/hotfix/next\t[new branch]",
      "=\tdef:refs/heads/hotfix/staging\t[up to date]",
      "Done",
    ].join("\n");

    assert.deepEqual([...createdRefs(out)], ["refs/heads/hotfix/next"]);
    assert.deepEqual([...createdRefs("")], []);
  });

  it("a start that overlaps another refuses at the placeholder push and "
    + "deletes nothing the other made", async () => {
    const t = await world();
    let other;

    // Another start pushes the same placeholders while this one waits at
    // its question, after both fetched.
    t.deps.confirm = async () => {
      const r = await refs(t.o);

      await t.l(["push", "-q", "origin",
        `${r["refs/heads/next"]}:refs/heads/hotfix/next`,
        `${r["refs/heads/staging"]}:refs/heads/hotfix/staging`]);
      other = await refs(t.o);

      return true;
    };

    const r = await run(t, "start");

    refused(r);
    assert.match(r.error.message, /another hotfix start ran/);
    assert.deepEqual(await refs(t.o), other,
      "the other run's placeholders stay, and next and staging did not move");
    assert.deepEqual(t.gh.writes(), [], "no ruleset write");
  });

  it("a signal during the narrowing stops the push from starting, and "
    + "its message says so and points to --dry-run", async () => {
    const t = await world();
    const s = fakeSignals(t);
    const api = t.deps.api;
    const before = await refs(t.o);

    t.deps.api = async (path, options = {}) => {
      const got = await api(path, options);

      if (options.method === "PUT" && options.body.conditions.ref_name
        .include.length === 1) s.handlers.get("SIGTERM")();

      return got;
    };

    const r = await run(t, "start");

    await s.done;
    assert.equal(s.exited, 143);
    assert.ok(!r.gitCalls.some(moves), "next and staging were never pushed");
    assert.equal((await refs(t.o))["refs/heads/next"],
      before["refs/heads/next"]);
    assert.deepEqual(guards(t.gh.state()), guards(F.ruleset), "restored");
    assert.match(r.text, /Stopped by SIGTERM before the push, so nothing was /);
    assert.match(r.text, /bin\/nff hotfix start --dry-run/);
  });

  it("a signal while the push runs says the push may have gone through",
    async () => {
      const t = await world();
      const s = fakeSignals(t);
      const git = t.deps.git;

      t.deps.git = async (args) => {
        if (!moves(args)) return git(args);
        s.handlers.get("SIGINT")();
        await s.done;
        throw new Error("killed");
      };

      const r = await run(t, "start");

      assert.equal(s.exited, 130);
      assert.match(r.text,
        /Stopped by SIGINT while the push ran, so it may have gone through/);
    });

  it("keeps -z output whole, so a path with a leading space is not read "
    + "as its twin", async () => {
    assert.equal(tidy(["diff-tree", "-z"], " foo\0foo\0"), " foo\0foo\0");
    assert.equal(tidy(["log"], "x y \n\n"), "x y");

    const dir = mkdtempSync(join(tmpdir(), "hotfix-own4-"));
    const g = (...args) => execFileSync("git", ["-C", dir, "-c",
      "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" }).trim();
    const put = (files, subject) => {
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
      }
      g("add", "-A");
      g("commit", "-q", "-m", subject);

      return g("rev-parse", "HEAD");
    };

    try {
      g("init", "-q", "-b", "main");
      const oldMain = put({ " foo": "1\n", foo: "1\n" }, "Old main");
      const main = put({ " foo": "2\n" }, "Hotfix the spaced twin");

      g("checkout", "-q", "-b", "placeholder", oldMain);
      const hn = put({ foo: "2\n" }, "Change foo");
      // A wrong rebuild: main, with foo's change lost.
      const found = await compare(
        (args) => realDeps.git(["-C", dir, ...args]),
        { oldMain, main, hs: oldMain, staging: main, hn, next: main });

      assert.deepEqual(found.refused.map((x) => [x.branch, x.path]),
        [["next", "foo"]], "foo's lost change is refused");
      assert.deepEqual(found.confirm, [], "and nothing is put to a question");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run before a rebuild names the conflict it will stop on, "
    + "and during one says the result waits on the resolution", async () => {
    const t = await world();

    ok(await run(t, "start"));
    await land(t, ...CONFLICT);
    const before = await refs(t.o);
    const ahead = await run(t, "finish", { dryRun: true });

    ok(ahead);
    assert.match(ahead.text,
      /stop on a conflict: \w{7} Reword two, in a\.txt/);
    assert.deepEqual(await refs(t.o), before);

    assert.ok((await run(t, "finish")).error, "the rebuild stops");
    const during = await run(t, "finish", { dryRun: true });

    ok(during);
    assert.match(during.text, /not known yet: the conflict in progress is /);
  });
});
