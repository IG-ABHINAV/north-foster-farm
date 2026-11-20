// The implementer's own tests for the e2e request retry (#681): the
// line each retry prints, which no criteria test checks, and the
// failures that are not the transport's. The criteria tests are in
// e2e-request-retry.test.mjs; this drives the same wrapper on a
// stand-in request context that throws a set error, then answers.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const BASE = "http://127.0.0.1:9";
const SPEC = "e2e/retry-log-681.spec.mjs";

let watchRequests;
let lines;
let warn;

// Errors shaped as Playwright's, each with a call log that prints a
// header the retry line must never repeat.
const failure = (what) => new Error([
  `apiRequestContext.get: ${what}`,
  "Call log:",
  `  - → GET ${BASE}/api/account?token=made-up-681`,
  "    - cookie: nff_session=made-up-681",
  "",
].join("\n"));

before(async () => {
  process.env.E2E_BASE_URL = BASE;
  ({ watchRequests } = await import("../e2e/support/counted.mjs"));
  warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
});

after(() => {
  console.warn = warn;
});

const standIn = (plan) => {
  const calls = [];
  const api = {
    async fetch() {
      calls.push(1);
      const next = plan[Math.min(calls.length - 1, plan.length - 1)];

      if (next instanceof Error) throw next;

      return { status: () => next, text: async () => "" };
    },
    storageState: async () => ({ cookies: [] }),
  };

  watchRequests(api, SPEC);

  return { api, calls };
};

describe("the e2e request retry's log and limits (#681)", () => {
  it("prints one line per retry: method, path, kind and count, no "
    + "query or header", async () => {
    lines = [];
    const { api } = standIn([failure("read ECONNRESET"),
      failure("socket hang up"), 200]);

    await api.fetch(`${BASE}/api/account?token=made-up-681`,
      { method: "head" });

    assert.deepEqual(lines, [
      "[e2e] HEAD /api/account: connection reset, retry 1 of 2",
      "[e2e] HEAD /api/account: socket hang up, retry 2 of 2",
    ]);
  });

  it("prints nothing when no retry is made", async () => {
    lines = [];
    const { api } = standIn([200]);

    await api.fetch(`${BASE}/api/dates`);
    assert.deepEqual(lines, []);
  });

  it("never retries a timeout or an HTTP status Playwright threw",
    async () => {
      for (const what of ["Timeout 300ms exceeded.",
        "500 Internal Server Error"]) {
        lines = [];
        const { api, calls } = standIn([failure(what), 200]);

        await assert.rejects(api.fetch(`${BASE}/api/dates`));
        assert.equal(calls.length, 1, what);
        assert.deepEqual(lines, [], what);
      }
    });
});
