// The daily packing slips (#292). Every order here is fake. The
// windows are in #616's full format ("9:00 AM – 12:00 PM"); the
// criteria copy that brought them in went live on 2026-11-18
// (77e5378c), and this header stopped calling it held out on
// 2026-11-20. That evening the tests that pinned what #694 (packing
// slips just in time, one email per fulfillment group) retires were
// rewritten onto the 3 PM packet for tomorrow and the 6 AM late slips,
// or deleted where the behavior itself is gone: Sunday's week and the
// 3 PM packet's later days (test/packing-groups.test.mjs pins those).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { samplePacket } from "../netlify/functions/lib/library.mjs";
import {
  MailError, OUTBOX_PREFIX, sendMail,
} from "../netlify/functions/lib/mail.mjs";
import {
  EVE, PENDING, PING_KEY, PRINTED, SENT, changedAfterPrint, changesBetween,
  choose, packetPdf, packingDaily, packingEve, paymentState, pickList,
  readPrinted, snapshotOf,
} from "../netlify/functions/lib/packing.mjs";
import {
  pdf, printable, widthOf, wrap,
} from "../netlify/functions/lib/pdf.mjs";
import {
  amendOrder, saveOrder, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { FOSTER_IN_PDF, FOSTER_NAME } from "./foster-name.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);
const URL = "https://hc-ping.example/packing-check";

// Tuesday 6 October 2026; the week's Sunday is the 11th.
const TUESDAY = "2026-10-06";
const placed = at("2026-10-05", 9);

const order = (id, {
  method = "delivery", date = "2026-10-08", lines, paid = true, ...over
} = {}) => {
  const items = lines || [
    { sku: "EGG-L", label: "Eggs, Large", qty: 2, lineTotal: 14 },
    { sku: "BB-1", label: "Boneless Breasts 1.0 – 1.2 lbs", qty: 1,
      lineTotal: 18 },
  ];
  const subtotal = items.reduce((s, l) => s + l.lineTotal * 100, 0);
  const fee = method === "delivery" ? 500 : 0;

  return {
    id, status: "paid",
    submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
    customer: {
      name: "Pat Example", email: "pat@example.com", phone: "401-555-0100",
    },
    lines: items,
    totals: {
      subtotal, discountAmount: 0, deliveryFee: fee, total: subtotal + fee,
    },
    fulfilment: {
      method, date,
      onfarm: method === "onfarm"
        ? { window: "09:00-12:00", from: "09:00", to: "12:00" } : null,
      delivery: method === "delivery" ? {
        address1: "1 Example Rd", town: "Foster", state: "RI", zip: "02825",
        cooler: "Porch",
      } : null,
    },
    payments: paid ? [{
      amount: subtotal + fee, via: "square", method: "card",
      at: placed.toISOString(), squarePaymentId: `PAY-${id}`,
    }] : [],
    square: { squareOrderId: `SQ-${id}` },
    emails: { orderConfirmed: { at: placed.toISOString() } },
    ...over,
  };
};

const FARM = { FARM_NOTIFICATIONS_EMAIL: "farm@example.com" };
// Production, sending for real, with the check configured.
const LIVE = { ...FARM, MAIL_DRIVER: "resend", [PING_KEY]: URL };

const harness = ({ failMail = false } = {}) => {
  const sent = [];
  const pings = [];

  return {
    sent, pings,
    mail: async (m) => {
      if (failMail) throw new Error("Resend 503");
      sent.push(m);

      return { id: `m${sent.length}` };
    },
    fetchImpl: async (url, init = {}) => {
      pings.push({ url, method: init.method || "GET", body: init.body });

      return new Response("OK", { status: 200 });
    },
  };
};

const run = (stores, h, now, env = LIVE) =>
  packingDaily(stores, { env, mail: h.mail, fetchImpl: h.fetchImpl, now });

const pdfText = (m) => Buffer.from(m.attachments[0].content, "base64")
  .toString("latin1");

// #694: the 3 PM packet for tomorrow and the 6 AM late slips, one email
// per fulfillment group. Wednesday 7 October at 3 PM is the packet for
// Thursday the 8th, the default order's day.
const WED = "2026-10-07";
const THU = "2026-10-08";
const STAGING = {
  ...FARM, SITE_CONTEXT: "staging", MAIL_DRIVER: "outbox", [PING_KEY]: URL,
};

// The 6 AM run and the 3 PM run. -> the emails that run sent.
const runOf = (fn) => async (stores, h, now, env = LIVE) => {
  const from = h.sent.length;

  await fn(stores, { env, mail: h.mail, fetchImpl: h.fetchImpl, now });

  return h.sent.slice(from);
};
const morning = runOf(packingDaily);
const evening = runOf(packingEve);

const save = (stores, orders, when = placed) => Promise.all(
  orders.map((o) => saveOrder(stores, o, when)));

// An email's one PDF, as text; "" when it has none.
const pdfOf = (m) => {
  assert.ok((m.attachments || []).length <= 1,
    `"${m.subject}" has one PDF at most`);

  return m.attachments && m.attachments.length ? pdfText(m) : "";
};
const everything = (m) => `${m.subject}\n${m.text}\n${pdfOf(m)}`;
const holding = (mails, id) => mails.find((m) => pdfOf(m).includes(id));
const subjects = (mails) => mails.map((m) => m.subject).join(" | ");
const count = (text, re) => (text.match(re) || []).length;

// The subjects are drafts, so only their form is tested:
// `{place} packing slips for {Weekday} {M/D}`, and a late marker.
const WEEKDAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const FORM = new RegExp(`^(.+) packing slips for (${WEEKDAYS}) ` +
  "(\\d{1,2})/(\\d{1,2})$");
const LATE = /\blate\b:?\s*/i;

// The form, for `day` ("Thursday 10/8"), not marked late.
const assertDay = (subject, day) => {
  const m = FORM.exec(subject);

  assert.ok(m, `"${subject}" reads {place} packing slips for {Weekday} ` +
    "{M/D}");
  assert.equal(`${m[2]} ${m[3]}/${m[4]}`, day, subject);
  assert.doesNotMatch(subject, LATE, `"${subject}" is not late`);
};

// The same form, marked late.
const assertLate = (subject, day) => {
  assert.match(subject, LATE, `"${subject}" is marked late`);

  const m = FORM.exec(subject.replace(LATE, "").trim());

  assert.ok(m, `"${subject}" reads late {place} packing slips for ...`);
  assert.equal(`${m[2]} ${m[3]}/${m[4]}`, day, subject);
};

// DEL-A went in Wednesday's 3 PM packet; DEL-L came in for Thursday at
// 7 PM, so Thursday's 6 AM run has a late slip to send.
const lateOne = async (stores, env = LIVE) => {
  await save(stores, [order("DEL-A")]);
  await evening(stores, harness(), at(WED, 15), env);
  await saveOrder(stores, order("DEL-L"), at(WED, 19));
};

describe("the PDF writer", () => {
  it("writes a PDF whose cross-reference points at every object", () => {
    const doc = pdf({ title: "T" });

    doc.page();
    doc.text("Eggs (Large) \\ × 2 – café", 54, 72, { bold: true });
    doc.page();
    doc.rect(54, 100, 100, 20, { fill: 0.9 });

    const out = doc.bytes().toString("latin1");
    const xref = Number(out.match(/startxref\n(\d+)/)[1]);
    const offsets = [...out.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)]
      .map((m) => Number(m[1]));

    assert.ok(out.startsWith("%PDF-1.4\n"));
    assert.ok(out.endsWith("%%EOF\n"));
    assert.equal(out.slice(xref, xref + 4), "xref");
    offsets.forEach((o, i) => assert.ok(
      out.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
    assert.match(out, /\/Count 2/);
    assert.ok(out.includes("(Eggs \\(Large\\) \\\\ \\327 2 \\226 caf\\351)"),
      "escaped, in WinAnsi");
  });

  it("prints what WinAnsi can't hold as ? and breaks long text", () => {
    assert.equal(printable("Eggs 🥚\nLarge"), "Eggs ? Large");
    assert.ok(widthOf("WWW", { bold: true }) > widthOf("iii"));
    assert.deepEqual(wrap("one two three", widthOf("one two")),
      ["one two", "three"]);
    assert.ok(wrap("x".repeat(200), 100).every((l) => widthOf(l) <= 100));
  });

  it("wraps a long unbroken note in time, and caps its rows", () => {
    const note = "é".repeat(2000);
    const all = wrap(note, 400, { size: 11 });
    const capped = wrap(note, 400, { size: 11, rows: 12 });

    // In time: eight times the note takes about eight times as long, not
    // the sixty-four a quadratic wrap would. The two sizes are timed
    // turn and turn about, best of five each, so a loaded machine slows
    // both sides alike (#159), and a run the full suite still disturbed
    // is measured again before it counts (#357).
    const timed = (long) => {
      const started = performance.now();

      wrap(long, 400, { size: 11 });

      return performance.now() - started;
    };
    const ratio = () => {
      const short = "é".repeat(500);
      const long = "é".repeat(4000);
      let shortest = Infinity;
      let longest = Infinity;

      timed(long);
      for (let i = 0; i !== 5; i += 1) {
        shortest = Math.min(shortest, timed(short));
        longest = Math.min(longest, timed(long));
      }

      return longest / shortest;
    };
    let seen = ratio();

    for (let i = 0; i !== 2 && seen >= 24; i += 1) seen = ratio();

    assert.ok(seen < 24, `8x the note took ${seen.toFixed(1)}x as long`);
    assert.equal(all.join(""), note, "nothing lost");
    assert.equal(capped.length, 12);
    assert.ok(capped[11].endsWith("…"));
    assert.ok(capped.every((l) => widthOf(l, { size: 11 }) <= 400));
    assert.deepEqual(wrap("WW", 1), ["W", "W"],
      "a glyph wider than the line still moves on");
  });
});

describe("what goes in a packet", () => {
  it("prints each new order once, and nothing on a quiet day after",
    async () => {
      const stores = testStores();
      const h = harness();

      await save(stores, [order("DEL-A"), order("FARM-B", {
        method: "onfarm",
      })]);

      const first = await evening(stores, h, at(WED, 15));
      const late = await morning(stores, h, at(THU, 6));
      const quiet = await evening(stores, h, at(THU, 15));

      assert.equal(first.length, 2, subjects(first));
      for (const m of first) {
        assertDay(m.subject, "Thursday 10/8");
        assert.deepEqual(m.to, ["farm@example.com"]);
        assert.equal(m.attachments.length, 1);
        assert.equal(m.attachments[0].contentType, "application/pdf");
        assert.match(m.attachments[0].filename, /\.pdf$/);
        assert.equal(count(pdfOf(m), /\(Your order\)/g), 1, m.subject);
      }
      assert.ok(holding(first, "DEL-A") !== holding(first, "FARM-B"),
        "each in its group's email");

      assert.deepEqual(late, [], "nothing came in after 3 PM");
      assert.equal(quiet.length, 1, subjects(quiet));
      assert.match(quiet[0].subject, /^no packing slips for Friday 10\/9$/i);
      assert.deepEqual(quiet[0].attachments || [], []);
      for (const id of ["DEL-A", "FARM-B"]) {
        assert.ok(!everything(quiet[0]).includes(id), `${id} once`);
      }
    });

  it("waits for 3 PM and 6:00 ET and sends once a day, across a clock " +
    "change", async () => {
    const stores = testStores();
    const h = harness();

    // Sunday 1 November is the first day of EST: 3 PM is 20:00 UTC and
    // Monday's 6:00 is 11:00 UTC.
    await save(stores, [order("FARM-M", {
      method: "onfarm", date: "2026-11-02",
    })]);

    const two59 = await evening(stores, h,
      new Date("2026-11-01T19:59:00.000Z"));
    const three = await evening(stores, h,
      new Date("2026-11-01T20:00:00.000Z"));
    const again = await evening(stores, h,
      new Date("2026-11-01T20:15:00.000Z"));

    await saveOrder(stores, order("FARM-L", {
      method: "onfarm", date: "2026-11-02",
    }), at("2026-11-01", 19));

    const five = await morning(stores, h,
      new Date("2026-11-02T10:59:00.000Z"));
    const six = await morning(stores, h,
      new Date("2026-11-02T11:00:00.000Z"));
    const later = await morning(stores, h,
      new Date("2026-11-02T11:15:00.000Z"));

    assert.deepEqual(two59, []);
    assert.equal(three.length, 1, subjects(three));
    assertDay(three[0].subject, "Monday 11/2");
    assert.deepEqual(again, []);
    assert.deepEqual(five, []);
    assert.equal(six.length, 1, subjects(six));
    assertLate(six[0].subject, "Monday 11/2");
    assert.ok(pdfOf(six[0]).includes("FARM-L"));
    assert.ok(!pdfOf(six[0]).includes("FARM-M"));
    assert.deepEqual(later, []);
    assert.equal(h.sent.length, 2);
  });

  it("sorts by date, then type, then pickup time", () => {
    const entries = choose({
      open: [
        order("P2", { method: "onfarm", onfarm: null, fulfilment: {
          method: "onfarm", date: "2026-10-08",
          onfarm: { window: "13:00-15:00", from: "13:00", to: "15:00" },
        } }),
        order("P1", { method: "onfarm" }),
        order("D", { date: "2026-10-08" }),
        order("S", { method: "scituate", date: "2026-10-07" }),
      ],
      printed: new Map(), gone: [], day: TUESDAY,
    });

    assert.deepEqual(entries.map((e) => e.order.id), ["S", "D", "P1", "P2"]);
  });

  it("totals the pick list across the slips", () => {
    const entries = [order("A"), order("B", {
      lines: [{ sku: "EGG-L", label: "Eggs, Large", qty: 1, lineTotal: 7 }],
    })].map((o) => ({ order: o, kind: "new", changes: [] }));

    assert.deepEqual(pickList(entries), [
      { label: "Boneless Breasts 1.0 – 1.2 lbs", qty: 1 },
      { label: "Eggs, Large", qty: 3 },
    ]);
  });
});

describe("changed and canceled orders", () => {
  it("prints a revision sheet and a fresh slip for a change, once",
    async () => {
      const stores = testStores();
      const h = harness();

      await save(stores, [order("DEL-A"), order("DEL-B")]);
      await evening(stores, h, at(WED, 15));
      await amendOrder(stores, "DEL-A", {
        lines: [{ sku: "EGG-L", label: "Eggs, Large", qty: 5, lineTotal: 35 }],
      }, "edited", at(WED, 19));

      const thu = await morning(stores, h, at(THU, 6));
      const again = await morning(stores, h, at(THU, 6, 15));
      const after = await changedAfterPrint(stores, {
        env: LIVE, mail: h.mail, now: at(THU, 9, 15),
      });

      assert.equal(thu.length, 1, subjects(thu));
      assertLate(thu[0].subject, "Thursday 10/8");

      const text = pdfOf(thu[0]);

      assert.match(text, /\(REVISED\)/);
      assert.match(text, /\(Eggs, Large: was 2, now 5\)/);
      assert.match(text, /\(Removed: 1 \\327 Boneless Breasts/);
      assert.equal(count(text, /\(Your order\)/g), 1,
        "only the changed order is printed again");
      assert.ok(text.includes("DEL-A"));
      assert.ok(!text.includes("DEL-B"));
      assert.deepEqual(again, []);
      assert.deepEqual(after, [], "the revision counts as printed");
    });

  it("names each kind of difference", () => {
    const before = snapshotOf(order("A"));
    const after = snapshotOf(order("A", {
      method: "onfarm", paid: false,
      customer: { name: "Pat Example", email: "new@example.com", phone: "" },
    }));
    const changes = changesBetween(before, after);

    assert.ok(changes.includes("Type: was Delivery, now On-farm pickup"));
    assert.ok(changes.some((c) => /^Window: was 10:00 AM – 4:00 PM, now /
      .test(c)));
    assert.ok(changes.includes("Contact details changed: see the new slip"));
    assert.ok(changes.includes("Total: was $37, now $32"));
    assert.ok(changes.includes("Payment: was PAID, now UNPAID ($32 due)"));
  });

  it("prints a CANCELED sheet with no slip for a printed order",
    async () => {
      const stores = testStores();
      const h = harness();

      await save(stores, [order("DEL-A")]);
      await evening(stores, h, at(WED, 15));
      // A new one, placed and cancelled after the packet, never was
      // printed and is left out.
      await saveOrder(stores, order("GHOST"), at(WED, 16));
      await setStatus(stores, "GHOST", "cancelled", at(WED, 17));
      await setStatus(stores, "DEL-A", "cancelled", at(WED, 18));

      const thu = await morning(stores, h, at(THU, 6));

      assert.equal(thu.length, 1, subjects(thu));
      assertLate(thu[0].subject, "Thursday 10/8");

      const text = pdfOf(thu[0]);

      assert.match(text, /\(CANCELED\)/);
      assert.doesNotMatch(text, /\(Your order\)/);
      assert.doesNotMatch(everything(thu[0]), /GHOST/);
      assert.equal((await readPrinted(stores)).get("DEL-A").snapshot.status,
        "cancelled");
      assert.deepEqual(await morning(stores, h, at(THU, 6, 15)), []);
      assert.deepEqual(await changedAfterPrint(stores, {
        env: LIVE, mail: h.mail, now: at(THU, 9, 15),
      }), [], "a cancellation is printed once");
    });

  it("says UNPAID, with what is due, for an order not paid in full",
    async () => {
      const stores = testStores();
      const h = harness();
      const owing = order("FARM-OWE", { method: "onfarm" });

      owing.payments[0].amount = 1000;
      await save(stores, [owing, order("FARM-OK", { method: "onfarm" })]);

      const mails = await evening(stores, h, at(WED, 15));

      assert.equal(mails.length, 1, subjects(mails));

      const text = pdfOf(mails[0]);

      assert.deepEqual(paymentState(owing),
        { paid: false, due: 2200, refunded: 0 });
      assert.deepEqual(paymentState({ ...order("L"), status: "submitted",
        payments: [] }),
      { paid: false, due: 3700, refunded: 0 }, "an old unpaid record");
      assert.match(text, /\(UNPAID\)/);
      assert.match(text, /\(Amount due at pickup: \$22\)/);
      assert.match(text, /\(PAID\)/);
    });

  it("shows only the farm's refunds, not a change's", () => {
    // The customer took items out: the total fell from $37 to $12 and
    // the $25 difference went back.
    const edited = order("E", {
      lines: [{ sku: "EGG-L", label: "Eggs, Large", qty: 1, lineTotal: 7 }],
    });

    edited.totals = { ...edited.totals, subtotal: 700, total: 1200 };
    edited.payments[0].amount = 3700;
    edited.refunds = [
      { amount: 2500, status: "COMPLETED", edit: "edit-1" },
    ];
    assert.deepEqual(paymentState(edited),
      { paid: true, due: 0, refunded: 0 }, "the total already fell");

    // The farm then refunds $5 for a cracked egg.
    edited.refunds.push({ amount: 500, status: "COMPLETED" });
    edited.refunds.push({ amount: 900, status: "FAILED" });
    assert.deepEqual(paymentState(edited),
      { paid: true, due: 0, refunded: 500 }, "a failed one returned nothing");
  });

  it("mails a change to an order due today after the packet, once",
    async () => {
      const stores = testStores();
      const h = harness();
      const env = LIVE;
      const now = at("2026-10-08", 6);

      await saveOrder(stores, order("TODAY"), placed);
      await saveOrder(stores, order("LATER", { date: "2026-10-15" }), placed);
      // Before the packet nothing is mailed: the packet carries it.
      assert.deepEqual(await changedAfterPrint(stores, {
        env, mail: h.mail, now,
      }), []);
      await run(stores, h, now);

      // The farm's refund, and a change to a later order.
      await amendOrder(stores, "TODAY", {
        refunds: [{ amount: 700, status: "COMPLETED", at: now.toISOString() }],
      }, "refunded", at("2026-10-08", 9));
      await amendOrder(stores, "LATER", { notes: "Ring twice" }, "edited",
        at("2026-10-08", 9));

      const first = await changedAfterPrint(stores, {
        env, mail: h.mail, now: at("2026-10-08", 9, 15),
      });
      const second = await changedAfterPrint(stores, {
        env, mail: h.mail, now: at("2026-10-08", 9, 30),
      });
      const m = h.sent[1];

      assert.deepEqual(first, ["TODAY"], "LATER waits for tomorrow's packet");
      assert.deepEqual(second, []);
      assert.equal(m.subject, "Changed after printing: TODAY");
      // A partial refund is its own line: the order is still paid.
      assert.match(m.text, /Refunded: was \$0, now \$7/);
      assert.doesNotMatch(m.text, /UNPAID/);
      assert.doesNotMatch(pdfText(m), /\(UNPAID\)/);
      assert.match(pdfText(m), /\(Refunded\)/);
      assert.match(pdfText(m), /\(REVISED\)/);
      assert.doesNotMatch(pdfText(m), /Pick list/, "no cover for one order");
    });
});

describe("Healthchecks", () => {
  it("pings the check once the packet has gone, quiet days too",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, order("A"), placed);
      await run(stores, h, at(TUESDAY, 6));
      await run(stores, h, at("2026-10-07", 6));

      assert.deepEqual(h.pings.map((p) => [p.url, p.method]),
        [[URL, "GET"], [URL, "GET"]]);
    });

  it("scrubs the error it posts to /fail", async () => {
    const stores = testStores();
    const h = harness();

    await lateOne(stores);
    await assert.rejects(morning(stores, {
      ...h, mail: async () => {
        throw new Error("rejected pat@example.com, 401-555-0100");
      },
    }, at(THU, 6)));

    assert.equal(h.pings.length, 1);
    assert.doesNotMatch(h.pings[0].body, /pat@example\.com|555-0100/);
    assert.match(h.pings[0].body, /\[email:/);
  });

  it("pings /fail when the packet can't go, and tries again next run",
    async () => {
      const stores = testStores();
      const down = harness({ failMail: true });

      await lateOne(stores);
      await assert.rejects(morning(stores, down, at(THU, 6)), /Resend 503/);

      assert.equal(down.pings.length, 1);
      assert.equal(down.pings[0].url, `${URL}/fail`);
      assert.equal(down.pings[0].method, "POST");
      assert.match(down.pings[0].body, /Resend 503/);
      assert.doesNotMatch(down.pings[0].body, /pat@example|Pat Example/,
        "no customer data in the ping");
      assert.ok(!(await readPrinted(stores)).has("DEL-L"),
        "nothing counts as printed");

      const up = harness();
      const retry = await morning(stores, up, at(THU, 6, 15));

      assert.equal(retry.length, 1, subjects(retry));
      assert.ok(pdfOf(retry[0]).includes("DEL-L"));
      assert.ok((await readPrinted(stores)).has("DEL-L"));
      assert.deepEqual(up.pings.map((p) => p.url), [URL]);
    });

  it("fails loudly when production sends without the key", async () => {
    const stores = testStores();
    const h = harness();
    const env = { ...FARM, MAIL_DRIVER: "resend" };

    await lateOne(stores, FARM);
    await assert.rejects(morning(stores, h, at(THU, 6), env),
      new RegExp(`${PING_KEY} is not set`));
    assert.equal(h.sent.length, 1, "the farm still gets its late slip");
    assert.ok(pdfOf(h.sent[0]).includes("DEL-L"));

    // In the jobs run it is an error: the jobs check fails and the
    // developer is alerted.
    const jobs = testStores();
    const j = harness();

    await lateOne(jobs, FARM);

    const report = await runJobs(jobs, {
      env: { ...env, DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
        HEALTHCHECKS_JOBS_URL: "https://hc-ping.example/jobs" },
      mail: j.mail, fetchImpl: j.fetchImpl, now: at(THU, 6),
    });

    assert.deepEqual(report.errors.map((e) => e.step), ["packing"]);
    assert.ok(j.pings.some((p) => p.url === "https://hc-ping.example/jobs/fail"));
  });

  it("requires the key for a production build (check:env)", async () => {
    const { readFileSync } = await import("node:fs");
    const { readSample } = await import("../bin/env/sample.mjs");
    const { missingAtBuild } = await import("../bin/env/netlify.mjs");
    const sample = (env) => readSample(
      readFileSync(`.env.${env}.sample`, "utf8"), env);

    assert.ok(missingAtBuild(sample("production"), {}).includes(PING_KEY));
    assert.ok(!sample("staging").keys.includes(PING_KEY),
      "staging has no packing check");
  });

  it("never pings from staging, even with a URL set", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [order("DEL-A")]);

    const three = await evening(stores, h, at(WED, 15), STAGING);

    await saveOrder(stores, order("DEL-L"), at(WED, 19));

    const six = await morning(stores, h, at(THU, 6), STAGING);

    assert.equal(three.length, 1, subjects(three));
    assert.equal(six.length, 1, subjects(six));
    assert.deepEqual(h.pings, []);
  });
});

