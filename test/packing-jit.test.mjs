// The implementer's own tests for #694 (packing slips just in time, one
// email per group), 2026-11-20: the code the criteria tests in
// test/packing-groups.test.mjs don't reach. The place names, a retry
// that sends no group twice, a morning with no 3 PM packet before it,
// and an order moved off its day after its slip was printed. Since
// qa's review (2026-11-20), an order mailed on a failed run that is
// cancelled or moved before the retry. Every
// order is a fake from the staging library; no mail leaves the test.
// James's revision that night (one email per kind of fulfillment,
// test/packing-kinds.test.mjs) moved the retries onto two kinds, the
// subjects to his words and the day to "Saturday, 11/21", and retired
// the morning's whole set when no 3 PM packet went.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  packingGroup, shortDay, townAndName,
} from "../netlify/functions/lib/describe.mjs";
import {
  dropSite, order as delivery, pickup, popUp,
} from "../netlify/functions/lib/library.mjs";
import { MailError } from "../netlify/functions/lib/mail.mjs";
import {
  EVE, PENDING, PING_KEY, packingDaily, packingEve, readPrinted,
} from "../netlify/functions/lib/packing.mjs";
import {
  amendOrder, saveOrder, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const at = (iso, h, m = 0) => instant(iso, h, m, "America/New_York");
const FRI = "2026-11-20";
const SAT = "2026-11-21";
const placed = at("2026-11-19", 9);
const URL = "https://hc-ping.example/packing-check";
const LIVE = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com", MAIL_DRIVER: "resend",
  [PING_KEY]: URL,
};

const occurrence = (code, date) => ({
  method: "scheduled", occurrence: `${code}-${date.slice(2)
    .replaceAll("-", "")}`, date, onfarm: null, delivery: null,
});
const fake = (id, build, fulfilment) => build({
  id, submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
  emails: { orderConfirmed: { at: placed.toISOString() } }, fulfilment,
});
const atDrop = (id, date = SAT) => fake(id, dropSite,
  occurrence("VFVQ", date));
const atPrep = (id) => fake(id, popUp, occurrence("W9MF", SAT));
const onFarm = (id) => fake(id, pickup, { ...pickup().fulfilment, date: SAT });
const LATE_MARKET = "Packing slips — new since yesterday: market/drop " +
  "site pickups for Saturday, 11/21";

// An email's PDF, as text; "" when it has none.
const pdfOf = (m) => (m.attachments && m.attachments.length
  ? Buffer.from(m.attachments[0].content, "base64").toString("latin1")
  : "");

const harness = (fail = () => null) => {
  const sent = [];
  const pings = [];

  return {
    sent, pings,
    mail: async (m) => {
      const error = fail(m);

      if (error) throw error;
      sent.push(m);

      return { id: `m${sent.length}` };
    },
    fetchImpl: async (url) => {
      pings.push(url);

      return new Response("OK");
    },
  };
};
const opts = (h, now) => ({
  env: LIVE, mail: h.mail, fetchImpl: h.fetchImpl, now,
});

describe("a packing group's place (#694)", () => {
  it("says the town once", () => {
    assert.equal(townAndName("Pawtucket", "Thanksgiving Prep"),
      "Pawtucket Thanksgiving Prep");
    assert.equal(townAndName("Pawtucket", "Pawtucket Farmers Market"),
      "Pawtucket Farmers Market");
    assert.equal(townAndName("Foster", "Foster Farmers’ Market"),
      "Foster Farmers’ Market");
    assert.equal(townAndName("North Scituate",
      "Scituate Rotary Farmers Market"), "Scituate Rotary Farmers Market");
    assert.equal(townAndName("", "Apple Fest"), "Apple Fest");
    assert.equal(townAndName("Exeter", "Summer Market at Tilted Barn"),
      "Summer Market at Tilted Barn", "a name holding its venue");
    assert.equal(
      townAndName("Warwick", "Pop-up at The Village Family Fitness"),
      "Pop-up at The Village Family Fitness");
  });

  it("names each group the farm's way", () => {
    assert.equal(packingGroup(atDrop("A").fulfilment).place,
      "North Scituate drop site");
    // A pop-up as James's 3 PM body names it (#694, spec item 3).
    assert.equal(packingGroup(atPrep("B").fulfilment).place,
      "Thanksgiving Prep pop-up");
    assert.equal(packingGroup(pickup().fulfilment).place, "On-farm pickup");
    assert.equal(packingGroup(delivery().fulfilment).place, "Delivery");
    assert.notEqual(packingGroup(atDrop("A").fulfilment).key,
      packingGroup(atDrop("A", "2026-11-28").fulfilment).key,
      "each occurrence is its own group");
  });

  it("dates a subject by weekday and month/day, with no year", () => {
    // As James's subjects write it (#694, spec item 2).
    assert.equal(shortDay("2026-11-21"), "Saturday, 11/21");
    assert.equal(shortDay("2027-01-04"), "Monday, 1/4");
  });
});

