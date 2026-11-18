// The pickup schedule for `bin/nff schedule check` and `schedule set`:
// a file checked as a deploy checks it (checkedSchedule), the paid
// deliveries on a Thursday a delivery line replaces (paidOnReplaced,
// #640), and the variable set on Netlify and read back (setSchedule).

import { checkSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import {
  addDays, label, weekday,
} from "../assets/scripts/order/lib/zoned.mjs";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "delivery moved to Wednesday, November 25" for each delivery line,
// joined for a summary; empty when the schedule moves none.
export const movedSummary = (deliveries) => deliveries.map((d) =>
  `delivery moved to ${label(d.date)}`).join(", ");

// A schedule file's text, checked as a deploy checks it (W11d), the
// holidays included. -> { value, summary }: the variable's value, one
// date per entry and every line kept, and a line to print; and the
// delivery lines, for paidOnReplaced. Throws with every problem.
export const checkedSchedule = (text, { now = new Date(), terms }) => {
  const r = checkSchedule(text, {
    now, timeZone: terms.timeZone, model: terms.model,
    holidays: terms.holidays,
  });

  if (!r.ok) {
    throw new Error(`The schedule has ${plural(r.errors.length,
      "problem")}:\n  ${r.errors.join("\n  ")}`);
  }

  const byDate = new Map();

  for (const w of r.windows) {
    byDate.set(w.date, [...(byDate.get(w.date) || []), w.id]);
  }

  const lines = r.lines.map((l) => `${l.date} ${l.code} ${l.action}${
    l.id ? ` ${l.id}` : ""}`);
  const moved = movedSummary(r.deliveries);

  return {
    value: [
      ...[...byDate].map(([date, ids]) => `${date} ${ids.join(" ")}`),
      ...lines,
      ...r.deliveries.map((d) => `${d.date} delivery`),
    ].join("; "),
    summary: `${plural(r.windows.length, "window")} on ${plural(byDate.size,
      "day")}, ${r.windows[0].date} through ${r.last}, and ${
      plural(lines.length, "occurrence line")}${
      moved ? `; ${moved}` : ""}. It passes.`,
    deliveries: r.deliveries,
  };
};

// The week's delivery day each delivery line replaces, its Thursday
// (`terms.delivery.weekday`), and the paid delivery orders still on
// it, which the farm moves or the customers change (#640). A line on
// the Thursday itself replaces nothing.
// -> [{ date, replaced, ids }], by date, the ids sorted.
export const paidOnReplaced = (orders, deliveries, terms) =>
  [...deliveries].sort((a, b) => a.date.localeCompare(b.date)).map(({
    date,
  }) => {
    const replaced = replacedDay(date, terms);
    const ids = replaced === date ? [] : orders
      .filter((o) => o.status === "paid" && o.fulfilment
        && o.fulfilment.method === "delivery"
        && o.fulfilment.date === replaced)
      .map((o) => o.id)
      .sort();

    return { date, replaced, ids };
  });

// The default delivery day in the week of `date`.
const replacedDay = (date, terms) => addDays(
  addDays(date, -((weekday(date) + 6) % 7)),
  (terms.delivery.weekday + 6) % 7);

// The lines `schedule set` prints about paid orders on the replaced
// days. The variable is already set when this runs, so a failed read
// is reported and never stops the deploy that follows; with no
// delivery line count is never called, so the orders are not read.
// count() -> Promise<paidOnReplaced's result>, the orders read in it.
// -> Promise<[line]>.
export const replacedReport = async (count, deliveries, terms) => {
  if (!deliveries.length) return [];

  let replaced;

  try {
    replaced = await count();
  } catch (e) {
    const days = [...new Set(deliveries.map((d) =>
      replacedDay(d.date, terms)))].sort().join(", ");

    return [`Couldn't count paid orders on ${days}: ${e.message}`];
  }

  return replaced.map(({ date, replaced: from, ids }) =>
    `Delivery moved to ${date} from ${from}: ${ids.length} paid ` +
    `delivery order${ids.length === 1 ? "" : "s"} still on ${from}${
      ids.length ? ` (${ids.join(", ")})` : ""}.`);
};

// Sets PICKUP_SCHEDULE on Netlify and reads it back. On 2026-09-28 a
// set to the staging branch exited 0 and left nothing on any site, and
// the next staging build failed its schedule check; a set that doesn't
// read back now fails where it's run.
//
// run(args) -> Promise<stdout>, the Netlify CLI; site is the site id
// the CLI was pointed at, for the error.
export const setSchedule = async (run, value, contexts, site) => {
  for (const context of contexts) {
    await run(["env:set", "PICKUP_SCHEDULE", value, "--context", context]);

    const back = String(await run(["env:get", "PICKUP_SCHEDULE",
      "--context", context])).trim();

    if (back !== value) {
      throw new Error(`PICKUP_SCHEDULE didn't take on ${context} of site ${
        site || "(no NETLIFY_SITE_ID)"}: it reads back ${back
        ? `as ${back.length} other characters` : "empty"}.`);
    }
  }
};