describe("the mail seam's attachments", () => {
  const message = {
    to: "farm@example.com", subject: "Slips", text: "t", html: "<p>t</p>",
    attachments: [{
      filename: "p.pdf", contentType: "application/pdf",
      content: Buffer.from("%PDF").toString("base64"),
    }],
  };

  it("hands them to Resend", async () => {
    let body;
    const fetchImpl = async (url, init) => {
      body = JSON.parse(init.body);

      return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
    };

    await sendMail(message, {
      env: { MAIL_DRIVER: "resend", RESEND_API_KEY: "re_test",
        MAIL_FROM: "Farm <o@example.com>" },
      fetchImpl,
    });
    assert.deepEqual(body.attachments, [{
      filename: "p.pdf", content: "JVBERg==", "content_type": "application/pdf",
    }]);
  });

  it("keeps them in the staging outbox", async () => {
    const stores = testStores();

    await sendMail(message, { env: { MAIL_DRIVER: "outbox" }, stores });

    const [{ key }] = await stores.jobs.list(OUTBOX_PREFIX);

    assert.deepEqual((await stores.jobs.get(key)).attachments,
      message.attachments);
  });
});

describe("scheduled pickups in a packet", () => {
  const sched = (id, occurrence, date, over = {}) => order(id, {
    method: "scheduled", date,
    fulfilment: { method: "scheduled", occurrence, date, onfarm: null,
      delivery: null },
    ...over,
  });

  it("stacks each occurrence together, and slips name it", async () => {
    const entries = choose({
      open: [
        sched("M2", "WAC5-261025", "2026-10-25"),
        sched("D1", "VFVQ-261017", "2026-10-17"),
        order("F", { method: "onfarm", date: "2026-10-17" }),
        sched("M1", "WAC5-261025", "2026-10-25"),
        sched("D2", "VFVQ-261017", "2026-10-17"),
      ],
      printed: new Map(), gone: [], day: TUESDAY,
    });

    assert.deepEqual(entries.map((e) => e.order.id),
      ["D1", "D2", "F", "M1", "M2"]);

    const text = packetPdf({ entries, now: at(TUESDAY, 6), title: "T" })
      .toString("latin1");

    assert.ok(text.includes(FOSTER_IN_PDF), "the series' name");
    assert.ok(text.includes("Shady Acres Diner"), "its place");
    assert.ok(text.includes("(Your order)"));
  });

  it("names the old and new occurrence of a move", () => {
    const was = snapshotOf(sched("A", "VFVQ-261017", "2026-10-17"));
    const now = snapshotOf(sched("A", "WAC5-261025", "2026-10-25"));
    const changes = changesBetween(was, now);

    assert.ok(changes.includes(`Pickup: was Drop site, now ${FOSTER_NAME}`),
      changes.join("; "));
    assert.ok(!changes.some((c) => /^Type:/.test(c)));
  });

  // The drop site's Saturday 17 October, printed Friday at 3 PM; then
  // its printed record as an older deploy wrote it, edited by `edit`.
  const printedThen = async (stores, h, edit) => {
    await save(stores, [sched("DROP-A", "VFVQ-261017", "2026-10-17")]);

    const three = await evening(stores, h, at("2026-10-16", 15));

    assert.equal(three.length, 1, subjects(three));

    const key = `${PRINTED}DROP-A`;
    const record = await stores.jobs.get(key);
    const snapshot = { ...record.snapshot };

    edit(snapshot);
    await stores.jobs.set(key, { ...record, snapshot });
  };

  // Neither the 6 AM run nor "Changed after printing" reads it as
  // changed.
  const unchanged = async (stores, h) => {
    assert.deepEqual(await morning(stores, h, at("2026-10-17", 6)), [],
      "nothing late");
    assert.deepEqual(await changedAfterPrint(stores, {
      env: LIVE, mail: h.mail, now: at("2026-10-17", 9, 15),
    }), [], "nothing changed after printing");
  };

  it("reads a renamed series or a migrated method as unchanged", async () => {
    const stores = testStores();
    const h = harness();

    await printedThen(stores, h, (s) => {
      s.name = "Old name";
      s.method = "scituate";
    });
    await unchanged(stores, h);
  });

  it("does not read a snapshot from before the occurrence as changed",
    async () => {
      const stores = testStores();
      const h = harness();

      await printedThen(stores, h, (s) => {
        delete s.occurrence;
        delete s.name;
      });
      await unchanged(stores, h);
    });

  it("names the occurrence on a canceled sheet", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [sched("FOS-A", "WAC5-261025", "2026-10-25")]);
    await evening(stores, h, at("2026-10-24", 15));
    await setStatus(stores, "FOS-A", "cancelled", at("2026-10-24", 18));

    const sun = await morning(stores, h, at("2026-10-25", 6));

    assert.equal(sun.length, 1, subjects(sun));
    assertLate(sun[0].subject, "Sunday 10/25");

    const text = pdfOf(sun[0]);

    assert.match(text, /\(CANCELED\)/);
    assert.ok(text.includes(FOSTER_IN_PDF));
    assert.ok(!text.includes("undefined"));
  });

  it("lists each occurrence's orders under it, in its own email",
    async () => {
      const stores = testStores();
      const h = harness();

      await save(stores, [
        sched("DROP-A", "VFVQ-261017", "2026-10-17"),
        sched("DROP-B", "VFVQ-261017", "2026-10-17"),
      ]);

      const [drop] = await evening(stores, h, at("2026-10-16", 15));

      await save(stores, [sched("FOS-C", "WAC5-261025", "2026-10-25")]);

      const [foster] = await evening(stores, h, at("2026-10-24", 15));

      assert.match(drop.text,
        /\nDrop site, Saturday, October 17, 46 Institute Lane/);
      assert.match(drop.text, /\n- DROP-A\b/);
      assert.match(drop.text, /\n- DROP-B\b/);
      assert.doesNotMatch(drop.text, /FOS-C/);
      assert.match(foster.text,
        new RegExp(`\n${FOSTER_NAME}, Sunday, October 25, Shady`));
      assert.match(foster.text, /9:00 AM – 1:00 PM\n- FOS-C\b/);
      assert.doesNotMatch(foster.text, /DROP-/);
      for (const m of [drop, foster]) {
        assert.doesNotMatch(m.text, /Market pickup/);
      }
    });
});

