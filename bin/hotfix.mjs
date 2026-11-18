/* eslint-disable camelcase -- GitHub names its fields its way */
// `bin/nff hotfix start|finish` (#612): a hotfix while `staging` holds
// work that is not fit to release, so that the commit reaching `main`
// is the one that was tested, never a copy of it.
//
// `start` keeps the heads of `next` and `staging` as the placeholder
// branches `hotfix/next` and `hotfix/staging`, and puts `next` and
// `staging` back at `main`'s commit. The hotfix then lands on `next`
// and is promoted to `staging` and `main` by the ordinary means; this
// module never lands or promotes it, and never pushes `main`.
//
// `finish` takes two runs, since ruleset 25361919 lets `staging` take
// only a commit on which lint-and-test, supply-chain and codeql passed,
// and those run only on a push to `next`, `staging` or `main`. Required
// checks are never relaxed (coordinator, 2026-11-18). Step 1 rebuilds
// the placeholders on the new `main` in the checkout, checks that the
// rebuilt branches hold every change the placeholders did, force-pushes
// `next` to the rebuilt staging and pushes the rebuilt next as
// `hotfix/rebuilt`. Step 2, once the checks on `next` are green,
// fast-forwards `staging` to that commit and `next` to `hotfix/rebuilt`,
// deletes the hotfix branches and names the lanes that must rebase. So
// `staging` takes only what a push to `next` proved (#580).
//
// `start` and step 1 push `next` (and `start` `staging`) to commits that
// are not fast-forwards, which ruleset 25361439 ("no force-push or
// deletion") forbids. Each opens the same window (coordinator,
// 2026-11-18): it saves the ruleset, narrows it to `main` alone, pushes,
// restores the saved copy in a finally and reads it back. A read-back
// that differs is an error naming the ruleset. No write drops `main` or
// either rule, or adds a bypass actor. Step 2's pushes are fast-forwards
// and open no window. The "linear history" ruleset (25898866) is never
// written: a rebuilt branch holds no merge commit.
//
// The test of this contract is test/hotfix.test.mjs. Every git command
// goes through `deps.git` and every GitHub call through `deps.api`, so
// the tests run real git against throwaway repositories.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { ghApi, printable } from "./e2e/dispatch.mjs";
import { REPO } from "./promote.mjs";

const execute = promisify(execFile);

export const RULESET = 25361439;
export const RULESET_PATH = `repos/${REPO}/rulesets/${RULESET}`;
export const PLACEHOLDER = { next: "hotfix/next", staging: "hotfix/staging" };
// Where step 1 of `finish` keeps the rebuilt next until step 2.
export const REBUILT = "hotfix/rebuilt";
// The checks ruleset 25361919 requires before `staging` takes a commit.
export const REQUIRED = ["lint-and-test", "supply-chain", "codeql"];
export const checksPath = (sha) => `repos/${REPO}/commits/${sha}/check-runs`;

// The local branches `finish` rebuilds on, and the setting that
// remembers where the checkout was before it began.
export const REBUILD = {
  next: "hotfix-rebuild/next", staging: "hotfix-rebuild/staging",
};
const FROM_KEY = "nff-hotfix.from";

export const USAGE = `
  bin/nff hotfix start [--yes] [--dry-run]
                                      when staging holds work not fit to
                                      release: keep next and staging as
                                      hotfix/next and hotfix/staging and
                                      put both at main's commit, so the
                                      hotfix rides next, staging and
                                      main alone. Asks first, since the
                                      staging site then shows
                                      production's content; --yes skips
                                      the question. Landings on next are
                                      frozen until the second hotfix
                                      finish
  bin/nff hotfix finish [--dry-run]   two runs. First, once main holds
                                      the hotfix and next, staging and
                                      main are one commit: rebuild the
                                      placeholders on main in this
                                      checkout, check no change of
                                      theirs was lost, force-push next
                                      to the rebuilt staging and keep
                                      the rebuilt next as
                                      hotfix/rebuilt. On a conflict it
                                      stops: fix the files, git add
                                      them and run it again. Second,
                                      once lint-and-test, supply-chain
                                      and codeql are green on next:
                                      move staging to that commit and
                                      next to hotfix/rebuilt, delete
                                      the hotfix branches and name the
                                      lanes that must rebase. --dry-run
                                      prints the plan and changes
                                      nothing`
  .slice(1);

