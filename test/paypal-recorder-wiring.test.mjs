// The implementer's own tests for the PayPal recorder (#708), for
// what the criteria tests in paypal-recorder.test.mjs do not reach:
// the jobs' prune, the token exchange, the deliveries PayPal would not
// vouch for, and where a call records by default. PayPal is a fetch
// stub, as there: nothing here calls PayPal.

/* eslint camelcase: ["error", { "properties": "never" }] */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { recordCommand } from "../bin/recorder.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  forgetTokens, getRefund, recordingsFor, verifyWebhook,
} from "../netlify/functions/lib/paypal.mjs";
import {
  RECORD_PREFIX, WINDOW_KEY, recordInto,
} from "../netlify/functions/lib/recorder.mjs";
import { memoryStore, testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/paypal-webhook.mjs";

const env = {
  PAYPAL_CLIENT_ID: "CLIENT-ID",
  PAYPAL_CLIENT_SECRET: "CLIENT-SECRET",
  PAYPAL_ENV: "sandbox",
  PAYPAL_WEBHOOK_ID: "WH-1",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
};
const T0 = new Date("2026-11-21T14:00:00Z");
const DAY = 24 * 60 * 60_000;

// Answers in PayPal's shape, as in test/paypal.test.mjs.
const stub = (answers) => async (url) => new Response(
  JSON.stringify(answers[new URL(url).pathname] || {}),
  { status: 200, headers: { "Content-Type": "application/json" } },
);
const ANSWERS = {
  "/v1/oauth2/token": { access_token: "ACCESS", expires_in: 3600 },
  "/v2/payments/refunds/REF": { id: "REF", status: "COMPLETED" },
  "/v1/notifications/verify-webhook-signature": {
    verification_status: "FAILURE",
  },
};

const opened = async (now = T0) => {
  const store = memoryStore();

  await store.set(WINDOW_KEY, {
    openedAt: now.toISOString(),
    until: new Date(now.getTime() + 60 * 60_000).toISOString(),
  });

  return store;
};
const saved = async (store) => (await store.list(RECORD_PREFIX)).length;
const quiet = (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
};

beforeEach(() => forgetTokens());
afterEach(() => recordInto(null));

describe("#708: the recorder's wiring", () => {
  it("the jobs delete records older than 7 days and keep newer ones",
    async (t) => {
      quiet(t);
      const stores = testStores();

      await stores.recordings.set(`${RECORD_PREFIX}old`, {
        name: "old", service: "paypal",
        at: new Date(T0.getTime() - 8 * DAY).toISOString(),
      });
      await stores.recordings.set(`${RECORD_PREFIX}new`, {
        name: "new", service: "paypal",
        at: new Date(T0.getTime() - DAY).toISOString(),
      });

      const report = await runJobs(stores, {
        env, mail: async () => ({ id: "m", driver: "test" }),
        now: T0, realNow: T0, paypal: null,
      });

      assert.equal(report.recordingsPruned, 1);
      assert.deepEqual((await stores.recordings.list(RECORD_PREFIX))
        .map((k) => k.key), [`${RECORD_PREFIX}new`]);
    });

  it("never records the token exchange", async () => {
    const store = await opened();

    await getRefund("REF", {
      env, fetchImpl: stub(ANSWERS), now: T0, recordings: store,
    });

    const paths = [];

    for (const { key } of await store.list(RECORD_PREFIX)) {
      paths.push((await store.get(key)).request.path);
    }
    assert.deepEqual(paths, ["/v2/payments/refunds/REF"]);
  });

  it("records no verification PayPal refused, and no rejected delivery",
    async (t) => {
      quiet(t);
      const store = await opened();
      const headers = new Headers({
        "paypal-transmission-sig": "forged",
        "paypal-transmission-id": "TX",
      });

      assert.equal(await verifyWebhook(headers, "{\"id\":\"E\"}", {
        env, fetchImpl: stub(ANSWERS), now: T0, recordings: store,
      }), false);
      assert.equal(await saved(store), 0);

      const stores = { ...testStores(), recordings: store };
      const res = await handle(new Request("https://x/api/paypal/webhook", {
        method: "POST", headers, body: "{\"id\":\"E\"}",
      }), { stores, env, now: T0, verify: async () => false });

      assert.notEqual(res.status, 200);
      assert.equal(await saved(store), 0);
    });

  it("records by default only where it was told to", async () => {
    const store = memoryStore();

    assert.equal(recordingsFor(env, null), null);
    assert.equal(recordingsFor(env, store), store);
    assert.equal(recordingsFor(env, undefined), null, "off Netlify: none");
    recordInto(store);
    assert.equal(recordingsFor(env, undefined), store, "the CLI's");
    recordInto(null);
    assert.equal(recordingsFor(env, undefined), null);
  });

  it("refuses a window of no length, and closes one with none open",
    async (t) => {
      quiet(t);
      const stores = testStores();
      const root = mkdtempSync(join(tmpdir(), "nff-recorder-"));
      const said = [];
      const run = (action, flags = {}) => recordCommand(action, {
        stores, flags, root, now: T0, out: (s) => said.push(s),
      });

      for (const minutes of ["0", "-5", "1.5", "lots"]) {
        await assert.rejects(run("open", { minutes }), /--minutes/);
      }
      assert.equal(await stores.recordings.get(WINDOW_KEY), null);
      await run("close");
      assert.match(said.at(-1), /No window was open/);
      await run("pull");
      assert.deepEqual(readdirSync(join(root, ".ignored", "fixtures-raw")),
        []);
      await assert.rejects(run("start"), /Usage/);
    });
});