describe("sending the groups (#694)", () => {
  it("retries a failed kind without sending the others twice",
    async () => {
      const stores = testStores();
      let down = true;
      const h = harness((m) => (down && pdfOf(m).includes("NFF-2611-OFR1")
        ? new Error("Resend 503") : null));

      await saveOrder(stores, atDrop("NFF-2611-DSR1"), placed);
      await saveOrder(stores, onFarm("NFF-2611-OFR1"), placed);
      await assert.rejects(packingEve(stores, opts(h, at(FRI, 15))),
        /Resend 503/);
      assert.equal((await readPrinted(stores)).size, 0,
        "nothing counts as printed while a kind is owed");
      assert.ok(await stores.jobs.get(`${PENDING}${SAT}-eve`));
      assert.deepEqual(h.pings, [`${URL}/fail`]);

      down = false;
      await packingEve(stores, opts(h, at(FRI, 15, 15)));

      const keys = h.sent.map((m) => m.idempotencyKey);

      // The drop site went twice under one key, so Resend sends it once.
      assert.equal(new Set(keys).size, 2, keys.join(" "));
      assert.ok(keys.every((k) => k.startsWith(`packing-eve-${SAT}-`)));
      assert.equal((await readPrinted(stores)).size, 2);
      assert.equal(await stores.jobs.get(`${PENDING}${SAT}-eve`), null);
      assert.deepEqual([...(await stores.jobs.get(`${EVE}${SAT}`)).ids]
        .sort(), ["NFF-2611-DSR1", "NFF-2611-OFR1"]);
    });

  it("counts Resend's refusal of a resent key as that group sent",
    async () => {
      const stores = testStores();
      const h = harness((m) => (/drop site/.test(m.subject)
        ? new MailError("conflict", {
          status: 409, detail: { name: "invalid_idempotent_request" },
        })
        : null));

      await saveOrder(stores, atDrop("NFF-2611-DSK1"), placed);
      await saveOrder(stores, atPrep("NFF-2611-TPK1"), placed);
      await packingEve(stores, opts(h, at(FRI, 15)));

      assert.deepEqual([...(await readPrinted(stores)).keys()].sort(),
        ["NFF-2611-DSK1", "NFF-2611-TPK1"]);
    });

  // The case qa found on PR #695, on two kinds since #694's revision:
  // the drop site goes, on-farm pickup fails, and the drop site's order
  // changes before the retry, which sends only on-farm pickup.
  const sentThenChanged = async (change) => {
    const stores = testStores();
    let down = true;
    const h = harness((m) => (down && pdfOf(m).includes("NFF-2611-OFX9")
      ? new Error("Resend 503") : null));

    await saveOrder(stores, atDrop("NFF-2611-DSX1"), placed);
    await saveOrder(stores, onFarm("NFF-2611-OFX9"), placed);
    await assert.rejects(packingEve(stores, opts(h, at(FRI, 15))),
      /Resend 503/);
    assert.deepEqual((await stores.jobs.get(`${PENDING}${SAT}-eve`)).sent,
      ["NFF-2611-DSX1"], "the drop site's order is kept as sent");
    assert.equal((await readPrinted(stores)).size, 0);

    await change(stores);
    down = false;
    await packingEve(stores, opts(h, at(FRI, 15, 15)));

    const retry = h.sent.at(-1);
    const printed = await readPrinted(stores);

    assert.match(retry.subject, /on-farm pickups/);
    assert.deepEqual([...printed.keys()].sort(),
      ["NFF-2611-DSX1", "NFF-2611-OFX9"],
      "the order mailed on the failed run counts as printed");
    assert.equal(printed.get("NFF-2611-DSX1").date, SAT);
    await packingDaily(stores, opts(h, at(SAT, 6)));

    const late = h.sent.at(-1);

    assert.equal(late.subject, LATE_MARKET);

    return pdfOf(late);
  };

  it("cancels an order mailed on a failed run, after the retry",
    async () => {
      const pdf = await sentThenChanged((stores) => setStatus(stores,
        "NFF-2611-DSX1", "cancelled", at(FRI, 15, 5)));

      assert.match(pdf, /\(CANCELED\)/);
    });

  it("revises an order mailed on a failed run and moved before the retry",
    async () => {
      const pdf = await sentThenChanged((stores) => amendOrder(stores,
        "NFF-2611-DSX1", {
          fulfilment: { ...pickup().fulfilment, date: "2026-11-22" },
        }, "edited", at(FRI, 15, 5)));

      assert.match(pdf, /\(REVISED\)/);
    });

  it("tells the kind an order left, after its slip was printed",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, atDrop("NFF-2611-DSM1"), placed);
      await packingEve(stores, opts(h, at(FRI, 15)));
      await amendOrder(stores, "NFF-2611-DSM1", {
        fulfilment: occurrence("VFVQ", "2026-11-28"),
      }, "edited", at(FRI, 19));
      await packingDaily(stores, opts(h, at(SAT, 6)));

      const late = h.sent.at(-1);
      const pdf = pdfOf(late);

      assert.equal(late.subject, LATE_MARKET);
      assert.match(pdf, /\(REVISED\)/);
      assert.match(pdf, /Date: was Saturday, November 21, now Saturday, /);
    });
});