describe("the library's sample packet", () => {
  it("builds from fake orders, every kind of sheet", () => {
    const { entries, now } = samplePacket();
    const text = packetPdf({ entries, now, title: "Sample" })
      .toString("latin1");

    assert.deepEqual(entries.map((e) => e.kind).sort(),
      ["cancelled", "changed", "new", "new", "new", "new"]);
    for (const word of ["(PAID)", "(UNPAID)", "(REVISED)", "(CANCELED)",
      "(Pick list)"]) {
      assert.ok(text.includes(word), word);
    }
    assert.ok(entries.every((e) => !e.order.customer
      || e.order.customer.email.endsWith("@example.com")), "fake people");
  });
});

describe("when the packet goes, and going once", () => {
  it("gives an unpaid order a slip, marked UNPAID with what is due",
    async () => {
      const stores = testStores();
      const h = harness();

      await save(stores, [{
        ...order("DEL-OLD", { paid: false }), status: "submitted",
      }]);

      const mails = await evening(stores, h, at(WED, 15));

      assert.equal(mails.length, 1, subjects(mails));

      const text = pdfOf(mails[0]);

      assert.equal(count(text, /\(Your order\)/g), 1);
      assert.match(text, /\(UNPAID\)/);
      assert.match(text, /\(Amount due at delivery: \$37\)/);
    });

  it("waits for the next morning when it starts after 10:00", async () => {
    const stores = testStores();
    const h = harness();

    // Monday's 3 PM packet had nothing for Tuesday; FARM-T came in for
    // Tuesday that evening. The release lands Tuesday mid-afternoon:
    // FARM-T's morning is past, and nothing goes until 6:00 Wednesday.
    await evening(stores, h, at("2026-10-05", 15));
    await saveOrder(stores, order("FARM-T", {
      method: "onfarm", date: TUESDAY,
    }), at("2026-10-05", 19));

    const tue = await morning(stores, h, at(TUESDAY, 14, 30));

    await evening(stores, h, at(TUESDAY, 15));
    await saveOrder(stores, order("FARM-W", {
      method: "onfarm", date: WED,
    }), at(TUESDAY, 19));

    const early = await morning(stores, h, at(WED, 5, 45));
    const six = await morning(stores, h, at(WED, 6));

    assert.deepEqual(tue, []);
    assert.deepEqual(early, []);
    assert.equal(six.length, 1, subjects(six));
    assertLate(six[0].subject, "Wednesday 10/7");
    assert.ok(pdfOf(six[0]).includes("FARM-W"));
    assert.ok(!everything(six[0]).includes("FARM-T"));
  });

  it("retries with the same orders and the same body", async () => {
    const stores = testStores();
    const h = harness();
    let firstBody = null;

    await lateOne(stores);
    await assert.rejects(morning(stores, {
      ...h, mail: async (m) => {
        firstBody = m;
        throw new Error("timed out");
      },
    }, at(THU, 6)));

    // A failed try after 10:00 still retries; an order new since waits.
    await saveOrder(stores, order("DEL-N"), at(THU, 6, 5));

    const retry = await morning(stores, h, at(THU, 11));

    assert.equal(retry.length, 1, subjects(retry));

    const [m] = retry;

    assert.equal(m.idempotencyKey, firstBody.idempotencyKey);
    assert.equal(m.subject, firstBody.subject);
    assert.equal(m.text, firstBody.text);
    assert.equal(m.attachments[0].content, firstBody.attachments[0].content,
      "the same PDF, stamped with the first try's time");
    assert.ok(pdfOf(m).includes("DEL-L"));
    assert.ok(!everything(m).includes("DEL-N"));
    assert.ok(!(await readPrinted(stores)).has("DEL-N"),
      "DEL-N is not printed by the retry");
    assert.deepEqual(await morning(stores, h, at(THU, 11, 15)), [], "once");
  });

  it("counts Resend's refusal of a resent key as sent", async () => {
    const stores = testStores();
    const h = harness();

    await lateOne(stores);
    await assert.rejects(morning(stores, harness({ failMail: true }),
      at(THU, 6)));
    // DEL-L went out on that try after all; then it changed.
    await amendOrder(stores, "DEL-L", { notes: "Ring twice" }, "edited",
      at(THU, 6, 5));

    await morning(stores, {
      ...h, mail: async () => {
        throw new MailError("Resend 409", {
          status: 409, detail: { name: "invalid_idempotent_request" },
        });
      },
    }, at(THU, 6, 15));

    assert.deepEqual(h.pings.map((p) => p.url), [URL]);
    assert.ok((await readPrinted(stores)).has("DEL-L"));
    assert.deepEqual(await morning(stores, h, at(THU, 6, 30)), [],
      "counted as sent");

    // What was printed is the first try's DEL-L, so the change shows.
    assert.deepEqual(await changedAfterPrint(stores, {
      env: LIVE, mail: h.mail, now: at(THU, 9, 15),
    }), ["DEL-L"]);
  });
});