const realGit = async (args) => {
  try {
    return (await execute("git", args, { maxBuffer: 64 * 1024 * 1024 }))
      .stdout.trim();
  } catch (error) {
    throw Object.assign(new Error(`git ${args.join(" ")}: ${
      String(error.stderr || error.message).trim()}`), {
      stdout: error.stdout, stderr: error.stderr,
    });
  }
};

const realConfirm = async (question) => {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};

export const realDeps = { git: realGit, api: ghApi, confirm: realConfirm };

const short = (sha) => printable(String(sha).slice(0, 7));
// "a", "a and b", "a, b and c".
export const listed = (names) => (names.length > 1
  ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "");
const on = (value) => !!value && value !== "false";

// What a failed git command said, fit for the terminal.
const said = (error) => printable(String(error?.stderr || error?.message
  || error).trim().split("\n").filter(Boolean).at(-1) ?? "");

const tryGit = async (git, args) => {
  try {
    return await git(args);
  } catch {
    return undefined;
  }
};

const isAncestor = async (git, a, b) =>
  (await tryGit(git, ["merge-base", "--is-ancestor", a, b])) !== undefined;

// The branches on origin, by name, from the remote-tracking refs a fetch
// with --prune has just made exact.
const originHeads = async (git) => Object.fromEntries((await git([
  "for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin/",
])).split("\n").filter(Boolean).map((line) => {
  const [sha, ref] = line.split(" ");

  return [ref.replace(/^refs\/remotes\/origin\//, ""), sha];
}).filter(([name]) => name !== "HEAD"));

const fetchHeads = async (git) => {
  await git(["fetch", "--prune", "--quiet", "origin"]);

  return originHeads(git);
};

const dirty = async (git) => (await git(["status", "--porcelain"])) !== "";

const subjectOf = async (git, sha) =>
  printable(await git(["log", "-1", "--format=%s", sha]));

// The force-push window. `push()` runs while ruleset 25361439 covers
// `main` alone; the saved copy goes back after it whatever happens and
// is read back. -> { pushError, rulesetError }, neither thrown here.

// The parts of a ruleset that say what it protects, and all a PUT
// sends.
const guards = (r) => ({
  name: r.name, target: r.target, enforcement: r.enforcement,
  conditions: r.conditions, rules: r.rules, bypass_actors: r.bypass_actors,
});

const ruleTypes = (r) => (r.rules ?? []).map((rule) => rule.type);

export const narrowed = (saved) => {
  const body = structuredClone(guards(saved));

  body.conditions = {
    ...body.conditions,
    ref_name: { ...body.conditions.ref_name, include: ["refs/heads/main"] },
  };

  return body;
};

// The fields of two rulesets' guards that differ, each named with both
// values.
export const differences = (saved, back) => Object.keys(guards(saved))
  .filter((key) => JSON.stringify(guards(saved)[key])
    !== JSON.stringify(guards(back)[key]))
  .map((key) => `${key} saved ${JSON.stringify(guards(saved)[key])}, `
    + `read back ${JSON.stringify(guards(back)[key])}`);

const window = async (api, push) => {
  const saved = await api(RULESET_PATH);
  const include = saved?.conditions?.ref_name?.include ?? [];

  if (!include.includes("refs/heads/main")
    || !ruleTypes(saved).includes("non_fast_forward")
    || !ruleTypes(saved).includes("deletion")) {
    throw new Error(`Refused: ruleset ${RULESET} does not cover main with `
      + "its no force-push and no deletion rules, so it is not the one "
      + "this command knows how to narrow. Nothing is pushed.");
  }

  let pushError;
  let rulesetError;

  try {
    await api(RULESET_PATH, { method: "PUT", body: narrowed(saved) });
    await push();
  } catch (error) {
    pushError = error;
  } finally {
    try {
      await api(RULESET_PATH, { method: "PUT", body: guards(saved) });

      const diff = differences(saved, await api(RULESET_PATH));

      if (diff.length) {
        rulesetError = new Error(`Ruleset ${RULESET} does not match the `
          + `copy saved before the push: ${printable(diff.join("; "))}. `
          + `Put it back by hand: gh api -X PUT ${RULESET_PATH} --input `
          + `with ${printable(JSON.stringify(guards(saved)))}`);
      }
    } catch (error) {
      rulesetError = new Error(`Ruleset ${RULESET} was not restored after `
        + `the push: ${printable(error.message)}. Put it back by hand: `
        + `gh api -X PUT ${RULESET_PATH} --input with `
        + `${printable(JSON.stringify(guards(saved)))}`);
    }
  }

  return { pushError, rulesetError };
};

const raise = ({ pushError, rulesetError }) => {
  if (rulesetError) {
    if (pushError) {
      rulesetError.message += ` The push failed too: ${said(pushError)}`;
    }
    throw rulesetError;
  }
  if (pushError) {
    throw new Error(`The push failed and ruleset ${RULESET} is restored: ${
      said(pushError)}`, { cause: pushError });
  }
};

// Moves `next` and `staging` from where they were (`was`) to the
// commits in `to`, both or neither.
const forcePush = (git, was, to) => git(["push", "--atomic",
  `--force-with-lease=refs/heads/next:${was.next}`,
  `--force-with-lease=refs/heads/staging:${was.staging}`,
  "origin", `${to.next}:refs/heads/next`, `${to.staging}:refs/heads/staging`]);

// The lanes holding a commit of the old `next` (`oldNext`) that `main`
// lacked at start (`oldMain`), sorted.
const lanesToRebase = async (git, heads, oldNext, oldMain) => {
  const lanes = [];

  for (const name of Object.keys(heads).filter((n) => n.startsWith("lane/"))
    .sort()) {
    const bases = (await tryGit(git,
      ["merge-base", "--all", heads[name], oldNext]))?.split("\n")
      .filter(Boolean) ?? [];

    for (const base of bases) {
      if (!await isAncestor(git, base, oldMain)) {
        lanes.push(name);
        break;
      }
    }
  }

  return lanes;
};

const QUESTION = (main) => `The staging site will show production's `
  + `content (main at ${short(main)}) from now until the second \`bin/nff `
  + "hotfix finish`. Start the hotfix?";

const start = async ({ dryRun, yes, out }, { git, api, confirm }) => {
  const heads = await fetchHeads(git);
  const { main, next, staging } = heads;

  for (const name of ["main", "next", "staging"]) {
    if (!heads[name]) throw new Error(`Refused: origin has no ${name}.`);
  }

  const busy = Object.keys(heads).filter((n) => n.startsWith("hotfix/"));

  if (busy.length) {
    throw new Error(`Refused: a hotfix is already in progress (origin has ${
      busy.map(printable).join(", ")}). Finish it first: bin/nff hotfix `
      + "finish. Nothing changed.");
  }
  for (const name of ["next", "staging"]) {
    if (!await isAncestor(git, main, heads[name])) {
      throw new Error(`Refused: ${name} (${short(heads[name])}) does not `
        + `contain main (${short(main)}). Bring main's commits into ${name} `
        + "first. Nothing changed.");
    }
  }
  if (!await isAncestor(git, staging, next)) {
    throw new Error(`Refused: staging (${short(staging)}) is not part of `
      + `next (${short(next)}), so the two cannot be rebuilt as one line. `
      + "Nothing changed.");
  }
  if (next === main) {
    throw new Error(`Refused: next and staging are already at main `
      + `(${short(main)}). Land the hotfix by the ordinary path; it needs `
      + "no hotfix start. Nothing changed.");
  }
  if (await dirty(git)) {
    throw new Error("Refused: the working tree has uncommitted changes. "
      + "Commit or put them aside, then start again. Nothing changed.");
  }

  const plan = [
    `  keep next (${short(next)}) as ${PLACEHOLDER.next} and staging `
      + `(${short(staging)}) as ${PLACEHOLDER.staging}`,
    `  narrow ruleset ${RULESET} to main, force-push next and staging to `
      + `main's commit ${short(main)}, restore the ruleset and read it back`,
  ];

  if (dryRun) {
    out("--dry-run: nothing is changed. hotfix start would:");
    for (const line of plan) out(line);
    out(`  ask first: ${QUESTION(main)}`);

    return undefined;
  }
  if (!yes && !await confirm(QUESTION(main))) {
    throw new Error("Refused: not confirmed. Nothing changed. Run it "
      + "again and answer yes, or pass --yes.");
  }

  await git(["push", "--atomic", "origin",
    `${next}:refs/heads/${PLACEHOLDER.next}`,
    `${staging}:refs/heads/${PLACEHOLDER.staging}`]);
  out(`Kept next (${short(next)}) as ${PLACEHOLDER.next} and staging `
    + `(${short(staging)}) as ${PLACEHOLDER.staging}.`);

  const result = await window(api,
    () => forcePush(git, { next, staging }, { next: main, staging: main }));

  if (result.pushError) {
    // Nothing moved, so the placeholders would only block a new start.
    await tryGit(git, ["push", "--atomic", "origin", "--delete",
      `refs/heads/${PLACEHOLDER.next}`, `refs/heads/${PLACEHOLDER.staging}`]);
    out(`Deleted ${PLACEHOLDER.next} and ${PLACEHOLDER.staging} again, `
      + "since next and staging did not move.");
  } else {
    out(`next and staging are now at main's commit ${short(main)}, inside `
      + `the window: ruleset ${RULESET} was narrowed to main for the push `
      + "and restored after.");
  }
  raise(result);

  for (const line of [
    "The staging site shows production's content until the second hotfix "
      + "finish.",
    "Landings on next are frozen until then, but for the hotfix.",
    "What to do next:",
    "  1. Land the hotfix on next by its pull request.",
    "  2. bin/nff promote staging, then bin/nff promote main, with the "
      + "usual checks.",
    "  3. bin/nff hotfix finish, which rebuilds the placeholders and puts "
      + "next at the rebuilt staging.",
    "  4. Once the checks on next are green, bin/nff hotfix finish again, "
      + "which moves staging and next on.",
  ]) out(line);

  return undefined;
};

// --- finish

// Where a rebase in this checkout stands: undefined, or { head, onto }
// with the branch it rebuilds.
const rebaseState = async (git) => {
  const dir = await git(["rev-parse", "--absolute-git-dir"]);

  for (const name of ["rebase-merge", "rebase-apply"]) {
    const path = join(dir, name);

    if (existsSync(path)) {
      const read = (file) => (existsSync(join(path, file))
        ? readFileSync(join(path, file), "utf8").trim() : "");

      return {
        head: read("head-name").replace(/^refs\/heads\//, ""),
        onto: read("onto"),
      };
    }
  }

  return undefined;
};

// A rebase that may stop. Throws, naming the commit and the files, when
// it stops on a conflict.
const REBASE = ["-c", "core.editor=true", "-c", "rebase.updateRefs=false",
  "-c", "rebase.autoSquash=false", "-c", "rebase.autoStash=false"];

const stopped = async (git) => {
  const sha = await tryGit(git, ["rev-parse", "--verify", "-q",
    "REBASE_HEAD"]);
  const files = (await git(["diff", "--name-only", "--diff-filter=U", "-z"]))
    .split("\0").filter(Boolean).map(printable);
  const what = sha ? `${short(sha)} ${await subjectOf(git, sha)}` : "a commit";

  return new Error(`Stopped on a conflict: ${what}, in ${files.length
    ? files.join(", ") : "files git has not named"}. Nothing is pushed and `
    + "the placeholders stay. Fix those files, git add them and run "
    + "bin/nff hotfix finish again; git rebase --abort gives up the "
    + "rebuild.");
};

const rebase = async (git, args) => {
  try {
    await git([...REBASE, "rebase", ...args]);
  } catch (error) {
    if (await rebaseState(git)) throw await stopped(git);
    throw new Error(`The rebuild failed: ${said(error)}`, { cause: error });
  }
};

const REBASE_FLAGS = ["--no-rebase-merges", "--empty=drop", "--quiet"];

// The lines of a diff each file gains, by the file's path.
// A path git quoted C-style ("caf\303\251.txt"): its escapes are the
// bytes of UTF-8.
const ESCAPES = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92,
};

const unquote = (path) => {
  if (!path.startsWith("\"")) return path;

  const body = path.slice(1, -1);
  const bytes = [];

  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]));
    } else if (/[0-7]/.test(body[i + 1])) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }

  return Buffer.from(bytes).toString("utf8");
};

