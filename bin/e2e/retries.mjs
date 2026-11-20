// What a Playwright log says about retried tests (#693): with retries
// on, a test that fails and then passes on a retry is flaky, and one
// that fails every try is failed. Playwright's list reporter closes a
// run with a list of each, after the numbered reports:
//
//     2 failed
//       [desktop] › e2e/a.spec.mjs:10:1 › a title ───────────
//     1 flaky
//       [phone] › e2e/b.spec.mjs:4:3 › another title ────────
//     12 passed (1.2m)
//
// as the runs recorded for #693 print them (test/fixtures/github/
// e2e-retry*.txt). A log is untrusted text: it is read line by line
// with whole-line patterns, and what comes back is printable().

import { printable } from "./dispatch.mjs";

// A log line as a person reads it: no timestamp, no escape sequences.
const bare = (line) => printable(String(line)
  .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")).trimEnd();

// `[PROJECT] › SPEC:LINE:COL › TITLE`, with the rule of `─` Playwright
// pads a closing-list line with dropped.
const TEST = /^ {4}\[([^\]]+)\] › (e2e\/[^\s:]+):(\d+):\d+ › (.+)$/;
const testOf = (line) => {
  const m = TEST.exec(line.replace(/[─ ]+$/u, ""));

  return m ? { project: m[1], spec: m[2], line: Number(m[3]), title: m[4] }
    : null;
};

const HEADER = /^ {2}(\d+) (failed|flaky)$/;
const SKIPPED = /^ {2}(\d+) skipped$/;
const PASSED = /^ {2}(\d+) passed \(\d+(?:\.\d+)?(?:ms|s|m|h|d)\)$/;
const EXITED = /^##\[error\]Process completed with exit code [1-9]\d*\.$/;
const RUNNING = new RegExp("^Running (\\d+) tests? using \\d+ workers?"
  + "(?:, shard \\d+ of \\d+)?$");

// Each closing list in the log: { kind, at, end, tests }, or null when
// one cannot be read (a count of nothing, or fewer tests under it).
const listsOf = (lines) => {
  const lists = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADER.exec(lines[i]);

    if (m) {
      const count = Number(m[1]);
      const tests = lines.slice(i + 1, i + 1 + count).map(testOf);

      if (!Number.isSafeInteger(count) || count < 1
        || tests.length !== count || tests.some((t) => !t)) return null;
      lists.push({ kind: m[2], at: i, end: i + 1 + count, tests });
      i += count;
    }
  }

  return lists;
};

// One entry per test, in the order the list names them, with every
// project it was listed in: a test flaky at both widths is one test.
export const byTest = (tests) => {
  const found = new Map();

  for (const t of tests) {
    const key = JSON.stringify([t.spec, t.title]);
    const seen = found.get(key);

    if (seen) {
      if (!seen.projects.includes(t.project)) seen.projects.push(t.project);
    } else {
      found.set(key, { spec: t.spec, line: t.line, title: t.title,
        projects: [t.project] });
    }
  }

  return [...found.values()];
};

export const named = (t) => `${t.spec} › ${t.title}`;

// The flaky tests of one job's log, from its one closing `N flaky`
// list: [] when it has none, null when it cannot be read (two lists,
// or one that does not hold its count of tests).
export const flakyInLog = (log) => {
  if (typeof log !== "string") return null;

  const lists = listsOf(log.split("\n").map(bare));

  if (!lists) return null;

  const flaky = lists.filter((l) => l.kind === "flaky");

  if (flaky.length > 1) return null;

  return flaky.length ? byTest(flaky[0].tests) : [];
};

// The tests of a failed staging job that failed every try, and the
// flaky ones, read strictly, since a release may ship past them: the
// one `N failed` list, perhaps the one `N flaky` list right after it,
// perhaps `N skipped` and `N passed (D)`, then the Run step's end, and
// failed, flaky, skipped and passed adding up to the one `Running N
// tests` line. Any other summary line (interrupted, did not run,
// errors outside a test) cannot be read. -> { failed, flaky }, each
// from byTest(), or null.
export const retriedInLog = (log) => {
  if (typeof log !== "string") return null;

  const lines = log.split("\n").map(bare);
  const lists = listsOf(lines);
  const running = lines.filter((l) => RUNNING.test(l));

  if (!lists || running.length !== 1) return null;

  const [failed, flaky, ...more] = lists;

  if (!failed || failed.kind !== "failed" || more.length) return null;
  if (flaky && (flaky.kind !== "flaky" || flaky.at !== failed.end)) {
    return null;
  }

  let at = (flaky ?? failed).end;
  const count = (pattern) => {
    const m = pattern.exec(lines[at] ?? "");

    if (!m) return 0;
    at += 1;

    return Number(m[1]);
  };
  const skipped = count(SKIPPED);
  const passed = count(PASSED);

  if (!EXITED.test(lines[at] ?? "")) return null;
  if (Number(RUNNING.exec(running[0])[1]) !== failed.tests.length
    + (flaky?.tests.length ?? 0) + skipped + passed) return null;

  return { failed: byTest(failed.tests), flaky: byTest(flaky?.tests ?? []) };
};

// The release pull request's list of failing tests shipped past (#693,
// James, 2026-11-20): under a line that is exactly the heading, up to
// the next heading or the end of the body, one item per test,
// "- `SPEC › TITLE`: REASON". -> Map of name to reason; an item with a
// blank reason is left out, so its test counts as not listed.
export const SHIPPED_PAST = "## Failing tests shipped past";

export const shippedPast = (body) => {
  const listed = new Map();
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimEnd() === SHIPPED_PAST);

  if (start === -1) return listed;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;

    const m = /^[-*] `([^`]+)`: (.*)$/.exec(line.trimEnd());

    if (m && m[2].trim() !== "" && !listed.has(m[1])) {
      listed.set(m[1], m[2].trim());
    }
  }

  return listed;
};
