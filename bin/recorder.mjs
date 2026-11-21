// `bin/nff record open|close|pull` (#708): the PayPal recorder's
// window, and the records it saved (netlify/functions/lib/recorder.mjs).
//
//   record open [--minutes 60]   record every PayPal exchange in this
//                                context until the window closes by
//                                itself, an hour at most
//   record close                 close it now
//   record pull                  each saved record to
//                                .ignored/fixtures-raw/<name>.json, in
//                                the Square recorder's shape, then
//                                deleted from Blobs
//
// Each is logged as a production write (by: "cli"), with no payer's
// details: the window's times, and how many records were pulled.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "../netlify/functions/lib/log.mjs";
import {
  MAX_MINUTES, WINDOW_KEY, records,
} from "../netlify/functions/lib/recorder.mjs";
import { deployContext } from "../netlify/functions/lib/store.mjs";

export const USAGE = "bin/nff record open [--minutes 60] | close | pull";

// --minutes: a whole number from 1 to the hour.
const minutesOf = (value) => {
  if (value === undefined || value === true) return MAX_MINUTES;

  const n = Number(value);

  if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) {
    throw new Error(`--minutes is a whole number from 1 to ${MAX_MINUTES}.`);
  }

  return n;
};

const untilOf = (w) => (w && w.until) || null;

const open = async (store, { flags, out, now }) => {
  const minutes = minutesOf(flags.minutes);
  const before = await store.get(WINDOW_KEY);
  const after = {
    openedAt: now.toISOString(),
    until: new Date(now.getTime() + minutes * 60_000).toISOString(),
  };

  await store.set(WINDOW_KEY, after);
  log.info({
    event: "paypal.record_opened", by: "cli", context: deployContext(),
    before: untilOf(before), after: after.until, minutes,
  });
  const local = new Date(after.until).toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  });

  out(`Recording PayPal until ${local} ET (${minutes} min). ` +
    "bin/nff record close stops it sooner.");
};

const close = async (store, { out, now }) => {
  const before = await store.get(WINDOW_KEY);
  const wasOpen = !!before && Date.parse(before.until) > now.getTime();

  await store.delete(WINDOW_KEY);
  if (before) {
    log.info({
      event: "paypal.record_closed", by: "cli", context: deployContext(),
      before: untilOf(before), after: null, wasOpen,
    });
  }
  out(wasOpen ? "Recording closed." : "No window was open; none is now.");
};

// Each record is written before it is deleted, so a pull cut short
// loses nothing: the next one finds what is left.
const pull = async (store, { out, root }) => {
  const dir = join(root, ".ignored", "fixtures-raw");
  const found = await records(store);
  let pulled = 0;

  mkdirSync(dir, { recursive: true });
  for (const { key, record } of found) {
    // Names are the recorder's own; this keeps any other inside `dir`.
    const file = String(record.name).replace(/[^A-Za-z0-9_-]/g, "-");

    writeFileSync(join(dir, `${file}.json`),
      `${JSON.stringify(record, null, 2)}\n`);
    await store.delete(key);
    pulled += 1;
  }

  if (pulled) {
    log.info({
      event: "paypal.records_pulled", by: "cli", context: deployContext(),
      before: found.length, after: found.length - pulled, pulled,
    });
  }
  out(pulled
    ? `Pulled ${pulled} to ${dir}. Next: bin/fixtures/scrub.`
    : "No records to pull.");
};

const ACTIONS = { open, close, pull };

export const recordCommand = async (action, {
  stores, flags = {}, out = console.log, root, now = new Date(),
}) => {
  const work = ACTIONS[action];

  if (!work) throw new Error(`Usage: ${USAGE}`);
  if (!stores.recordings) throw new Error("No recordings store.");

  return work(stores.recordings, { flags, out, root, now });
};