export const addedLines = (diff) => {
  const files = new Map();
  let file;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = undefined;
    } else if (line.startsWith("+++ ")) {
      const path = line.slice(4);

      file = path === "/dev/null" ? undefined : unquote(path).slice(2);
      if (file && !files.has(file)) files.set(file, { lines: [] });
    } else if (line.startsWith("Binary files ")) {
      const m = line.match(/ and (.+) differ$/);

      if (m && m[1] !== "/dev/null") {
        file = unquote(m[1]).slice(2);
        files.set(file, { lines: [], binary: true });
      }
    } else if (file && line.startsWith("+")) {
      files.get(file).lines.push(line.slice(1));
    }
  }

  return files;
};

// A file's lines at a commit, each trimmed, or null when it has none.
const lineSet = async (git, cache, rev, path) => {
  const key = `${rev}:${path}`;

  if (!cache.has(key)) {
    const text = await tryGit(git, ["show", "--no-textconv", key]);

    cache.set(key, text === undefined
      ? null : new Set(text.split("\n").map((l) => l.trim())));
  }

  return cache.get(key);
};

const FORMAT = "--format=%H%x1f%P%x1f%ae%x1f%ad%x1f%s";

const commitsIn = async (git, range) => (await git(["log", "--reverse",
  "--date=raw", FORMAT, range])).split("\n").filter(Boolean).map((line) => {
  const [sha, parents, email, date, subject] = line.split("\x1f");

  return {
    sha, parents: parents.split(" ").filter(Boolean), subject,
    key: `${email}\x1f${date}\x1f${subject}`,
  };
});

