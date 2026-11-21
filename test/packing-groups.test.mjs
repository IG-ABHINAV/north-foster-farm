// Round one's criteria test for #694 (packing slips just in time),
// written 2026-11-20 from its "Done when" boxes before any code. James's
// revision that evening (one email per kind of fulfillment) retired
// every box here but one: test/packing-kinds.test.mjs checks them now.
// What stays is the box the revision left as it was, met by 8e7eccae:
// there is no weekly Sunday batch. Every order is a fake from the
// staging library; no mail leaves the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import series from "../data/series.json" with { type: "json" };
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  dropSite, order as delivery, pickup,
} from "../netlify/functions/lib/library.mjs";
import { saveOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

// Friday 20 November 2026 and the days around it.
const THU = "2026-11-19";
const SAT = "2026-11-21";
const SUN = "2026-11-22";
const MON = "2026-11-23";
const WED = "2026-11-25";
const NEXT_SAT = "2026-11-28";
const placed = at(THU, 9);

const FARM = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
};

const DROP = series.series.find((s) => s.kind === "drop-site");

const occurrence = (s, date) => ({
  method: "scheduled", occurrence: `${s.code}-${date.slice(2)
    .replaceAll("-", "")}`, date, onfarm: null, delivery: null,
});

const fake = (id, build, fulfilment, item) => build({
  id, submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
  emails: { orderConfirmed: { at: placed.toISOString() } },
  lines: [{ sku: `SKU-${id}`, label: item, qty: 2, lineTotal: 14 }],
  fulfilment,
});

const atDrop = (id, date) =>
  fake(id, dropSite, occurrence(DROP, date), "Drop site eggs");
const onFarm = (id, date) =>
  fake(id, pickup, { ...pickup().fulfilment, date }, "Farm stand chicken");
const delivered = (id, date) =>
  fake(id, delivery, { ...delivery().fulfilment, date }, "Delivered ham");

const harness = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}` };
    },
    fetchImpl: async () => new Response("OK", { status: 200 }),
  };
};

const isPacking = (m) => /packing slips/i.test(m.subject);

// One 15-minute run of the real job. -> the packing emails it sent.
const tick = async (stores, h, now) => {
  const from = h.sent.length;

  await runJobs(stores, {
    env: FARM, mail: h.mail, fetchImpl: h.fetchImpl, now,
  });

  return h.sent.slice(from).filter(isPacking);
};

const pdfOf = (m) => (m.attachments && m.attachments.length
  ? Buffer.from(m.attachments[0].content, "base64").toString("latin1")
  : "");
const everything = (m) => `${m.subject}\n${m.text}\n${pdfOf(m)}`;
const idsIn = (m, ids) => ids.filter((id) => pdfOf(m).includes(id)).sort();

describe("#694 packing slips just in time", () => {
  it("There is no weekly Sunday batch", async () => {
    const stores = testStores();
    const h = harness();
    const week = ["NFF-2611-OFM3", "NFF-2611-DEL3", "NFF-2611-DSL3"];

    // Nothing for Sunday; the coming week's orders, placed Thursday.
    await Promise.all([
      onFarm("NFF-2611-OFM3", MON), delivered("NFF-2611-DEL3", WED),
      atDrop("NFF-2611-DSL3", NEXT_SAT),
    ].map((o) => saveOrder(stores, o, placed)));

    const satEve = await tick(stores, h, at(SAT, 15));
    const sunday = await tick(stores, h, at(SUN, 6));

    assert.deepEqual(sunday.map((m) => m.subject), [],
      "Sunday 6 AM sends nothing: nothing for Sunday is late");
    for (const m of [...satEve, ...sunday]) {
      assert.doesNotMatch(m.subject, /week/i);
      week.forEach((id) => assert.ok(!everything(m).includes(id),
        `"${m.subject}" does not carry ${id} early`));
      assert.doesNotMatch(pdfOf(m), /\(Reprint\)/);
    }

    // Monday's slip comes the day before, and only Monday's.
    const sunEve = await tick(stores, h, at(SUN, 15));

    assert.equal(sunEve.length, 1, sunEve.map((m) => m.subject).join(" | "));
    assert.deepEqual(idsIn(sunEve[0], week), ["NFF-2611-OFM3"]);
  });
});
