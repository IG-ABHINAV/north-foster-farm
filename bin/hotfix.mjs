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
// 2026-11-18): it refuses unless the ruleset covers exactly `next`,
// `staging` and `main`, writes the saved copy to a file in the git
// common directory, narrows the ruleset to `main` alone, pushes,
// restores the saved copy in a finally (three tries) and reads it back.
// SIGINT, SIGTERM and SIGHUP restore it too before the process exits.
// The file goes only once the read-back matches; a read-back that
// differs is an error naming the ruleset. Every run first refuses while
// that file is left or the live ruleset is narrowed, and never restores
// it by itself. No write drops `main` or either rule, or adds a bypass
// actor. Step 2's pushes are fast-forwards and open no window. The
// "linear history" ruleset (25898866) is never written: a rebuilt
// branch holds no merge commit.
//
// The tests of this contract are test/hotfix.test.mjs and
// test/hotfix-round3.test.mjs (the security review of #631). Every git
// command goes through `deps.git` and every GitHub call through
// `deps.api`, so the tests run real git against throwaway repositories.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The saved copy of the ruleset while the window is open, in the git
// common directory so every worktree of the checkout finds it.
export const LEFTOVER = `nff-hotfix-ruleset-${RULESET}.json`;
// What ruleset 25361439 covers when whole.
export const COVERED = ["next", "staging", "main"];
// The only flags the commands take.
export const FLAGS = ["dry-run", "yes"];
// The waits between the restore's three tries, in milliseconds.
export const BACKOFF = [1000, 2000];
// The signals that restore the ruleset before the process exits, with
// the exit code each leaves.
export const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

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
                                      checkout, check path by path that
                                      no change of theirs or of the
                                      hotfix was lost, ask about the
                                      paths both changed (even with
                                      --yes), force-push next
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
    throw Object.assign(new Error(printable(`git ${args.join(" ")}: ${
      String(error.stderr || error.message).trim()}`)), {
      stdout: error.stdout, stderr: error.stderr,
    });
  }
};

const realSignals = {
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
  exit: (code) => process.exit(code),
};

const realSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const realConfirm = async (question) => {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};

// `sleep` and `signals` are the implementer's own seams, for its tests
// of the restore's retries and the signal handlers.
export const realDeps = {
  git: realGit, api: ghApi, confirm: realConfirm, sleep: realSleep,
  signals: realSignals,
};

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