// What the rebuilt branches lost of the placeholders, and what git
// dropped. `p` holds the placeholders' and the rebuilt branches' heads,
// old main and main now. -> { missing, dropped, flattened }.
export const audit = async (git, p) => {
  const commits = await commitsIn(git, `${p.oldMain}..${p.hn}`);
  const onStaging = new Set((await git(["rev-list",
    `${p.oldMain}..${p.hs}`])).split("\n").filter(Boolean));
  const copies = new Set((await git(["log", "--right-only", "--cherry-mark",
    "--no-merges", "--format=%m %H", `${p.main}...${p.hn}`]))
    .split("\n").filter((l) => l.startsWith("= ")).map((l) => l.slice(2)));
  const rebuilt = new Set((await commitsIn(git, `${p.main}..${p.next}`))
    .map((c) => c.key));
  const cache = new Map();
  const missing = [];
  const dropped = [];
  const flattened = [];

  for (const c of commits) {
    const subject = printable(c.subject);

    if (c.parents.length > 1) {
      flattened.push(`${short(c.sha)} ${subject}`);
    } else if (copies.has(c.sha)) {
      dropped.push(`${short(c.sha)} ${subject}`);
      continue;
    }

    const staged = onStaging.has(c.sha);
    const head = staged ? p.hs : p.hn;
    const now = staged ? p.staging : p.next;
    const files = addedLines(await git(["diff", "--no-color", "--no-ext-diff",
      "--no-textconv", "--no-renames", "-U0", c.parents[0], c.sha]));
    const lost = [];

    for (const [path, change] of files) {
      const kept = await lineSet(git, cache, head, path);
      const there = await lineSet(git, cache, now, path);

      if (!kept) continue;
      if (!there) {
        lost.push(`${printable(path)} is gone`);
        continue;
      }
      if (change.binary) continue;
      for (const line of change.lines) {
        const text = line.trim();

        if (text && kept.has(text) && !there.has(text)) {
          lost.push(`${printable(path)}: ${JSON.stringify(printable(text))}`);
        }
      }
    }
    if (lost.length) {
      missing.push({ commit: `${short(c.sha)} ${subject}`, lost,
        branch: staged ? "staging" : "next" });
    } else if (c.parents.length === 1 && !rebuilt.has(c.key)) {
      dropped.push(`${short(c.sha)} ${subject}`);
    }
  }

  return { missing, dropped, flattened };
};

