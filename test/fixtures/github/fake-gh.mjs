// A stand-in for the `gh` command, for test/e2e-verdict.criteria.mjs
// (#623): it answers `gh api` from recorded answers, never the network.
//
//   node fake-gh.mjs <dir> api [flags] <path>
//
// <dir>/plan.json lists the routes:
//   { "routes": [{ "method": "GET", "path": "repos/.../runs/1",
//                  "answers": [answer, ...] }] }
// The path is matched without a leading slash or a query string. The
// route's answers are given in turn, and the last repeats. An answer
// is { "stdout": text } or { "stdoutFile": path }, with "stderr" and
// "exitCode" when gh failed. Each call is appended to <dir>/calls.log
// as "METHOD path", one per line.
//
// One rule of gh 2.104.0's is kept, as recorded on 2026-11-18
// (fixtures/github/e2e-verdict.json, escapeRefusal): an answer that
// holds an escape character (0x1b) is refused, gh printing that
// refusal and exiting 1, unless --allow-escape-sequences is given.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, command, ...args] = process.argv.slice(2);
const refusal = JSON.parse(readFileSync(
  new URL("e2e-verdict.json", import.meta.url), "utf8")).escapeRefusal;

const WITH_VALUE = new Set(["-X", "--method", "-H", "--header", "--input",
  "-f", "--raw-field", "-F", "--field", "-q", "--jq", "-t", "--template",
  "--hostname", "--cache", "-p", "--preview"]);

let method = "GET";
let allow = false;
let path;

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];

  if (a === "-X" || a === "--method") method = args[i + 1];
  if (a.startsWith("--method=")) method = a.slice("--method=".length);
  if (a === "--allow-escape-sequences"
    || a === "--allow-escape-sequences=true") allow = true;
  if (WITH_VALUE.has(a)) i += 1;
  else if (!a.startsWith("-") && path === undefined) path = a;
}

const done = (code, stdout = "", stderr = "") => {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
};

// Read what the caller sends before answering, as gh would.
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const bare = String(path || "").replace(/^\//, "").replace(/\?.*$/, "");

  appendFileSync(join(dir, "calls.log"), `${method} ${bare}\n`);
  if (command !== "api" || !path) {
    done(2, "", `fake gh: not a recorded call: ${command} ${args}\n`);

    return;
  }
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  const index = plan.routes
    .findIndex((r) => r.method === method && r.path === bare);

  if (index === -1) {
    done(2, "", `fake gh: no recorded answer for ${method} ${bare}\n`);

    return;
  }
  const route = plan.routes[index];
  const seenFile = join(dir, `route-${index}.count`);
  let seen;

  try {
    seen = Number(readFileSync(seenFile, "utf8")) || 0;
  } catch {
    seen = 0;
  }
  writeFileSync(seenFile, String(seen + 1));
  const answer = route.answers[Math.min(seen, route.answers.length - 1)];

  const stdout = answer.stdoutFile
    ? readFileSync(answer.stdoutFile, "utf8") : answer.stdout || "";

  if (!answer.exitCode && stdout.includes("\x1b") && !allow) {
    done(refusal.exitCode, refusal.stdout, refusal.stderr);

    return;
  }
  done(answer.exitCode || 0, stdout, answer.stderr || "");
});
