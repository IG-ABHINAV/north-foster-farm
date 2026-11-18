// The e2e helper pace.mjs (#653): the overflow spec's page walks wait
// between page loads against staging, and not against a local build.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PACE_MS, pace, paceMs } from "../e2e/support/pace.mjs";

const STAGING = "https://staging--north-foster-farm.netlify.app";

test("a walk waits between page loads against staging", () => {
  assert.ok(PACE_MS > 0);
  assert.equal(paceMs(STAGING), PACE_MS);
  assert.equal(paceMs(`${STAGING}/`), PACE_MS);
});

test("a walk makes no wait against a local build", async () => {
  assert.equal(paceMs("http://localhost:8080"), 0);
  assert.equal(paceMs("http://127.0.0.1:4173/"), 0);

  const start = Date.now();

  await pace("http://localhost:8080");
  assert.ok(Date.now() - start < PACE_MS / 2);
});