// Where the checkout was before finish began, kept until it is done.
const remember = async (git) => {
  if (await tryGit(git, ["config", "--local", "--get", FROM_KEY])) return;

  const branch = await tryGit(git, ["symbolic-ref", "-q", "HEAD"]);

  await git(["config", "--local", FROM_KEY,
    branch ?? await git(["rev-parse", "HEAD"])]);
};

const putBack = async (git) => {
  const from = await tryGit(git, ["config", "--local", "--get", FROM_KEY]);

  if (from?.startsWith("refs/heads/")) {
    await git(["checkout", "-q", from.slice("refs/heads/".length)]);
  } else if (from) {
    await git(["checkout", "-q", "--detach", from]);
  }
  for (const branch of Object.values(REBUILD)) {
    await tryGit(git, ["branch", "-D", branch]);
  }
  await tryGit(git, ["config", "--local", "--unset", FROM_KEY]);
};

// Step 1 of `finish`: rebuild, check, then `next` to the rebuilt staging
// and the rebuilt next to `hotfix/rebuilt`.
const finishFirst = async ({ dryRun, out }, { git, api }, heads) => {
  const { main } = heads;
  const hn = heads[PLACEHOLDER.next];
  const hs = heads[PLACEHOLDER.staging];

  if (!hn || !hs) {
    throw new Error(`Refused: no hotfix is in progress: origin has no ${
      [hn ? "" : PLACEHOLDER.next, hs ? "" : PLACEHOLDER.staging]
        .filter(Boolean).join(" or ")}. Nothing changed.`);
  }

  const oldMain = await git(["merge-base", hn, main]);

  if (oldMain === main) {
    throw new Error(`Refused: main (${short(main)}) has not moved past `
      + "where hotfix start found it. Land and promote the hotfix first. "
      + "Nothing changed.");
  }
  for (const name of ["next", "staging"]) {
    if (heads[name] !== main) {
      throw new Error(`Refused: ${name} (${short(heads[name])}) is not `
        + `main's commit (${short(main)}). next, staging and main must be `
        + "one commit; finish the hotfix's promotion, and land nothing "
        + "else on next until finish. Nothing changed.");
    }
  }

  const lanes = await lanesToRebase(git, heads, hn, oldMain);
  const state = await rebaseState(git);

  if (state && !Object.values(REBUILD).includes(state.head)) {
    throw new Error(`Refused: a rebase of ${printable(state.head
      || "a detached HEAD")} is in progress in this checkout. Finish or `
      + "abort it first. Nothing changed.");
  }

  if (dryRun) {
    const commits = await commitsIn(git, `${oldMain}..${hn}`);
    const copies = (await git(["log", "--right-only", "--cherry-mark",
      "--no-merges", "--format=%m %h %s", `${main}...${hn}`])).split("\n")
      .filter((l) => l.startsWith("= ")).map((l) => printable(l.slice(2)));
    const merges = commits.filter((c) => c.parents.length > 1);
    const ownStaging = await git(["rev-list", "--count",
      `${oldMain}..${hs}`]);

    out("--dry-run: nothing is changed. hotfix finish would:");
    if (state) out(`  carry on with the rebuild of ${printable(state.head)}`);
    out(`  rebuild staging: the ${ownStaging} commit(s) of `
      + `${PLACEHOLDER.staging} onto main (${short(main)})`);
    out(`  rebuild next: the ${commits.length - Number(ownStaging)} `
      + `commit(s) ${PLACEHOLDER.next} adds onto the rebuilt staging`);
    for (const c of copies) out(`  drop, main already has it: ${c}`);
    for (const c of merges) {
      out(`  flatten the merge commit ${short(c.sha)} `
        + `${printable(c.subject)}`);
    }
    out("  refuse unless the rebuilt next and staging hold every line the "
      + "placeholders added");
    out(`  narrow ruleset ${RULESET} to main, force-push next to the `
      + `rebuilt staging and push the rebuilt next as ${REBUILT}, restore `
      + "the ruleset and read it back");
    out(`  leave staging at main (${short(main)}) and keep `
      + `${PLACEHOLDER.next} and ${PLACEHOLDER.staging}`);
    out(`  then, once the checks ${listed(REQUIRED)} are green on next, `
      + "a second bin/nff hotfix finish moves staging and next on");
    out(`  lanes to rebase after that: ${
      lanes.map(printable).join(", ") || "none"}`);

    return undefined;
  }

  if (state) {
    if (state.head === REBUILD.staging && state.onto && state.onto !== main) {
      throw new Error(`Refused: the rebuild in progress is onto `
        + `${short(state.onto)}, and main is now ${short(main)}. Run git `
        + "rebase --abort, then bin/nff hotfix finish again. Nothing is "
        + "pushed.");
    }
    await rebase(git, ["--continue"]);
  } else if (await dirty(git)) {
    throw new Error("Refused: the working tree has uncommitted changes. "
      + "Commit or put them aside, then finish again. Nothing changed.");
  }

  await remember(git);

  // The rebuilt staging: kept from an earlier run when it is built on
  // this main, else rebuilt.
  const ref = (name) => tryGit(git, ["rev-parse", "--verify", "-q",
    `refs/heads/${name}`]);
  let rs = await ref(REBUILD.staging);

  if (!rs || !await isAncestor(git, main, rs)) {
    await git(["checkout", "-q", "-B", REBUILD.staging, hs]);
    await rebase(git, [...REBASE_FLAGS, main]);
    rs = await ref(REBUILD.staging);
  }

  let rn = await ref(REBUILD.next);

  if (!rn || !await isAncestor(git, rs, rn)) {
    await git(["checkout", "-q", "-B", REBUILD.next, hn]);
    await rebase(git, [...REBASE_FLAGS, "--onto", rs, hs]);
    rn = await ref(REBUILD.next);
  }

  const merges = await git(["rev-list", "--merges", `${main}..${rn}`]);

  if (merges || !await isAncestor(git, rs, rn)
    || !await isAncestor(git, main, rs)) {
    await putBack(git);
    throw new Error("Refused: the rebuilt branches are not one straight "
      + "line from main through staging to next, so they would break the "
      + "linear history rule. Nothing is pushed; run it again.");
  }

  const found = await audit(git, {
    oldMain, main, hn, hs, next: rn, staging: rs,
  });

  for (const c of found.dropped) out(`Dropped, main already has it: ${c}`);
  for (const c of found.flattened) {
    out(`Flattened the merge commit ${c}: its commits are replayed one `
      + "by one.");
  }
  if (found.missing.length) {
    await putBack(git);
    throw new Error("Refused: the rebuilt branches lack changes the "
      + `placeholders made. ${found.missing.map((m) => `The rebuilt ${
        m.branch} lacks what ${m.commit} added: ${m.lost.join("; ")}.`)
        .join(" ")} Nothing is pushed and the placeholders stay. Run it `
      + "again and keep those lines when you resolve the conflict.");
  }

  // One atomic push: `next` to the rebuilt staging, forced and leased on
  // main, and the rebuilt next as a new branch, not forced. When the
  // rebuilt staging is main itself, `next` stays and no window is needed.
  const keep = `${rn}:refs/heads/${REBUILT}`;
  let result = {};

  if (rs === main) {
    try {
      await git(["push", "origin", keep]);
    } catch (error) {
      result = { pushError: error };
    }
  } else {
    result = await window(api, () => git(["push", "--atomic",
      `--force-with-lease=refs/heads/next:${main}`, "origin",
      `${rs}:refs/heads/next`, keep]));
  }

  if (!result.pushError) {
    out(`next is now ${short(rs)}, the rebuilt staging, and the rebuilt `
      + `next waits as ${REBUILT} (${short(rn)}), both on main `
      + `(${short(main)}).${rs === main ? "" : ` next was pushed inside `
        + `the window: ruleset ${RULESET} was narrowed to main for the `
        + "push and restored after."}`);
    await putBack(git);
  }
  raise(result);

  for (const line of [
    `staging follows, and stays at main (${short(main)}) until then: `
      + `once the checks ${listed(REQUIRED)} are green on next `
      + `(${short(rs)}), run bin/nff hotfix finish again.`,
    "Landings on next stay frozen until that second run: next holds only "
      + "the rebuilt staging, and staging takes exactly that commit.",
  ]) out(line);

  return undefined;
};