describe("the 3 PM packet the day before (#515)", () => {
  const THURSDAY = "2026-10-08";
  const eve = (stores, h, now, env = LIVE) =>
    packingEve(stores, { env, mail: h.mail, fetchImpl: h.fetchImpl, now });

  it("leaves the morning only what came in or changed after it",
    async () => {
      const stores = testStores();
      const h = harness();

      await save(stores, [
        order("DEL-A"), order("DEL-C"),
        order("FARM-B", { method: "onfarm" }),
        order("FARM-D", { method: "onfarm" }),
      ]);
      await evening(stores, h, at(WED, 15));
      // After the packet: DEL-E comes in, DEL-A changes, FARM-B is
      // cancelled. DEL-C and FARM-D don't change.
      await saveOrder(stores, order("DEL-E"), at(WED, 16));
      await amendOrder(stores, "DEL-A", { notes: "Ring twice" }, "edited",
        at(WED, 16));
      await setStatus(stores, "FARM-B", "cancelled", at(WED, 16));

      const thu = await morning(stores, h, at(THU, 6));

      assert.equal(thu.length, 2, subjects(thu));
      thu.forEach((m) => assertLate(m.subject, "Thursday 10/8"));

      const del = holding(thu, "DEL-E");
      const farm = holding(thu, "FARM-B");

      assert.ok(del && farm && del !== farm, subjects(thu));

      const text = pdfOf(del);
      const farmText = pdfOf(farm);

      // The changed order: its revision sheet, a full slip, and Revised
      // on the cover; the cancelled one: CANCELED on the cover, no slip.
      assert.ok(text.includes("DEL-A"));
      assert.ok(!text.includes("DEL-C"), "DEL-C went at 3 PM");
      assert.match(text, /\(Revised\)/);
      assert.match(text, /\(REVISED\)/);
      assert.match(text, /Notes or delivery instructions changed/);
      assert.match(text, /The new packing slip follows\. Throw away the/);
      assert.equal(count(text, /\(Your order\)/g), 2, "DEL-A and DEL-E");
      assert.match(farmText, /\(CANCELED\)/);
      assert.match(farmText, /\(This order is canceled\. Don't pack it, and/);
      assert.doesNotMatch(farmText, /\(Your order\)/);
      assert.ok(!farmText.includes("FARM-D"), "FARM-D went at 3 PM");
    });

  it("sends nothing at 6 AM when nothing changed since 3 PM, and still " +
    "pings", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [order("DEL-A"), order("FARM-B", {
      method: "onfarm",
    })]);
    await evening(stores, h, at(WED, 15));

    const thu = await morning(stores, h, at(THU, 6));

    assert.deepEqual(thu.map((m) => m.subject), []);
    assert.deepEqual(h.pings.map((p) => p.url), [URL],
      "the morning's check, as every day; 3 PM leaves it to the morning");
  });

  it("cuts off when the packet is fixed, not when it goes", async () => {
    const stores = testStores();
    const down = harness({ failMail: true });
    const up = harness();

    await saveOrder(stores, order("A"), placed);
    await assert.rejects(eve(stores, down, at("2026-10-07", 15)),
      /Resend 503/);
    assert.deepEqual(down.pings.map((p) => p.url), [`${URL}/fail`]);
    // Placed between the failed try and its retry: the retry sends the
    // packet as first fixed, and the morning has the new order.
    await saveOrder(stores, order("LATE"), at("2026-10-07", 15, 5));

    const retry = await eve(stores, up, at("2026-10-07", 15, 15));
    const record = await stores.jobs.get(`${EVE}${THURSDAY}`);
    const thu = await run(stores, up, at(THURSDAY, 6));

    assert.equal(retry.slips, 1);
    assert.equal(record.cutoff, at("2026-10-07", 15).toISOString());
    assert.equal(await stores.jobs.get(`${PENDING}${THURSDAY}-eve`), null);
    assert.equal(thu.slips, 1);
    assert.deepEqual((await stores.jobs.get(`${SENT}${THURSDAY}`)).ids,
      ["LATE"]);
    assert.deepEqual(up.pings.map((p) => p.url), [URL],
      "a 3 PM success leaves the check to the morning");
  });

  it("leaves an order saved while it sends to the morning", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("A"), placed);
    await eve(stores, {
      ...h, mail: async (m) => {
        await saveOrder(stores, order("LATE"), at("2026-10-07", 15, 1));

        return h.mail(m);
      },
    }, at("2026-10-07", 15));

    const thu = await run(stores, h, at(THURSDAY, 6));

    assert.deepEqual((await stores.jobs.get(`${EVE}${THURSDAY}`)).ids,
      ["A"]);
    assert.equal(thu.slips, 1);
    assert.deepEqual((await stores.jobs.get(`${SENT}${THURSDAY}`)).ids,
      ["LATE"]);
  });

  it("retries a packet started by 9 PM after 9 PM", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("A"), placed);
    await assert.rejects(eve(stores, harness({ failMail: true }),
      at("2026-10-07", 20, 45)), /Resend 503/);
    // A new order waits for the morning.
    await saveOrder(stores, order("B"), at("2026-10-07", 21));

    const retry = await eve(stores, h, at("2026-10-07", 21, 15));

    assert.equal(retry.slips, 1);
    assert.deepEqual((await stores.jobs.get(`${EVE}${THURSDAY}`)).ids,
      ["A"]);
    assert.equal(await stores.jobs.get(`${PENDING}${THURSDAY}-eve`), null);
    assert.equal(await eve(stores, h, at("2026-10-07", 21, 30)), null);
  });

  it("says when nothing is due tomorrow, and waits after 9 PM", async () => {
    const stores = testStores();
    const h = harness();

    assert.deepEqual(await evening(stores, h, at(WED, 21)), []);

    const quiet = await evening(stores, h, at(WED, 20, 45));

    assert.equal(quiet.length, 1, subjects(quiet));
    assert.match(quiet[0].subject, /^no packing slips for Thursday 10\/8$/i);
    assert.deepEqual(quiet[0].attachments || [], []);
  });

  it("goes from the 15-minute run", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [order("DEL-A")]);
    await runJobs(stores, {
      env: FARM, mail: h.mail, now: at(WED, 15), fetchImpl: h.fetchImpl,
    });

    const slips = h.sent.filter((m) => FORM.test(m.subject));

    assert.equal(slips.length, 1, subjects(h.sent));
    assertDay(slips[0].subject, "Thursday 10/8");
    assert.ok(pdfOf(slips[0]).includes("DEL-A"));
  });
});

