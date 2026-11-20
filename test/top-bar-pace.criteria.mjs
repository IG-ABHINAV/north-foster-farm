// The criteria test for #687, written before the fix and held out of
// npm test until it lands: top-bar.spec's "every page carries it"
// walks every page in a row, and on staging Netlify's bot challenge
// answered one load (full run 44766787153). Its one testable box:
//
// - The walk waits between loads on staging and not on a local build,
//   with the same helper and pause as overflow.spec (#655,
//   e2e/support/pace.mjs).
//
// The second box is a full staging run and has no unit test.
//
// The spec is loaded for real, with two modules swapped by a loader
// hook: support/order.mjs, whose Playwright `test` and `expect` become
// stand-ins that collect the tests and pass every check, and
// support/pace.mjs, which becomes a wrapper that notes each call and
// then waits as the real helper does. The walk's body then runs
// against a stand-in page that notes each load and when it began.

import assert from "node:assert/strict";
import { register } from "node:module";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const REAL_PACE = new URL("e2e/support/pace.mjs", ROOT).href;
const SPEC = new URL("e2e/top-bar.spec.mjs", ROOT).href;

const STAGING = "https://staging--north-foster-farm.netlify.app";
const LOCAL = "http://localhost:8080";

const source = (text) => `data:text/javascript,${encodeURIComponent(text)}`;

// Playwright's test and expect, reduced to what a spec calls while it
// loads: tests are collected by name, describes run at once (one that
// throws on a missing event only loses its own tests), and every
// check passes.
const ORDER_STUB = source(`
  const tests = (globalThis.__specTests ??= new Map());
  const noop = () => {};
  const add = (name, ...rest) => { tests.set(name, rest.at(-1)); };
  const describe = (name, ...rest) => {
    try { rest.at(-1)(); } catch {}
  };
  Object.assign(describe, {
    configure: noop, serial: describe, parallel: describe,
    skip: noop, only: describe, fixme: noop,
  });
  export const test = Object.assign(add, {
    describe, skip: noop, fixme: noop, slow: noop, fail: noop,
    only: add, use: noop, beforeEach: noop, afterEach: noop,
    beforeAll: noop, afterAll: noop, setTimeout: noop, step: noop,
    info: () => ({ annotations: [] }),
  });
  const pass = new Proxy(() => {}, {
    get: (_, key) => (key === "then" ? undefined
      : key === "not" ? pass : async () => {}),
  });
  export const expect = Object.assign(() => pass, {
    soft: () => pass, poll: () => pass, configure: () => expect,
    extend: () => expect,
  });
`);

// The real pace.mjs, with each call noted first.
const PACE_STUB = source(`
  import * as real from ${JSON.stringify(REAL_PACE)};
  export const PACE_MS = real.PACE_MS;
  export const paceMs = real.paceMs;
  export const pace = async (baseURL) => {
    globalThis.__walk?.push({ pace: baseURL });
    await real.pace(baseURL);
  };
`);

register(source(`
  export async function resolve(specifier, context, next) {
    const found = await next(specifier, context);
    const parent = context.parentURL || "";

    if (found.url.endsWith("/e2e/support/order.mjs")) {
      return { url: ${JSON.stringify(ORDER_STUB)}, shortCircuit: true };
    }
    if (found.url === ${JSON.stringify(REAL_PACE)}
      && !parent.startsWith("data:")) {
      return { url: ${JSON.stringify(PACE_STUB)}, shortCircuit: true };
    }

    return found;
  }
`), pathToFileURL("./"));

const { PACE_MS } = await import(REAL_PACE);

await import(SPEC);

// A page that notes each load, and passes for anything else a spec
// asks of it.
const standIn = (walk) => {
  const any = new Proxy(() => {}, {
    get: (_, key) => (key === "then" ? undefined : () => any),
    apply: () => any,
  });

  return new Proxy({}, {
    get: (_, key) => {
      if (key === "then") return undefined;
      if (key === "goto") {
        return async (path) => {
          walk.push({ goto: path, at: performance.now() });
        };
      }

      return () => any;
    },
  });
};

// -> what the walk did against `baseURL`, in order, and how long it
// took in milliseconds.
const walkAgainst = async (baseURL) => {
  const body = globalThis.__specTests.get("every page carries it");

  assert.ok(body, "top-bar.spec has a test named every page carries it");

  const walk = [];

  globalThis.__walk = walk;

  const start = performance.now();

  try {
    await body({
      page: standIn(walk), baseURL, request: standIn([]),
      context: standIn([]),
    });
  } finally {
    globalThis.__walk = undefined;
  }

  return { walk, ms: performance.now() - start };
};

test("the walk waits between loads on staging, not on a local build, "
  + "with overflow.spec's helper and pause", async () => {
  // Staging: between every two loads, pace.mjs is called with the
  // base URL, and the next load begins a full pause later. Load only
  // lengthens a wait, so this lower bound holds on a busy machine.
  const staging = await walkAgainst(STAGING);
  const loads = staging.walk.filter((s) => s.goto);

  assert.ok(loads.length > 1, `the walk loads ${loads.length} page(s)`);

  for (let i = 1; i < loads.length; i += 1) {
    const from = staging.walk.indexOf(loads[i - 1]);
    const to = staging.walk.indexOf(loads[i]);
    const between = staging.walk.slice(from + 1, to);
    const pair = `${loads[i - 1].goto} and ${loads[i].goto}`;

    assert.ok(between.some((s) => s.pace === STAGING),
      `pace(baseURL) from e2e/support/pace.mjs between ${pair}`);

    const gap = loads[i].at - loads[i - 1].at;

    // Timers may fire a millisecond early by the clock read here.
    assert.ok(gap >= PACE_MS - 2,
      `${gap.toFixed(0)} ms between ${pair}, a pause of ${PACE_MS}`);
  }

  // A local build: the same pages, with no wait at all.
  const local = await walkAgainst(LOCAL);

  assert.deepEqual(local.walk.filter((s) => s.goto).map((s) => s.goto),
    loads.map((s) => s.goto), "the same pages as on staging");
  assert.ok(local.ms < PACE_MS / 2,
    `${local.ms.toFixed(0)} ms for the whole local walk`);
});