// The check runs of a commit, every page.
const checkRuns = async (api, sha) => {
  const runs = [];

  for (let page = 1; page <= 20; page += 1) {
    const got = await api(`${checksPath(sha)}?per_page=100&page=${page}`);
    const list = got?.check_runs ?? [];

    runs.push(...list);
    if (list.length < 100 || runs.length >= (got?.total_count ?? 0)) break;
  }

  return runs;
};

// The required checks with no completed run that succeeded. A skipped
// run of the same name neither passes nor fails one.
export const unproven = (runs) => REQUIRED.filter((name) => !runs.some(
  (run) => run.name === name && run.status === "completed"
    && run.conclusion === "success"));

// Step 2 of `finish`: once the checks on `next` are green, `staging` to
// that commit and `next` to `hotfix/rebuilt`, both fast-forwards; then
// the hotfix branches go.
const finishSecond = async ({ dryRun, out }, { git, api }, heads) => {
  const { main, next, staging } = heads;
  const rebuilt = heads[REBUILT];
  const hn = heads[PLACEHOLDER.next];

  if (!await isAncestor(git, next, rebuilt)) {
    throw new Error(`Refused: next (${short(next)}) is not part of `
      + `${REBUILT} (${short(rebuilt)}), so next has moved since the first `
      + "hotfix finish. Nothing changed.");
  }
  for (const [name, sha] of [["main", main], ["staging", staging]]) {
    if (!await isAncestor(git, sha, next)) {
      throw new Error(`Refused: ${name} (${short(sha)}) is not part of next `
        + `(${short(next)}), so staging cannot fast-forward to it. Nothing `
        + "changed.");
    }
  }

  const missing = unproven(await checkRuns(api, next));
  const lanes = hn
    ? await lanesToRebase(git, heads, hn, await git(["merge-base", hn, main]))
    : [];
  const branches = [PLACEHOLDER.next, PLACEHOLDER.staging, REBUILT]
    .filter((name) => heads[name]);

  if (dryRun) {
    out("--dry-run: nothing is changed. hotfix finish (second run) would:");
    if (missing.length) {
      out(`  refuse: ${listed(missing)} not yet green on next `
        + `(${short(next)})`);
    }
    out(`  move staging from ${short(staging)} to next's commit `
      + `${short(next)} and next to ${REBUILT} (${short(rebuilt)}), both `
      + "fast-forwards");
    out(`  delete ${branches.map(printable).join(", ")}`);
    out(`  lanes to rebase: ${lanes.map(printable).join(", ") || "none"}`);

    return undefined;
  }
  if (missing.length) {
    throw new Error(`Refused: ${listed(missing)} ${missing.length === 1
      ? "has" : "have"} not passed on next (${short(next)}), the commit `
      + "staging would take. Run bin/nff hotfix finish again once "
      + `${listed(REQUIRED)} are green there. Nothing changed.`);
  }

  await git(["push", "--atomic", "origin", `${next}:refs/heads/staging`,
    `${rebuilt}:refs/heads/next`]);
  out(`staging is now ${short(next)}, the commit next held, and next is `
    + `${short(rebuilt)}, the rebuilt next.`);
  await git(["push", "--atomic", "origin", "--delete",
    ...branches.map((name) => `refs/heads/${name}`)]);
  out(`Deleted ${branches.map(printable).join(", ")}.`);

  out("Landings on next are open again. CI runs on the rebuilt next.");
  if (lanes.length) {
    out(`Lanes that must rebase onto the new next (each: git rebase --onto `
      + `origin/next ${printable(hn.slice(0, 12))}):`);
    for (const lane of lanes) out(`  ${printable(lane)}`);
  } else {
    out("No lane holds a commit of the old next; none must rebase.");
  }

  return undefined;
};

const finish = async (options, deps) => {
  const heads = await fetchHeads(deps.git);

  return heads[REBUILT]
    ? finishSecond(options, deps, heads)
    : finishFirst(options, deps, heads);
};

export const hotfixCommand = (action, rest, { flags = {}, out }, deps = {}) => {
  const d = { ...realDeps, ...deps };

  if (rest.length) {
    throw new Error(`Refused: hotfix ${printable(action)} takes no `
      + "arguments.");
  }

  const options = { dryRun: on(flags["dry-run"]), yes: on(flags.yes), out };

  if (action === "start") return start(options, d);
  if (action === "finish") return finish(options, d);

  throw new Error("hotfix start or hotfix finish?");
};