// #616's shared label (2026-11-18). A slip printed before the deploy
// keeps its snapshot as stored, the window in the old format ("9 AM –
// noon"). The snapshot is not rewritten and its shape does not change;
// the comparison treats the same times in either format as the same.
describe("a printed snapshot from before the full format (#616)", () => {
  const sched = (id, occurrence, date) => order(id, {
    method: "scheduled", date,
    fulfilment: { method: "scheduled", occurrence, date, onfarm: null,
      delivery: null },
  });

  // Each way of getting an order, with the window its snapshot held
  // when the slip was printed in the old format.
  const OLD = [
    ["on-farm", order("F", { method: "onfarm" }), "9 AM – noon"],
    ["scheduled", sched("D", "VFVQ-261017", "2026-10-17"), "10 – 11 AM"],
    ["delivery", order("V"), "10 AM – 4 PM"],
  ];

  const printedAs = (o, window) => new Map([[o.id, {
    snapshot: { ...snapshotOf(o), window },
  }]]);

  it("an old-format printed snapshot is not a change", () => {
    for (const [kind, o, window] of OLD) {
      const entries = choose({
        open: [o], printed: printedAs(o, window), gone: [], day: TUESDAY,
      });

      assert.deepEqual(entries.map((e) => e.kind), [],
        `${kind}: "${window}" printed, the same times now`);
    }
  });

  it("a real change of time still shows, the new time in the full format",
    () => {
      const moved = order("F", { method: "onfarm" });

      moved.fulfilment.onfarm = {
        window: "13:00-17:00", from: "13:00", to: "17:00",
      };

      const entries = choose({
        open: [moved], printed: printedAs(moved, "9 AM – noon"), gone: [],
        day: TUESDAY,
      });

      assert.deepEqual(entries.map((e) => e.kind), ["changed"]);
      assert.ok(entries[0].changes.includes(
        "Window: was 9 AM – noon, now 1:00 – 5:00 PM"
      ), JSON.stringify(entries[0].changes));
    });

  it("changesBetween never prints a line whose only difference is the " +
    "format", () => {
    for (const [kind, o, window] of OLD) {
      const now = snapshotOf(o);
      const changes = changesBetween({ ...now, window }, now);

      assert.deepEqual(changes.filter((c) => /^Window:/.test(c)), [],
        `${kind}: "${window}" against "${now.window}"`);
    }
  });
});