const included = (r) => r?.conditions?.ref_name?.include ?? [];
const branchName = (ref) => printable(String(ref)
  .replace(/^refs\/heads\//, ""));

// The branches a ruleset covers, as a sentence: "main", "next, staging
// and main", or "nothing".
const covers = (r) => listed(included(r).map(branchName)) || "nothing";

// Whether a ruleset is the whole 25361439: exactly next, staging and
// main, with both rules. -> undefined, or why it is not.
export const notWhole = (r) => {
  const include = included(r);
  const want = COVERED.map((name) => `refs/heads/${name}`);

  if (include.length !== want.length
    || !want.every((ref) => include.includes(ref))) {
    return `it covers ${covers(r)}, not exactly ${listed(COVERED)}`;
  }
  if (!ruleTypes(r).includes("non_fast_forward")
    || !ruleTypes(r).includes("deletion")) {
    return "it lacks its no force-push or no deletion rule";
  }

  return undefined;
};

// Narrowed, as a window leaves it: next or staging gone from include.
const isNarrowed = (r) => !included(r).includes("refs/heads/next")
  || !included(r).includes("refs/heads/staging");

export const leftoverPath = async (git) => join(await git(["rev-parse",
  "--path-format=absolute", "--git-common-dir"]), LEFTOVER);

// The command that puts the saved copy back, runnable as printed: the
// path is quoted for the shell when it needs to be.
export const restoreCommand = (file) => {
  const path = printable(file);
  const quoted = /^[\w@%+=:,./-]+$/.test(path)
    ? path : `'${path.replaceAll("'", "'\\''")}'`;

  return `gh api -X PUT ${RULESET_PATH} --input ${quoted}`;
};

// How to put the saved copy back by hand, as a sentence.
const howToRestore = (file) => `Restore it with \`${restoreCommand(file)}\`, `
  + `check that \`gh api ${RULESET_PATH}\` reads back the same, then `
  + "delete the file.";

const tryApi = async (api, path) => {
  try {
    return await api(path);
  } catch {
    return undefined;
  }
};

// Every run's first check (round 3, B and A): no saved copy left by a
// run stopped inside the window, and the live ruleset whole. Refuses
// before anything is pushed, written or rebuilt, and never restores by
// itself. -> the saved copy's path.
const preflight = async ({ git, api }) => {
  const file = await leftoverPath(git);
  const left = existsSync(file);
  const live = left
    ? await tryApi(api, RULESET_PATH) : await api(RULESET_PATH);
  const where = `the saved copy is in ${printable(file)}`;

  if (left && !live) {
    throw new Error("Refused: a run stopped inside the force-push window "
      + `left ${where}, and ruleset ${RULESET} could not be read to see `
      + `whether it is restored. If \`gh api ${RULESET_PATH}\` shows it `
      + `covers ${listed(COVERED)}, there is nothing to restore: delete `
      + `the file. If not: ${howToRestore(file)} Nothing changed.`);
  }
  if (left && !notWhole(live)) {
    throw new Error("Refused: a run stopped inside the force-push window "
      + `left ${where}, but ruleset ${RULESET} is whole: it covers `
      + `${listed(COVERED)}, so there is nothing to restore. Deleting the `
      + "file is the only step. Nothing changed.");
  }
  if (left) {
    throw new Error(`Refused: ruleset ${RULESET} is not as saved (${
      notWhole(live)}), and a run stopped inside the force-push window `
      + `left ${where}. ${howToRestore(file)} Nothing changed.`);
  }
  if (isNarrowed(live)) {
    throw new Error(`Refused: ruleset ${RULESET} covers only ${
      covers(live)}, so next and staging are open to force-pushes and `
      + "deletion, as a run stopped inside the force-push window leaves "
      + "it. No saved copy is in this checkout, so that run was elsewhere: "
      + "restore it from there, or in GitHub (Settings, Rules, Rulesets) "
      + `so it covers ${listed(COVERED)}, then run this again. Nothing `
      + "changed.");
  }

  const why = notWhole(live);

  if (why) {
    throw new Error(`Refused: ruleset ${RULESET} is not the one this `
      + `command knows how to narrow: ${why}. Nothing changed.`);
  }

  return file;
};

// Puts the saved copy back: three tries, each read back, the file
// deleted once one matches. -> undefined, or the Error to raise.
const restoreSaved = async ({ api, sleep }, body, file) => {
  let last;

  for (let attempt = 0; attempt <= BACKOFF.length; attempt += 1) {
    if (attempt) await sleep(BACKOFF[attempt - 1]);
    try {
      await api(RULESET_PATH, { method: "PUT", body });

      const diff = differences(body, await api(RULESET_PATH));

      if (!diff.length) {
        rmSync(file, { force: true });

        return undefined;
      }
      last = `it reads back different: ${diff.join("; ")}`;
    } catch (error) {
      last = error.message;
    }
  }

  return new Error(`Ruleset ${RULESET} was not restored after `
    + `${BACKOFF.length + 1} tries (${printable(last)}), so next and `
    + `staging may be open to force-pushes. The saved copy is in `
    + `${printable(file)}. ${howToRestore(file)}`);
};

// The force-push window. `push()` runs while ruleset 25361439 covers
// `main` alone; the saved copy is written to `file` first, goes back
// after the push whatever happens, on a signal too, and is read back.
// Throws only before it narrows anything (the ruleset not whole, the
// file already there). -> { pushError, rulesetError }.
const window = async (deps, file, push) => {
  const { api, signals, out } = deps;
  const saved = await api(RULESET_PATH);
  const why = notWhole(saved);

  if (why) {
    throw new Error(`Refused: ruleset ${RULESET} is not the one this command `
      + `knows how to narrow: ${why}. Nothing is pushed.`);
  }

  const body = guards(saved);

  // "wx": a second run at once finds the file and stops here.
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });

  let restoring;
  const restore = () => {
    restoring ??= restoreSaved(deps, body, file);

    return restoring;
  };
  const handlers = Object.entries(SIGNALS).map(([signal, code]) => {
    const handler = () => {
      restore().then((error) => {
        out(error ? printable(error.message) : `Stopped by ${signal}: `
          + `ruleset ${RULESET} is restored and read back.`);
      }).finally(() => signals.exit(code));
    };

    signals.on(signal, handler);

    return [signal, handler];
  });
  let pushError;
  let rulesetError;

  try {
    await api(RULESET_PATH, { method: "PUT", body: narrowed(saved) });
    await push();
  } catch (error) {
    pushError = error;
  } finally {
    rulesetError = await restore();
    for (const [signal, handler] of handlers) signals.off(signal, handler);
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

// Deletes the placeholders, leased on the heads they were pushed at, so
// a branch someone moved since is never deleted.
const dropPlaceholders = async ({ git, out }, was) => {
  try {
    await git(["push", "--atomic",
      `--force-with-lease=refs/heads/${PLACEHOLDER.next}:${was.next}`,
      `--force-with-lease=refs/heads/${PLACEHOLDER.staging}:${was.staging}`,
      "origin", "--delete", `refs/heads/${PLACEHOLDER.next}`,
      `refs/heads/${PLACEHOLDER.staging}`]);
    out(`Deleted ${PLACEHOLDER.next} and ${PLACEHOLDER.staging} again, `
      + "since next and staging did not move.");
  } catch (error) {
    out(`${PLACEHOLDER.next} and ${PLACEHOLDER.staging} stay on origin: `
      + `deleting them failed (${said(error)}). next and staging did not `
      + "move, so delete both by hand before the next hotfix start.");
  }
};

// After start's push of next and staging failed: origin may have taken
// it all the same (a dropped connection). Delete the placeholders only
// if both branches are still where they were; else keep them, since
// they are then the only refs to the unreleased work (round 3, D).
const afterFailedPush = async (deps, was) => {
  const { git, out } = deps;
  let now;

  try {
    now = await fetchHeads(git);
  } catch (error) {
    out(`${PLACEHOLDER.next} and ${PLACEHOLDER.staging} stay on origin: `
      + `the fetch to see whether next and staging moved failed `
      + `(${said(error)}). Check origin before you delete them.`);

    return;
  }
  if (now.next === was.next && now.staging === was.staging) {
    await dropPlaceholders(deps, was);

    return;
  }
  out(`${PLACEHOLDER.next} (${short(was.next)}) and ${PLACEHOLDER.staging} `
    + `(${short(was.staging)}) stay on origin: the push reported a failure, `
    + `but next is now ${short(now.next ?? "gone")} and staging `
    + `${short(now.staging ?? "gone")}, so origin took at least part of it `
    + "and the placeholders are kept as the only refs to the unreleased "
    + "work. Check origin, then go on with the hotfix as start would have.");
};

const start = async ({ dryRun, yes, out, file }, deps) => {
  const { git, confirm } = deps;
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

  let result;

  try {
    result = await window(deps, file,
      () => forcePush(git, { next, staging }, { next: main, staging: main }));
  } catch (error) {
    // The window refused before it narrowed anything: nothing moved.
    await dropPlaceholders(deps, { next, staging });
    throw error;
  }

  if (result.pushError) {
    await afterFailedPush(deps, { next, staging });
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

// The paths whose tree entries (mode and content, or absent) differ
// between two commits. Plumbing, so no diff setting of the checkout
// (whitespace, textconv, submodules) hides a change.
const changedPaths = async (git, a, b) => new Set((await git(["diff-tree",
  "-r", "-z", "--no-renames", "--name-only", a, b])).split("\0")
  .filter(Boolean));

const FORMAT = "--format=%H%x1f%P%x1f%ae%x1f%ad%x1f%s";

const commitsIn = async (git, range) => (await git(["log", "--reverse",
  "--date=raw", FORMAT, range])).split("\n").filter(Boolean).map((line) => {
  const [sha, parents, email, date, subject] = line.split("\x1f");

  return {
    sha, parents: parents.split(" ").filter(Boolean), subject,
    key: `${email}\x1f${date}\x1f${subject}`,
  };
});

// The commits of `range` with a patch-id copy on `main`.
const copiesOnMain = async (git, main, head) => new Set((await git(["log",
  "--right-only", "--cherry-mark", "--no-merges", "--format=%m %H",
  `${main}...${head}`])).split("\n").filter((l) => l.startsWith("= "))
  .map((l) => l.slice(2)));

// The paths the hotfix (old main to main) and a placeholder (old main
// to its head) both touched.
export const bothTouched = async (git, oldMain, main, head) => {
  const hot = await changedPaths(git, oldMain, main);

  return [...await changedPaths(git, oldMain, head)]
    .filter((path) => hot.has(path)).sort();
};

// Criterion 6 as round 3's C states it: each rebuilt branch (R) against
// its placeholder (H), with old main (O) and main (M), compared path by
// path. A path the hotfix did not touch (O = M) must be in R as in H; a
// path no placeholder commit touched (O = H) must be in R as in M; a
// path both touched where R differs from H or M is to be confirmed.
// `p` holds the placeholders' and the rebuilt branches' heads, old main
// and main now. -> { refused, confirm, dropped, emptied, flattened }:
// refused [{ branch, path, why }], confirm [{ branch, head, paths }].
export const compare = async (git, p) => {
  const hot = await changedPaths(git, p.oldMain, p.main);
  const refused = [];
  const confirm = [];

  for (const [branch, head, rebuilt] of [["staging", p.hs, p.staging],
    ["next", p.hn, p.next]]) {
    const placeholder = PLACEHOLDER[branch];
    const own = await changedPaths(git, p.oldMain, head);
    const fromHead = await changedPaths(git, head, rebuilt);
    const fromMain = await changedPaths(git, p.main, rebuilt);
    const paths = [];

    for (const path of [...new Set([...fromHead, ...fromMain])].sort()) {
      if (!hot.has(path) && fromHead.has(path)) {
        refused.push({ branch, path, why: "the hotfix did not touch it, so "
          + `it must be as ${placeholder} has it` });
      } else if (!own.has(path) && fromMain.has(path)) {
        refused.push({ branch, path, why: "no commit of "
          + `${placeholder} touched it, so it must be as main has it` });
      } else if (hot.has(path) && own.has(path)) {
        paths.push(path);
      }
    }
    if (paths.length) confirm.push({ branch, head, rebuilt, paths });
  }

  // What the rebuild left out of the placeholders: a patch-id copy of a
  // commit on main, or a commit the rebuild emptied.
  const commits = await commitsIn(git, `${p.oldMain}..${p.hn}`);
  const copies = await copiesOnMain(git, p.main, p.hn);
  const rebuilt = new Set((await commitsIn(git, `${p.main}..${p.next}`))
    .map((c) => c.key));
  const named = (c) => `${short(c.sha)} ${printable(c.subject)}`;

  return {
    refused, confirm,
    dropped: commits.filter((c) => copies.has(c.sha)).map(named),
    emptied: commits.filter((c) => c.parents.length === 1
      && !copies.has(c.sha) && !rebuilt.has(c.key)).map(named),
    flattened: commits.filter((c) => c.parents.length > 1).map(named),
  };
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
const finishFirst = async ({ dryRun, out, file }, deps, heads) => {
  const { git, confirm } = deps;
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
    const both = [...new Set([
      ...await bothTouched(git, oldMain, main, hs),
      ...await bothTouched(git, oldMain, main, hn),
    ])].sort();

    out("  refuse unless, path by path, the rebuilt next and staging are "
      + "as the placeholders had them where the hotfix touched nothing, "
      + "and as main has them where the placeholders touched nothing");
    out(`  show and ask you to confirm the paths the hotfix and the `
      + `placeholders both touched, even with --yes: ${
        both.map(printable).join(", ") || "none"}`);
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

  const found = await compare(git, {
    oldMain, main, hn, hs, next: rn, staging: rs,
  });

  if (found.refused.length) {
    await putBack(git);
    throw new Error("Refused: the rebuild changed what it must keep. "
      + `${found.refused.map((x) => `In the rebuilt ${x.branch}, ${
        printable(x.path)}: ${x.why}.`).join(" ")} Nothing is pushed and `
      + "the placeholders stay. Run bin/nff hotfix finish again and keep "
      + "those changes when you resolve the conflict.");
  }
  for (const c of found.dropped) out(`Dropped, main already has it: ${c}`);
  for (const c of found.emptied) {
    out(`Emptied by the rebuild, and not a copy of a commit on main: ${c}. `
      + "Check its change is meant to go.");
  }
  for (const c of found.flattened) {
    out(`Flattened the merge commit ${c}: its commits are replayed one `
      + "by one.");
  }
  if (found.confirm.length) {
    const paths = [...new Set(found.confirm.flatMap((x) => x.paths))].sort();

    for (const x of found.confirm) {
      out(`How the rebuilt ${x.branch} differs from ${PLACEHOLDER[x.branch]}`
        + " where the hotfix and the placeholders both made changes:");
      for (const line of (await git(["--literal-pathspecs", "diff",
        "--no-color", "--no-ext-diff", "--no-textconv", x.head, x.rebuilt,
        "--", ...x.paths])).split("\n")) out(`  ${printable(line)}`);
    }
    if (!await confirm(`The hotfix and the placeholders both changed ${
      listed(paths.map(printable))}. Is the rebuild shown above right?`)) {
      await putBack(git);
      throw new Error(`Refused: not confirmed. Nothing is pushed and the `
        + "placeholders stay. Run bin/nff hotfix finish again and resolve "
        + "the rebuild as it should be.");
    }
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
    result = await window(deps, file, () => git(["push", "--atomic",
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

// Whether step 2's pushes already went through, so a run again after a
// failed delete only deletes (round 3, F). They did when `next` is
// `hotfix/rebuilt` and `staging` has left `main`, which only step 2
// moves it from. With `staging` still at `main` and `next` past it,
// either step 2 went through on a rebuilt staging that was `main`, or
// step 1 left a rebuilt staging that is also the rebuilt next; the
// rebuilt next holds a commit rebuilt from `hotfix/staging` (same
// author, date and subject) only in the second. Unsure is "moved",
// since only deleting never moves `staging`.
const movedAlready = async (git, heads) => {
  const { main, next, staging } = heads;
  const hs = heads[PLACEHOLDER.staging];

  if (next !== heads[REBUILT]) return false;
  if (staging !== main || next === main || !hs) return true;

  const oldMain = await git(["merge-base", hs, main]);
  const own = new Set((await commitsIn(git, `${oldMain}..${hs}`))
    .map((c) => c.key));

  return !(await commitsIn(git, `${main}..${next}`))
    .some((c) => own.has(c.key));
};

// Deletes the hotfix branches, each leased on the head it had.
const deleteHotfixBranches = async (git, heads, branches, out) => {
  try {
    await git(["push", "--atomic",
      ...branches.map((name) => `--force-with-lease=refs/heads/${name}:${
        heads[name]}`),
      "origin", "--delete", ...branches.map((name) => `refs/heads/${name}`)]);
  } catch (error) {
    throw new Error(`Deleting ${branches.map(printable).join(", ")} failed: `
      + `${said(error)}. staging and next have moved; run bin/nff hotfix `
      + "finish again, which then only deletes them.", { cause: error });
  }
  out(`Deleted ${branches.map(printable).join(", ")}.`);
};

const reportLanes = (out, lanes, hn) => {
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

  const lanes = hn
    ? await lanesToRebase(git, heads, hn, await git(["merge-base", hn, main]))
    : [];
  const branches = [PLACEHOLDER.next, PLACEHOLDER.staging, REBUILT]
    .filter((name) => heads[name]);

  if (await movedAlready(git, heads)) {
    if (dryRun) {
      out("--dry-run: nothing is changed. hotfix finish (second run) "
        + `would: delete ${branches.map(printable).join(", ")} only, since `
        + `staging and next already moved (next is ${REBUILT}, `
        + `${short(rebuilt)})`);

      return undefined;
    }
    out(`staging and next already moved (next is ${REBUILT}, `
      + `${short(rebuilt)}): only the hotfix branches are left to delete.`);
    await deleteHotfixBranches(git, heads, branches, out);

    return reportLanes(out, lanes, hn);
  }

  const missing = unproven(await checkRuns(api, next));

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
  await deleteHotfixBranches(git, heads, branches, out);

  return reportLanes(out, lanes, hn);
};

const finish = async (options, deps) => {
  const heads = await fetchHeads(deps.git);

  return heads[REBUILT]
    ? finishSecond(options, deps, heads)
    : finishFirst(options, deps, heads);
};

// A flag the commands do not take, refused before anything is read
// (round 3, E): a typo of --dry-run must never run for real. bin/nff
// asks this too, before it routes. -> undefined, or the Error.
export const flagRefusal = (action, flags = {}) => {
  const unknown = Object.keys(flags).filter((name) => !FLAGS.includes(name));

  return unknown.length ? new Error(`Refused: hotfix ${printable(action
    ?? "")} takes only --dry-run and --yes, not ${unknown
    .map((name) => `--${printable(name)}`).join(", ")}. Nothing changed.`)
    : undefined;
};

export const hotfixCommand = async (action, rest, { flags = {}, out },
  deps = {}) => {
  const refusal = flagRefusal(action, flags);

  if (refusal) throw refusal;
  if (!["start", "finish"].includes(action)) {
    throw new Error("hotfix start or hotfix finish?");
  }
  if (rest.length) {
    throw new Error(`Refused: hotfix ${printable(action)} takes no `
      + "arguments.");
  }

  const d = { ...realDeps, ...deps, out };
  const file = await preflight(d);
  const options = {
    dryRun: on(flags["dry-run"]), yes: on(flags.yes), out, file,
  };

  return action === "start" ? start(options, d) : finish(options, d);
};
