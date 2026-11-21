// The PayPal recorder (#708): while a recording window is open, each
// request lib/paypal.mjs sends PayPal and each webhook event PayPal
// delivers is saved, with its answer, to the private `recordings`
// store, so the live Venmo test leaves real responses for the fakes.
// `bin/nff record open|close|pull` (bin/recorder.mjs) runs the window
// and takes the records to .ignored/fixtures-raw/.
//
//   window            { openedAt, until }: open while `until` is
//                     ahead, at most an hour after it opened
//   record/<name>     { name, service: "paypal", status, request:
//                     { method, path, headers, body }, response, at }
//
// A record holds the payer's details until bin/fixtures/scrub turns it
// into a fixture; one never pulled is deleted after 7 days by the jobs.
// It never holds a secret: the token exchange is not recorded, and a
// request's headers are only the ones listed in HEADERS.
//
// Recording never touches a payment. The window is read while the
// PayPal request is in flight, a save is given SAVE_MS after the answer
// and then left, and any failure is logged as paypal.record_failed and
// otherwise ignored.

import { randomBytes } from "node:crypto";

import { log } from "./log.mjs";

export const WINDOW_KEY = "window";
export const RECORD_PREFIX = "record/";
export const MAX_MINUTES = 60;
export const KEEP_MS = 7 * 24 * 60 * 60_000;
export const SAVE_MS = 400;

// The request headers worth keeping: none carries a secret.
const HEADERS = new Set([
  "content-type", "paypal-request-id", "paypal-auth-algo",
  "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig",
  "paypal-transmission-time",
]);

// The CLI's record mode: bin/nff --record sets the context's store
// here, and its PayPal calls record into it. Null turns it off.
let cliStore = null;

export const recordInto = (store) => {
  cliStore = store || null;
};

export const cliRecordings = () => cliStore;

// -> whether a window is open at `now`.
export const windowOpen = async (store, now) => {
  const w = await store.get(WINDOW_KEY);

  return !!(w && Date.parse(w.until) > now.getTime());
};

export const headersOf = (headers) => {
  const out = {};
  const entries = headers instanceof Headers ? [...headers.entries()]
    : Object.entries(headers || {});

  for (const [name, value] of entries) {
    if (HEADERS.has(name.toLowerCase()) && value !== undefined) {
      out[name.toLowerCase()] = String(value);
    }
  }

  return out;
};

// A record's name, sorted by time, readable, and unique:
// paypal-20261121T140100123Z-post-v2-checkout-orders-ppo-capture-1a2b3c
const nameFor = (request, at) => [
  "paypal",
  at.toISOString().replace(/[-:.]/g, ""),
  request.method.toLowerCase(),
  request.path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  randomBytes(3).toString("hex"),
].filter(Boolean).join("-");

const failed = (path, error) => log.warn({
  event: "paypal.record_failed", path,
  error: String((error && error.message) || error).slice(0, 200),
});

// Runs `work`, giving it SAVE_MS, and never throws: a failure or a
// store that does not answer is logged and left behind.
const guarded = async (path, work) => {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(new Error("the store did not answer")),
      SAVE_MS);
  });
  const done = Promise.resolve().then(work).then(() => null, (e) => e || 0);
  const outcome = await Promise.race([done, late]);

  clearTimeout(timer);
  if (outcome !== null) failed(path, outcome);
};

// Starts reading the window, for an exchange about to begin. -> a
// function to call with the answer (and the request's body, if it was
// not known at the start), which saves the exchange if the window was
// open, within SAVE_MS, and never throws. `keep` false saves nothing.
// `store` null: nothing is read or saved.
export const recorder = (store, { request, now }) => {
  if (!store) return async () => {};

  // Read now, so the read runs alongside PayPal's answer; its failure
  // is reported once the exchange is saved or skipped.
  const open = Promise.resolve().then(() => windowOpen(store, now));

  open.catch(() => {});

  return ({
    status, response, keep = true, body = request.body,
  }) => guarded(request.path,
    async () => {
      if (!await open || !keep) return;

      const at = now;
      const name = nameFor(request, at);

      await store.set(`${RECORD_PREFIX}${name}`, {
        name,
        service: "paypal",
        status,
        request: {
          method: request.method,
          path: request.path,
          headers: headersOf(request.headers),
          body: body === undefined ? null : body,
        },
        response: response === undefined ? null : response,
        at: at.toISOString(),
      });
    });
};

// Every saved record. -> [{ key, record }], oldest first.
export const records = async (store) => {
  const out = [];

  for (const { key } of await store.list(RECORD_PREFIX)) {
    const record = await store.get(key);

    if (record) out.push({ key, record });
  }

  return out;
};

// Deletes every record older than KEEP_MS, pulled or not, and a
// window long closed. -> how many records it deleted.
export const prune = async (store, { now = new Date() } = {}) => {
  let deleted = 0;

  for (const { key, record } of await records(store)) {
    const at = Date.parse(record.at);

    if (!Number.isFinite(at) || now.getTime() - at > KEEP_MS) {
      await store.delete(key);
      deleted += 1;
    }
  }

  const w = await store.get(WINDOW_KEY);

  if (w && now.getTime() - Date.parse(w.until) > KEEP_MS) {
    await store.delete(WINDOW_KEY);
  }
  if (deleted) {
    log.info({ event: "paypal.records_pruned", by: "jobs", deleted });
  }

  return deleted;
};
