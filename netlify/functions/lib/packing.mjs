// The packing slips, just in time (#694, 2026-11-20; it replaced the
// 6:00 AM packet of #292 with its Sunday week, and #515's 3 PM packet
// with later days' slips in it). A day's slips go to the farm twice,
// one email per kind of fulfillment (James's revision of #694,
// 2026-11-20): on-farm pickups; market/drop site pickups (the drop
// site, each market and each pop-up, together); deliveries. Each email
// has one PDF holding all of that kind's slips with its pick list, and
// a kind with nothing to print gets no email:
//
//   3:00 PM the day before   every slip for that day, and only that
//                            day: a new one, a revised one, a reprint
//                            of one printed earlier and unchanged, a
//                            CANCELED sheet for one printed and since
//                            cancelled. "Packing slips: on-farm
//                            pickups for Saturday, 11/21"
//   6:00 AM the day itself   what came in, changed or was cancelled
//                            after the 3 PM packet, each order marked
//                            so. "Packing slips — new since yesterday:
//                            deliveries for Saturday, 11/21"
//
// A 3 PM packet that fails is retried by every 15-minute run, as the
// on-time email, until it goes or the 6 AM run comes. From then on it
// is never sent (James, 2026-11-21): the 6 AM run counts it as
// printed, sends only what is late against it and pings the check's
// /fail, so there is no catch-up email and no order is printed twice.
// The subjects and bodies are
// James's words (`farmPackingSlips` in templates.mjs); the kinds are
// `PACKING_KINDS` in describe.mjs, and the email lists each place
// under its kind with its count
// (`packingGroup`: "North Scituate drop site", "Thanksgiving Prep
// pop-up"). An order moved off the day after its slip was printed
// goes, with its revision sheet, to the kind and place its old slip
// is in.
//
// What was printed is kept per order in the jobs store,
// `packing/printed/<id>`: a snapshot of what its slip showed. A
// reprint comes from comparing the order with that snapshot, never
// from timestamps, so a change by any path is caught. Contact
// details, the address and the customer's notes are kept only as a
// hash: the snapshot says that they changed, the fresh slip says what
// they are now. `packing/eve/<day>` (the day the slips are for) marks
// the 3 PM packet sent, and its `cutoff` is the time of the run that
// fixed it. `packing/sent/<day>` marks the 6 AM packet sent; both keep
// the kinds mailed as `kinds` and the orders as `ids`. A packet being
// retried waits in `packing/pending/<day>` (`<day>-eve` at 3 PM).
//
// After the 6 AM packet, an order due that day that changes anyway
// (the farm's CLI, a refund from Square or PayPal) is mailed at once
// as "Changed after printing", from the next 15-minute run.
//
// The 6 AM run pings HEALTHCHECKS_PACKING_URL (production only) once,
// late slips or none; either run pings its /fail when any kind's email
// could not be built or sent.

import { createHash } from "node:crypto";

import terms from "../../../data/delivery.json" with { type: "json" };
import signatures from "../../../data/signatures.json" with { type: "json" };
import { pickupTimes } from "../../../assets/scripts/order/lib/schedule.mjs";
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, label, parts, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { METHODS } from "./checkout.mjs";
import { company } from "./company.mjs";
import {
  methodName, packetCounts, packingGroup, packingKind, placeOf, shortDay,
} from "./describe.mjs";
import { isScheduled } from "../../../assets/scripts/order/lib/dates.mjs";
import { ping } from "./health.mjs";
import { now as clock } from "./clock.mjs";
import { log, scrub } from "./log.mjs";
import { MailError, farmEmails, sendMail } from "./mail.mjs";
import {
  configured as paypalConfigured, venmoHidden,
} from "./paypal.mjs";
import { pdf, widthOf, wrap } from "./pdf.mjs";
import {
  allOrders, dueOn, getOrder, paymentsOf, settledRefunds,
} from "./records.mjs";
import { resendAllowed } from "./resend-guard.mjs";
import { mailLinks } from "./site.mjs";
import { mark, wordmark } from "./slip-assets.mjs";
import {
  farmChangedAfterPrint, farmPackingSlips,
} from "./templates.mjs";

const tz = terms.timeZone;

export const PACKING_HOUR = 6;
// A day's packet starts no later than this hour, so a release or an
// outage late in the day waits for the next morning. Once started,
// it is retried until it goes.
export const PACKING_LAST_HOUR = 10;
export const KEEP_DAYS = 30;
export const PRINTED = "packing/printed/";
export const SENT = "packing/sent/";
export const CHANGED = "packing/changed/";
export const PENDING = "packing/pending/";
// The packet the day before (#515): from 3 PM, and started no later
// than 9 PM, so a late start waits for the morning's packet instead.
export const EVE_HOUR = 15;
export const EVE_LAST_HOUR = 21;
export const EVE = "packing/eve/";
// "3 PM" and "6 AM", as the emails name the two packets.
const clockOf = (hour) => `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;

export const EVE_TIME = clockOf(EVE_HOUR);
export const PACKING_TIME = clockOf(PACKING_HOUR);

const printedKey = (id) => `${PRINTED}${id}`;

// The order the slips stack in, within a day.
const METHOD_ORDER = ["delivery", "scheduled", "scituate", "market",
  "onfarm"];

const hash = (...values) => createHash("sha256")
  .update(JSON.stringify(values)).digest("hex").slice(0, 16);

// --- Money ------------------------------------------------------------

// PAID when the payments cover the total, from the money on the
// record rather than its status: an order from before checkout moved
// onto the page may still be `submitted`, unpaid. A refund never makes
// an order owe: the total is what was ordered, and what went back is
// its own line.
//
// That line counts only refunds off the total as it stands: the farm's
// (`orders refund`) or one noted from Square or PayPal. A customer's
// change that took items out lowered the total already and refunded
// the difference (its refund carries `edit`), so counting it again
// would read as money kept back.
export const paymentState = (order) => {
  const due = dueOn(order);
  const refunded = settledRefunds(order).filter((r) => !r.edit)
    .reduce((s, r) => s + (r.amount || 0), 0);

  return { paid: due === 0, due, refunded };
};

const paidWord = (state) => (state.paid ? "PAID" : "UNPAID");

// --- Snapshots ----------------------------------------------------------

const instructions = (order) => {
  const d = order.fulfilment.delivery || {};

  return [d.cooler, d.gate, d.notes, order.notes].map((s) => s || "");
};

// What a slip shows, in a form that compares. -> the snapshot.
export const snapshotOf = (order) => {
  const where = placeOf(order);
  const state = paymentState(order);

  return {
    status: order.status,
    lines: order.lines.map((l) => ({
      sku: l.sku, label: l.label, qty: l.qty,
    })),
    method: where.method,
    // Which occurrence, and the farm's name for it, so a move between
    // two shows by name and a cancelled sheet can name it.
    ...where.occurrence && { occurrence: where.occurrence, name: where.name },
    date: order.fulfilment.date,
    window: where.window,
    place: hash(where.place),
    notes: hash(instructions(order)),
    contact: hash(order.customer.name, order.customer.phone,
      order.customer.email),
    total: order.totals.total,
    discount: order.totals.discountAmount || 0,
    paid: state.paid,
    due: state.due,
    refunded: state.refunded,
  };
};

// The kind of pickup a snapshot shows: a Stage 1 `scituate` or `market`
// and a `scheduled` one are the same kind.
const kindOf = (snap) => (isScheduled(snap) ? "scheduled" : snap.method);

// A window's times, however its label was written: "9 AM – noon"
// (slips printed before #616) and "9:00 AM – 12:00 PM" are both
// "09:00-12:00". A stored snapshot keeps its label as printed; only the
// comparison reads through it. Anything else comes back as it is.
const END = /^(?:(noon|midnight)|(\d{1,2})(?::(\d{2}))?(?:\s*([AP]M))?)$/i;

export const windowTimes = (window) => {
  const ends = String(window || "").split(/\s*–\s*/)
    .map((end) => END.exec(end.trim()));

  if (ends.length !== 2 || ends.some((m) => !m)) return window;

  const half = (m) => (m[1]
    ? { noon: "PM", midnight: "AM" }[m[1].toLowerCase()]
    : m[4] && m[4].toUpperCase());
  const shared = half(ends[1]);
  const time = (m) => {
    const pm = (half(m) || shared) === "PM";
    const hour = m[1] ? 12 : Number(m[2]);

    return `${String((hour % 12) + (pm ? 12 : 0)).padStart(2, "0")}:${
      m[3] || "00"}`;
  };

  return shared ? ends.map(time).join("-") : window;
};

// A snapshot printed before it carried the occurrence has no such key;
// that alone is not a change. Nor is the farm's name for the place (a
// series renamed), the old and new spelling of a scheduled method, or
// the old and new writing of the same window (#616).
const same = (a, b) => {
  const strip = (s, drop) => ({
    ...s, method: kindOf(s), name: undefined,
    window: windowTimes(s.window),
    ...drop && { occurrence: undefined },
  });

  return JSON.stringify(strip(a, a.occurrence === undefined))
    === JSON.stringify(strip(b, a.occurrence === undefined));
};

const linesOf = (snap) => new Map(snap.lines.map((l) => [l.sku, l]));

// Each difference between what was printed and the order now, as a
// line for the revision sheet.
export const changesBetween = (before, after) => {
  const out = [];
  const was = linesOf(before);
  const now = linesOf(after);

  for (const [sku, l] of now) {
    const old = was.get(sku);

    if (!old) out.push(`Added: ${l.qty} × ${l.label}`);
    else if (old.qty !== l.qty) {
      out.push(`${l.label}: was ${old.qty}, now ${l.qty}`);
    }
  }
  for (const [sku, l] of was) {
    if (!now.has(sku)) out.push(`Removed: ${l.qty} × ${l.label}`);
  }
  const kind = (snap) => (isScheduled(snap) ? "scheduled" : snap.method);
  const named = (snap) => snap.name || methodName(kind(snap));

  if (kind(before) !== kind(after)) {
    out.push(`Type: was ${named(before)}, now ${named(after)}`);
  } else if (before.occurrence && after.occurrence
    && before.occurrence !== after.occurrence) {
    out.push(`Pickup: was ${named(before)}, now ${named(after)}`);
  }
  if (before.date !== after.date) {
    out.push(`Date: was ${label(before.date)}, now ${label(after.date)}`);
  }
  if (windowTimes(before.window) !== windowTimes(after.window)) {
    out.push(`Window: was ${before.window || "none"}, now ${
      after.window || "none"}`);
  }
  if (before.place !== after.place && kind(before) === kind(after)
    && before.occurrence === after.occurrence) {
    out.push("Place or address changed: see the new slip");
  }
  if (before.notes !== after.notes) {
    out.push("Notes or delivery instructions changed: see the new slip");
  }
  if (before.contact !== after.contact) {
    out.push("Contact details changed: see the new slip");
  }
  if (before.discount !== after.discount) {
    out.push(`Discount: was ${dollars(before.discount)}, now ${
      dollars(after.discount)}`);
  }
  if (before.total !== after.total) {
    out.push(`Total: was ${dollars(before.total)}, now ${
      dollars(after.total)}`);
  }
  if (before.paid !== after.paid || before.due !== after.due) {
    const word = (s) => (s.paid ? "PAID" : `UNPAID (${dollars(s.due)} due)`);

    out.push(`Payment: was ${word(before)}, now ${word(after)}`);
  }
  if ((before.refunded || 0) !== (after.refunded || 0)) {
    out.push(`Refunded: was ${dollars(before.refunded || 0)}, now ${
      dollars(after.refunded || 0)}`);
  }

  return out;
};

export const readPrinted = async (stores) => {
  const keys = await stores.jobs.list(PRINTED);
  const records = await Promise.all(
    keys.map(({ key }) => stores.jobs.get(key))
  );

  return new Map(records.filter(Boolean).map((r) => [r.id, r]));
};

// --- Choosing the sheets -----------------------------------------------
//
// An entry is { order, kind, changes }: kind "new" (a slip), "changed"
// (a revision sheet, then a slip), "reprint" (a slip again for an order
// already printed and unchanged) or "cancelled" (a sheet, no slip).
// `order` for a cancelled entry is the record as it stands, or the
// snapshot when the record is gone. `reprint(date)` says which
// printed, unchanged orders get their slip again: none by default
// (#694 ended Sunday's reprint of the week).

export const choose = ({ open, printed, gone, day, reprint = () => false }) => {
  const entries = [];

  for (const order of open) {
    const date = order.fulfilment.date;

    if (date < day) continue;

    const was = printed.get(order.id);
    const now = snapshotOf(order);

    if (!was) {
      entries.push({ order, kind: "new", changes: [] });
    } else if (!same(was.snapshot, now)) {
      entries.push({
        order, kind: "changed", changes: changesBetween(was.snapshot, now),
      });
    } else if (reprint(date)) {
      entries.push({ order, kind: "reprint", changes: [] });
    }
  }
  for (const { record, order } of gone) {
    entries.push({ order: order || record, kind: "cancelled", changes: [] });
  }

  return entries.sort(byFulfillment);
};

// The sheets for `day` alone (#694): each order due that day, and each
// whose printed slip was for that day though it has moved since, so
// the farm hears of the move where the old slip sits. `reprint` gives
// a printed and unchanged order its slip again, as the 3 PM packet's
// whole set for the day does; the 6 AM packet's late slips leave it
// out.
export const chooseDay = ({ open, printed, gone, day, reprint = false }) =>
  choose({ open, printed, gone, day, reprint: () => reprint })
    .filter((e) => e.order.fulfilment.date === day
      || (e.kind !== "reprint"
        && (printed.get(e.order.id) || {}).date === day));

// Where an entry's sheets go: its order's fulfilment, or, for one moved
// off `day`, what its printed slip showed.
const fulfilmentOf = (e, printed, day) => {
  const was = printed.get(e.order.id);

  return e.order.fulfilment.date !== day && was
    ? {
      method: was.snapshot.method, date: was.date,
      ...was.snapshot.occurrence && { occurrence: was.snapshot.occurrence },
    }
    : e.order.fulfilment;
};

// The entries by kind of fulfillment, one email each, and within each
// kind by place, in the order the slips stack.
// -> [{ key, noun, on, orders, title, entries,
//       places: [{ key, place, entries }] }].
export const kindsOf = (entries, printed, day) => {
  const kinds = new Map();

  for (const e of entries) {
    const f = fulfilmentOf(e, printed, day);
    const k = packingKind(f);
    const g = packingGroup(f);

    if (!kinds.has(k.key)) {
      kinds.set(k.key, { ...k, entries: [], places: new Map() });
    }

    const kind = kinds.get(k.key);

    kind.entries.push(e);
    if (!kind.places.has(g.key)) kind.places.set(g.key, { ...g, entries: [] });
    kind.places.get(g.key).entries.push(e);
  }

  return [...kinds.values()].map((k) => ({
    ...k, places: [...k.places.values()],
  }));
};

const startOf = (order) => {
  const times = order.fulfilment && order.fulfilment.method === "onfarm"
    ? pickupTimes(order.fulfilment.onfarm) : null;

  return times ? times.from : "";
};

// A scheduled pickup's occurrence, so each one's orders sit together.
const occurrenceOf = (order) => placeOf(order).occurrence || "";

const rank = (method) => {
  const i = METHOD_ORDER.indexOf(method);

  return i < 0 ? METHOD_ORDER.length : i;
};

// By fulfillment date, then type, then pickup time, then order number.
export const byFulfillment = (a, b) => {
  const fa = a.order.fulfilment;
  const fb = b.order.fulfilment;

  return fa.date.localeCompare(fb.date)
    || rank(fa.method) - rank(fb.method)
    || occurrenceOf(a.order).localeCompare(occurrenceOf(b.order))
    || startOf(a.order).localeCompare(startOf(b.order))
    || a.order.id.localeCompare(b.order.id);
};

// -> { slips, revised, cancelled } for a packet's counts.
export const countsOf = (entries) => ({
  slips: entries.filter((e) => e.kind !== "cancelled").length,
  revised: entries.filter((e) => e.kind === "changed").length,
  cancelled: entries.filter((e) => e.kind === "cancelled").length,
});

export const slipsOf = (entries) =>
  entries.filter((e) => e.kind !== "cancelled");

// Every product and tier across the slips with its total quantity,
// by name. -> [{ label, qty }].
export const pickList = (entries) => {
  const totals = new Map();

  for (const { order } of slipsOf(entries)) {
    for (const l of order.lines) {
      const key = l.sku || l.label;
      const seen = totals.get(key) || { label: l.label, qty: 0 };

      totals.set(key, { label: seen.label, qty: seen.qty + l.qty });
    }
  }

  return [...totals.values()].sort((a, b) => a.label.localeCompare(b.label));
};

// --- The PDF ------------------------------------------------------------
//
// Two kinds of page (James, #292). The customer's slip goes in the bag
// with the order, so it carries the brand: the site's hen and wordmark,
// Aller, the brand green, and words a customer would use. Every other
// sheet is the farm's alone: plain Helvetica in black and white, under
// a black FARM COPY band, so none can go in a bag by mistake.

const M = 54;
const RIGHT = 612 - M;
const CENTER = 306;
const BOTTOM = 792 - 54;
const LINE = 15;
// The most lines one field or item name takes; past that it ends
// in an ellipsis, so a long note can't run on for pages.
export const FIELD_ROWS = 12;
const LABEL_ROWS = 4;

export const FARM_COPY = "FARM COPY · DON'T PACK";

// The slip's colours: the site's $primary, which the logo, the emails
// and the gate use; its body text; $gray-600; the green, faint, for
// rules. The green prints as a dark gray in black and white.
const GREEN = "#186243";
const INK = "#212529";
const MUTED = "#5e5e5f";
const RULE = "#c5d6cc";
const ALLER = { font: "aller" };

// The slip's body ends here; its footer sits below, clear of the half
// inch a printer may crop.
const SLIP_BOTTOM = 664;
// The Price column's right edge; Amount ends at the table's.
const PRICE_X = RIGHT - 90;

const stamp = (now) => new Intl.DateTimeFormat("en-US", {
  timeZone: tz, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
}).format(now);

// A sheet's place on its pages: `y` moves down, and `room(h)` starts a
// new page, through `start`, when `h` more points would not fit.
const flow = (start, bottom) => {
  let y = start();

  return {
    get y() {
      return y;
    },
    set y(v) {
      y = v;
    },
    room(h) {
      if (y + h > bottom) y = start();
    },
  };
};

// One page or more for one of the farm's sheets, each under the band
// and with the band's words again at the foot.
const sheet = (doc, { title, id, now }) => {
  let n = 0;

  return flow(() => {
    doc.page();
    n += 1;
    doc.rect(M, 40, RIGHT - M, 28, { fill: 0, stroke: 0 });
    doc.text(FARM_COPY, CENTER, 59, {
      size: 14, bold: true, color: 1, align: "center",
    });
    const heading = `${title}${n > 1 ? " (continued)" : ""}`;
    // A long place name shrinks to fit beside the order number.
    const room = RIGHT - M - (id ? 150 : 0);
    const size = Math.min(18,
      18 * room / widthOf(heading, { size: 18, bold: true }));

    doc.text(heading, M, 110, { size, bold: true });
    if (id) doc.text(id, RIGHT, 110, { size: 18, bold: true, align: "right" });
    // The foot sits clear of the half inch a printer may crop.
    doc.text(`Printed ${stamp(now)}`, M, BOTTOM + 12, { size: 8, shade: 0.4 });
    doc.text(FARM_COPY, RIGHT, BOTTOM + 12, {
      size: 8, bold: true, align: "right",
    });

    return 138;
  }, BOTTOM);
};

const field = (doc, at, name, value, { width = RIGHT - M - 90 } = {}) => {
  const rows = wrap(value || "", width, { size: 11, rows: FIELD_ROWS });

  at.room(rows.length * LINE);
  doc.text(name, M, at.y, { size: 9, shade: 0.4 });
  rows.forEach((row, i) => doc.text(row, M + 90, at.y + i * LINE, {
    size: 11,
  }));
  at.y += rows.length * LINE + 3;
};

const banner = (doc, at, word, { x = RIGHT - 170, w = 170 } = {}) => {
  doc.rect(x, at.y - 2, w, 40, { fill: 0.88, stroke: 2 });
  doc.text(word, x + w / 2, at.y + 27, { size: 24, bold: true,
    align: "center" });
};

// --- The customer's slip ------------------------------------------------

// "a and b", "a, b, and c": the serial comma, as the site writes a
// list.
const list = (words) => (words.length > 1
  ? `${words.slice(0, -1).join(", ")}${words.length > 2 ? "," : ""} and ${
    words.at(-1)}`
  : words.join(""));

// Each way to pay as the slip says it, by checkout's method keys.
export const PAY_WORDS = {
  card: "card", applepay: "Apple Pay", googlepay: "Google Pay",
  cashapp: "Cash App Pay", venmo: "Venmo",
  // A buying group member's credit (#471), on the slip as "credit".
  credit: "credit",
};

// Every way checkout takes payment now: its methods, less Venmo while
// PayPal is unset or the button is held back, and less a member's
// credit (#471), which is not a way to pay at the door.
export const acceptedWays = (env) => Object.keys(METHODS)
  .filter((m) => m !== "credit")
  .filter((m) => m !== "venmo" || (paypalConfigured(env)
    && !venmoHidden(env)))
  .map((m) => PAY_WORDS[m] || m);

// "Paid by card. Thank you!", "Paid with Apple Pay. Thank you!"
export const paidLine = (order) => {
  const ways = [...new Set(paymentsOf(order).map((p) => PAY_WORDS[p.method]
    || (p.via === "venmo" ? PAY_WORDS.venmo : PAY_WORDS.card)))]
    .sort((a, b) => (b === "card") - (a === "card"));

  if (!ways.length) return "Paid. Thank you!";

  return `Paid ${ways[0] === "card" ? "by" : "with"} ${list(ways)}. ` +
    "Thank you!";
};

// A card's brand as Square names it, as a customer would write it.
const BRANDS = {
  VISA: "Visa", MASTERCARD: "Mastercard", AMERICAN_EXPRESS: "American Express",
  DISCOVER: "Discover", DISCOVER_DINERS: "Diners Club", JCB: "JCB",
  UNIONPAY: "UnionPay",
};

const brandName = (brand) => BRANDS[brand] || String(brand).toLowerCase()
  .split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// "Visa *4242" for a card, else the method's name: "Venmo", "Apple
// Pay". A card the record has no brand or digits for is "Card".
export const paymentName = (p) => {
  if (p.via === "venmo") return PAY_WORDS.venmo;
  if (p.method && p.method !== "card" && PAY_WORDS[p.method]) {
    return PAY_WORDS[p.method];
  }
  if (!p.last4) return p.brand ? brandName(p.brand) : "Card";

  return `${p.brand ? brandName(p.brand) : "Card"} *${p.last4}`;
};

// "Amount due at pickup: $94", and the ways to pay it. Cash leads: the
// farm takes it in person, though the site never offers it (James,
// 2026-10-22, #181).
export const dueLines = (order, state, env) => [
  `Amount due at ${order.fulfilment.method === "delivery" ? "delivery"
    : "pickup"}: ${dollars(state.due)}`,
  `We accept ${list(["cash", ...acceptedWays(env).map((w) => (w === "card"
    ? "cards" : w))])}.`,
];

export const SLIP_THANKS = "Thank you for supporting local farms.";

// The farm's address as it goes on an envelope, one line each.
export const slipAddress = () => [
  company.name, company.address.street,
  `${company.address.city}, ${company.address.state} ${
    company.address.zip}`,
];

// The phone, the sales address, the website and the Instagram handle,
// from the site's data. The website is the sales address's domain.
export const slipContacts = () => [
  company.phone.display,
  company.email,
  company.email.split("@")[1],
  `@${new URL(signatures.shared.instagram.url).pathname.replace(/\//g, "")}`,
].join("  ·  ");

const slipFooter = (doc) => {
  doc.line(M, 680, RIGHT, 680, { width: 0.75, color: GREEN });
  doc.text(SLIP_THANKS, CENTER, 698, {
    ...ALLER, size: 11, bold: true, color: GREEN, align: "center",
  });
  doc.text(slipContacts(), CENTER, 714, {
    ...ALLER, size: 9, color: INK, align: "center",
  });
  slipAddress().forEach((row, i) => doc.text(row, CENTER, 729 + i * 10.5, {
    ...ALLER, size: 8, color: MUTED, align: "center",
  }));
};

// The header on each page of a slip: the hen and wordmark, the order
// number, the green stripe the site's header has.
const slipSheet = (doc, { id }) => {
  let n = 0;

  return flow(() => {
    doc.page();
    n += 1;

    const w = doc.art(mark, M, 44, { height: 44, color: GREEN });

    // The header's proportions (_header.scss, lg): the wordmark 20/48
    // the hen's height, centered on it, 12/48 of it away.
    doc.art(wordmark, M + w + 11, 66 - 44 * 20 / 96, {
      height: 44 * 20 / 48, color: GREEN,
    });
    doc.text("Order", RIGHT, 60, {
      ...ALLER, size: 9, color: MUTED, align: "right",
    });
    doc.text(id, RIGHT, 79, {
      ...ALLER, size: 16, bold: true, color: GREEN, align: "right",
    });
    doc.rect(M, 98, RIGHT - M, 1.5, { fill: GREEN, stroke: 0 });
    slipFooter(doc);
    if (n === 1) return 104;

    doc.text("Your order (continued)", M, 130, {
      ...ALLER, size: 14, bold: true, color: GREEN,
    });

    return 150;
  }, SLIP_BOTTOM);
};

// PAID solid green, UNPAID an outline: apart at a glance, in colour
// and in gray.
const payBadge = (doc, state, x, top, w, h) => {
  const color = state.paid ? 1 : GREEN;

  // The outline drawn inside the box, so both line up with the stripe.
  if (state.paid) doc.rect(x, top, w, h, { fill: GREEN, stroke: 0 });
  else {
    doc.rect(x + 1.25, top + 1.25, w - 2.5, h - 2.5, {
      stroke: 2.5, color: GREEN,
    });
  }
  doc.text(paidWord(state), x + w / 2, top + h / 2 + 8, {
    ...ALLER, size: 22, bold: true, color, align: "center",
  });
};

// An address as lines that never wrap or leave a ZIP alone: split at
// the commas, the state and ZIP kept with their town.
// "46 Institute Lane, North Scituate, RI 02857" ->
// ["46 Institute Lane", "North Scituate, RI 02857"]
export const addressLines = (place) => {
  const parts = String(place || "").split(/,\s*/).filter(Boolean);
  const last = parts.length > 2 && /^[A-Z]{2}(?: \d{5})?$/.test(parts.at(-1))
    ? parts.splice(-2) : [];

  return last.length ? [...parts, last.join(", ")] : parts;
};

// A column of the slip's details: a small label, then lines of text.
// -> the y below it.
const column = (doc, x, top, width, label, lines) => {
  let y = top;

  doc.text(label.toUpperCase(), x, y, {
    ...ALLER, size: 8, bold: true, color: MUTED,
  });
  y += 16;
  for (const [text, bold] of lines) {
    for (const row of wrap(text, width, {
      ...ALLER, size: bold ? 12 : 10.5, bold, rows: FIELD_ROWS,
    })) {
      doc.text(row, x, y, {
        ...ALLER, size: bold ? 12 : 10.5, bold, color: INK,
      });
      y += bold ? 16 : 14;
    }
  }

  return y;
};

const slipPage = (doc, order, env) => {
  const at = slipSheet(doc, { id: order.id });
  const where = placeOf(order);
  const state = paymentState(order);
  const d = order.fulfilment.delivery || {};
  const c = order.customer;

  doc.text("Your order", M, 146, {
    ...ALLER, size: 26, bold: true, color: GREEN,
  });
  payBadge(doc, state, RIGHT - 150, 118, 150, 40);

  let y = 178;

  if (state.paid) {
    doc.text(paidLine(order), M, y, { ...ALLER, size: 12, color: INK });
  } else {
    const [due, ways] = dueLines(order, state, env);

    doc.text(due, M, y, { ...ALLER, size: 13, bold: true, color: INK });
    for (const row of wrap(ways, RIGHT - M, { ...ALLER, size: 10.5 })) {
      y += 15;
      doc.text(row, M, y, { ...ALLER, size: 10.5, color: INK });
    }
  }

  const top = y + 30;
  const left = column(doc, M, top, 220, "Customer", [
    [c.name || "", true], [c.phone || ""], [c.email || ""],
  ].filter(([text]) => text));
  const right = column(doc, M + 260, top, RIGHT - M - 260, where.name, [
    [label(order.fulfilment.date), true],
    ...(where.window ? [[where.window]] : []),
    ...addressLines(where.place).map((row) => [row]),
    ...(d.gate ? [[`Gate or door code: ${d.gate}`]] : []),
  ]);

  at.y = Math.max(left, right) + 14;

  // The items: a slim green header row, then each line's quantity,
  // name, unit price and amount.
  at.room(15 + LINE * 3);
  doc.rect(M, at.y, RIGHT - M, 15, { fill: GREEN, stroke: 0 });
  for (const [text, x, align] of [
    ["Qty", M + 36, "right"], ["Item", M + 50, "left"],
    ["Price", PRICE_X, "right"], ["Amount", RIGHT - 8, "right"],
  ]) {
    doc.text(text, x, at.y + 10.5, {
      ...ALLER, size: 9, bold: true, color: 1, align,
    });
  }
  at.y += 33;

  for (const l of order.lines) {
    const rows = wrap(l.label, PRICE_X - 70 - M - 50, {
      ...ALLER, size: 11, rows: LABEL_ROWS,
    });
    const each = l.unitPrice ?? l.lineTotal / l.qty;

    at.room(rows.length * LINE + 10);
    doc.text(String(l.qty), M + 36, at.y, {
      ...ALLER, size: 11, bold: true, color: INK, align: "right",
    });
    rows.forEach((row, i) => doc.text(row, M + 50, at.y + i * LINE, {
      ...ALLER, size: 11, color: INK,
    }));
    doc.text(dollars(Math.round(each * 100)), PRICE_X, at.y, {
      ...ALLER, size: 11, color: INK, align: "right",
    });
    doc.text(dollars(Math.round(l.lineTotal * 100)), RIGHT - 8, at.y, {
      ...ALLER, size: 11, color: INK, align: "right",
    });
    at.y += rows.length * LINE - 4;
    doc.line(M, at.y, RIGHT, at.y, { width: 0.5, color: RULE });
    at.y += 18;
  }

  // The totals as one right-aligned ledger (James, 2026-10-24, round
  // 4): each line's label ends where the amounts' column begins, a
  // space sets off the bold Total, each payment is "Paid by Visa *4242"
  // with its amount taken off, and space sets off the bold Due. A rule
  // above Total and above Due separates the sections (round 6, after
  // round 5 dropped them), each from the left edge of the "T" in
  // "Total" to the right margin.
  const t = order.totals;
  const paid = paymentsOf(order).filter((p) => p.amount > 0);
  const lines = [["Subtotal", dollars(t.subtotal)]];

  if (t.discountAmount) {
    lines.push([t.discountLabel || "Discount",
      `-${dollars(t.discountAmount)}`]);
  }
  if (t.deliveryFee) lines.push(["Delivery fee", dollars(t.deliveryFee)]);

  const LABEL_X = RIGHT - 70;
  const row = (name, value, bold) => {
    const size = bold ? 12 : 11;

    doc.text(name, LABEL_X, at.y, {
      ...ALLER, size, bold, color: INK, align: "right",
    });
    doc.text(value, RIGHT - 8, at.y, {
      ...ALLER, size, bold, color: INK, align: "right",
    });
    at.y += LINE;
  };
  const RULE_X = LABEL_X
    - widthOf("Total", { ...ALLER, size: 12, bold: true });
  const gap = () => {
    doc.line(RULE_X, at.y, RIGHT, at.y, { width: 0.5, color: RULE });
    at.y += 21;
  };

  at.room((lines.length + paid.length + 4) * LINE + 40);
  for (const [name, value] of lines) row(name, value);
  gap();
  row("Total", dollars(t.total), true);
  for (const p of paid) row(`Paid by ${paymentName(p)}`,
    `-${dollars(p.amount)}`);
  if (state.refunded) row("Refunded", dollars(state.refunded));
  if (paid.length) {
    gap();
    row("Due", dollars(state.due), true);
  }
};

// --- The farm's sheets --------------------------------------------------

const revisionPage = (doc, entry, now) => {
  const cancelled = entry.kind === "cancelled";
  const order = entry.order;
  const at = sheet(doc, {
    title: cancelled ? "Canceled" : "Revised order", id: order.id, now,
  });

  banner(doc, at, cancelled ? "CANCELED" : "REVISED", { x: M, w: RIGHT - M });
  at.y += 66;

  const f = order.fulfilment || {};

  if (order.customer) field(doc, at, "Customer", order.customer.name || "");
  if (f.method) field(doc, at, "Type", placeOf(order).name);
  if (f.date) field(doc, at, "Date", label(f.date));
  at.y += 10;

  if (cancelled) {
    for (const row of wrap("This order is canceled. Don't pack it, and " +
      "throw away the slip printed for it earlier.", RIGHT - M, {
      size: 13, bold: true,
    })) {
      doc.text(row, M, at.y, { size: 13, bold: true });
      at.y += LINE + 3;
    }

    return;
  }

  doc.text("What changed since its last slip", M, at.y, {
    size: 13, bold: true,
  });
  at.y += LINE + 6;
  for (const change of entry.changes.length ? entry.changes
    : ["Only the details changed: see the new slip"]) {
    const rows = wrap(change, RIGHT - M - 16, {
      size: 11, rows: LABEL_ROWS,
    });

    at.room(rows.length * LINE);
    doc.text("•", M + 2, at.y, { size: 11 });
    rows.forEach((row, i) => doc.text(row, M + 16, at.y + i * LINE, {
      size: 11,
    }));
    at.y += rows.length * LINE + 3;
  }
  at.y += 10;
  for (const row of wrap("The new packing slip follows. Throw away the " +
    "one printed earlier.", RIGHT - M, { size: 11, bold: true })) {
    doc.text(row, M, at.y, { size: 11, bold: true });
    at.y += LINE;
  }
};

const KIND = {
  new: "New", changed: "Revised", reprint: "Reprint", cancelled: "CANCELED",
};

const coverPage = (doc, { entries, now, title, day }) => {
  const at = sheet(doc, { title, now });
  const picks = pickList(entries);
  const counts = packetCounts(countsOf(entries));

  doc.text(day ? `Packing slips for ${label(day)}: ${counts}` : counts,
    M, at.y, { size: 11 });
  at.y += LINE + 12;

  doc.text("Contents", M, at.y, { size: 14, bold: true });
  at.y += LINE + 6;
  doc.text("Pick list", M, at.y, { size: 12, bold: true });
  at.y += LINE + 2;
  if (!picks.length) {
    doc.text("Nothing to pick.", M, at.y, { size: 11 });
    at.y += LINE;
  }
  for (const p of picks) {
    const rows = wrap(p.label, RIGHT - M - 70, {
      size: 11, rows: LABEL_ROWS,
    });

    at.room(rows.length * LINE + 2);
    doc.rect(M, at.y - 9, 9, 9, { stroke: 0.75 });
    doc.text(`${p.qty}`, M + 46, at.y, { size: 11, bold: true,
      align: "right" });
    doc.text("×", M + 52, at.y, { size: 11 });
    rows.forEach((row, i) => doc.text(row, M + 66, at.y + i * LINE, {
      size: 11,
    }));
    at.y += rows.length * LINE + 2;
  }

  at.y += 16;
  at.room(LINE * 4);
  doc.text("In this packet", M, at.y, { size: 12, bold: true });
  at.y += LINE + 2;

  // Each column ends before the next begins; a name that doesn't fit
  // wraps to a second line rather than run into its neighbor.
  const COLS = { id: M, name: M + 95, method: M + 215, date: M + 340,
    status: M + 445 };
  const head = { size: 8, bold: true, shade: 0.4 };

  for (const [text, x] of [["ORDER", COLS.id], ["CUSTOMER", COLS.name],
    ["METHOD", COLS.method], ["DATE", COLS.date],
    ["STATUS", COLS.status]]) {
    doc.text(text, x, at.y, head);
  }
  at.y += LINE - 1;
  for (const e of entries) {
    const f = e.order.fulfilment || {};
    const name = (e.order.customer && e.order.customer.name) || "";
    const names = wrap(name, COLS.method - COLS.name - 10, {
      size: 10, rows: 2,
    });
    const methods = wrap(f.method ? placeOf(e.order).name : "",
      COLS.date - COLS.method - 10, { size: 10, rows: 2 });
    const rows = Math.max(names.length, methods.length, 1);

    at.room(rows * 12 + 3);
    doc.text(e.order.id, COLS.id, at.y, { size: 10, bold: true });
    names.forEach((row, i) => doc.text(row, COLS.name, at.y + i * 12, {
      size: 10,
    }));
    methods.forEach((row, i) => doc.text(row, COLS.method, at.y + i * 12, {
      size: 10,
    }));
    doc.text(f.date ? shortDay(f.date) : "", COLS.date, at.y, { size: 10 });
    doc.text(KIND[e.kind], COLS.status, at.y, { size: 10,
      bold: e.kind !== "new" && e.kind !== "reprint" });
    at.y += (rows - 1) * 12 + LINE;
  }
};

// The whole packet: the cover (unless `cover` is false; "only" is the
// cover alone) under `title`, its counts naming `day` when given, then
// for each entry its revision sheet and slip as it needs. `env` says
// which ways to pay an unpaid slip lists. -> a Buffer.
export const packetPdf = ({
  entries, now, title, day = null, cover = true, env = process.env,
}) => {
  const doc = pdf({ title });

  if (cover) coverPage(doc, { entries, now, title, day });
  for (const e of cover === "only" ? [] : entries) {
    if (e.kind === "changed" || e.kind === "cancelled") {
      revisionPage(doc, e, now);
    }
    if (e.kind !== "cancelled") slipPage(doc, e.order, env);
  }

  return doc.bytes();
};

// A packet's cover title: its kind ("Market/drop site pickups"), after
// "New since yesterday: " at 6 AM; or, for a whole day's preview, the
// day.
export const packetTitle = (day, { place = null, late = false } = {}) =>
  (place ? `${late ? "New since yesterday: " : ""}${place}`
    : `Packing slips for ${shortDay(day)}`);

export const fileName = (day, suffix = "") =>
  `packing-slips-${day}${suffix}.pdf`;

// "north-scituate-drop-site": a place in a file's name.
export const slugOf = (place) => place.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// A kind's PDF, by its key: "packing-slips-2026-11-21-market.pdf",
// "-late" before ".pdf" at 6 AM.
export const groupFileName = (day, place, late = false) =>
  fileName(day, `-${slugOf(place)}${late ? "-late" : ""}`);

export const attachment = (filename, bytes) => ({
  filename, contentType: "application/pdf",
  content: bytes.toString("base64"),
});

// --- Reading the records ---------------------------------------------

// Every order that gets a slip: paid, unpaid (made by the farm, #181),
// or an older record still unpaid.
export const PACKED = ["paid", "unpaid", "submitted"];
const GONE = ["cancelled", "abandoned"];

// The orders to pack, and each printed order since cancelled (or
// deleted) and not yet past its date. A fulfilled one drops out. The
// morning packet reads every order, so an unpaid one is found too;
// the check after it reads only the printed ones. `owed` is a 3 PM
// packet not yet sent: each of its orders counts as printed as that
// packet shows it, since its retry will bring the farm that slip.
const gather = async (stores, day, { every = true, owed = [] } = {}) => {
  const printed = await readPrinted(stores);

  for (const r of owed) {
    printed.set(r.id, { id: r.id, date: r.date, snapshot: r.snapshot });
  }
  const orders = every
    ? await allOrders(stores)
    : (await Promise.all([...printed.keys()]
      .map((id) => getOrder(stores, id)))).filter(Boolean);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const open = orders.filter((o) => PACKED.includes(o.status));
  const gone = [];

  for (const record of printed.values()) {
    if (record.snapshot.status === "cancelled" || record.date < day) continue;

    const order = byId.get(record.id) || null;

    if (order && !GONE.includes(order.status)) continue;
    gone.push({
      record: {
        id: record.id, customer: null,
        fulfilment: {
          method: record.snapshot.method, date: record.snapshot.date,
          ...record.snapshot.occurrence
            && { occurrence: record.snapshot.occurrence },
        },
      },
      order,
    });
  }

  return { open, printed, gone };
};

// What an entry's slip or sheet shows, to keep as printed.
const printedOf = (e) => ({
  id: e.order.id,
  date: e.order.fulfilment.date,
  snapshot: e.kind === "cancelled"
    ? { ...(e.order.lines ? snapshotOf(e.order) : {}), status: "cancelled" }
    : snapshotOf(e.order),
});

const remember = async (stores, records, now) => {
  for (const r of records) {
    await stores.jobs.set(printedKey(r.id), { ...r, at: now.toISOString() });
  }
};

// Snapshots of orders KEEP_DAYS past their date go, and so do the
// pending packets and change notes of past days.
const prune = async (stores, day) => {
  const floor = addDays(day, -KEEP_DAYS);
  let n = 0;

  for (const record of (await readPrinted(stores)).values()) {
    if (record.date < floor) {
      await stores.jobs.delete(printedKey(record.id));
      n += 1;
    }
  }
  for (const prefix of [PENDING, CHANGED]) {
    for (const { key } of await stores.jobs.list(prefix)) {
      if (key.slice(prefix.length, prefix.length + 10) < day) {
        await stores.jobs.delete(key);
      }
    }
  }

  return n;
};

// Resend's answer when a key it has already sent comes back with a
// different body: what that key carried went out, so it counts as
// sent.
export const alreadySent = (error) => error instanceof MailError
  && error.status === 409
  && !!error.detail && error.detail.name === "invalid_idempotent_request";

// --- Healthchecks -------------------------------------------------------

// The packing check is production's alone: a staging or local run
// never pings it, whatever its variables say. A production run that
// sends through Resend without the key is an error, never a skip.
export const PING_KEY = "HEALTHCHECKS_PACKING_URL";

export const sendsForReal = (env) =>
  resendAllowed(env) && env.MAIL_DRIVER === "resend";

const pingUrl = (env) => (resendAllowed(env) ? env[PING_KEY] : null);

export const missingPingKey = (env) => sendsForReal(env) && !env[PING_KEY];

// --- Sending a packet ---------------------------------------------------

// One packet, the 3 PM one or the morning's, to the farm: one email per
// kind of fulfillment, each with its own PDF. A packet with nothing in
// it sends nothing (#694, James's revision: no "No packing slips"
// email).
//
// The first try fixes the packet in `pendingKey`: its time and each
// order with what its sheet shows. A retry sends the same orders with
// the same time, so a kind whose send was answered, or whose answer
// was lost, is not sent twice: Resend answers the same key with the
// first send. If an order changed in between, the body differs and
// Resend refuses the key; the first send went out, so that kind
// counts as sent, as the pending record printed it, and the change is
// caught later. Every kind is tried; if any fails, nothing is
// recorded printed and the run throws, so the next one tries again.
// Each kind that goes adds its orders to the pending record's `sent`
// as it goes (2026-11-20, #694). The run that finishes records every
// one of them printed, from its pending snapshot when no kind sent it
// this time: an order cancelled or moved before the retry has left
// today's choice, yet its slip is on the farm's pile, so the next
// packet or "Changed after printing" brings its CANCELED or revised
// sheet.
//
// The fixed time is the packet's cutoff, kept by `sentKey` as `cutoff`:
// the run's `now`, taken when the 15-minute run starts, a little before
// the orders are read. What governs is the snapshot each order is
// printed with, not the time: an order saved in that gap is in the
// packet though stamped after it, and one saved after the read is the
// next packet's.
//
// `taken` names orders another packet has printed, or will print,
// since this one was fixed: the 6 AM packet's, for a 3 PM retry that
// goes after it (qa on PR #701, 2026-11-21). A retry leaves them out,
// so no order is printed twice, and counts them as recorded without
// writing over what that packet printed. -> the summary.
const sendPacket = async (stores, {
  day, to, mail, env, now, pending: fixed, pendingKey, sentKey,
  idempotencyKey, event, entries: chosen, printed, late = false,
  taken = new Set(),
}) => {
  let entries = chosen;
  let pending = fixed;

  if (pending) {
    const ids = new Set(pending.entries.map((e) => e.id));

    entries = entries.filter((e) => ids.has(e.order.id)
      && !taken.has(e.order.id));
  } else {
    pending = {
      at: now.toISOString(),
      entries: entries.map((e) => ({ ...printedOf(e), kind: e.kind })),
    };
    await stores.jobs.set(pendingKey, pending);
  }

  const stamp = new Date(pending.at);
  const kinds = kindsOf(entries, printed, day);
  const links = mailLinks(env);
  const records = [];
  const failed = [];
  const asPending = (ids) => pending.entries
    .filter((r) => ids.includes(r.id))
    .map((r) => ({ id: r.id, date: r.date, snapshot: r.snapshot }));
  // Each kind that goes adds its orders to `pending.sent` at once, so
  // a retry still records them printed when a change since has taken
  // them out of today's choice and no kind sends them again.
  const went = async (ids) => {
    const sent = pending.sent || [];
    const more = ids.filter((id) => !sent.includes(id));

    if (!more.length) return;
    pending = { ...pending, sent: [...sent, ...more] };
    await stores.jobs.set(pendingKey, pending);
  };
  const send = async (message, ids) => {
    try {
      await mail({ to, ...message }, { env });
      records.push(...entries.filter((e) => ids.includes(e.order.id))
        .map(printedOf));
    } catch (error) {
      if (!alreadySent(error)) {
        failed.push(error);

        return;
      }
      log.warn({ event, day });
      records.push(...asPending(ids));
    }
    await went(ids);
  };

  for (const k of kinds) {
    await send({
      idempotencyKey: `${idempotencyKey}-${k.key}`,
      ...farmPackingSlips(k.entries, {
        day, kind: k, places: k.places, late, at: EVE_TIME,
        next: PACKING_TIME, links,
      }),
      attachments: [attachment(groupFileName(day, k.key, late), packetPdf({
        entries: k.entries, now: stamp, day, env,
        title: packetTitle(day, { place: k.title, late }),
      }))],
    }, k.entries.map((e) => e.order.id));
  }
  if (failed.length) throw failed[0];

  const recorded = new Set(records.map((r) => r.id));

  records.push(...asPending((pending.sent || [])
    .filter((id) => !recorded.has(id) && !taken.has(id))));

  const summary = {
    day, late, quiet: !kinds.length, ...countsOf(entries),
    kinds: kinds.map((k) => k.key),
  };
  const others = pending.entries.map((r) => r.id)
    .filter((id) => taken.has(id) && !recorded.has(id));

  await remember(stores, records, stamp);
  await stores.jobs.set(sentKey, {
    at: now.toISOString(), cutoff: pending.at, ...summary,
    ids: [...records.map((r) => r.id), ...others],
  });
  await stores.jobs.delete(pendingKey);

  return summary;
};

// The key a day's 3 PM packet waits under while it is owed.
const evePendingKey = (day) => `${PENDING}${day}-eve`;

// --- The morning run ----------------------------------------------------

// From PACKING_HOUR, once a day: one email per kind of fulfillment with
// the day's late slips, what came in, changed or was cancelled after
// the 3 PM packet, and none for a kind with nothing late. A 3 PM packet
// still owed counts as printed, so its slips never come at 6 AM: it is
// never sent from 6 AM on (James, 2026-11-21: a copy after 6 AM means
// the farm's email is failing, the bigger problem), and this run pings
// the check's /fail and throws to say so. With no 3 PM packet at all,
// every slip for the day is new since yesterday. There is no catch-up
// email (#694, James's revision). Either way the day is marked sent,
// so "Changed after printing" starts.
//
// -> { day, late, quiet, slips, revised, cancelled, kinds } or null
// when nothing was done this run. Throws when a kind's email could not
// go (the next run tries again), when the 3 PM packet never went, or
// when it went without its check configured.
export const packingDaily = async (stores, {
  env = process.env, mail = sendMail, now = clock(),
  fetchImpl = globalThis.fetch,
} = {}) => {
  const day = today(now, tz);
  const to = farmEmails(env);
  const hour = parts(now, tz).hour;

  if (hour < PACKING_HOUR || !to.length) return null;
  if (await stores.jobs.get(`${SENT}${day}`)) return null;

  const pendingKey = `${PENDING}${day}`;
  const pending = await stores.jobs.get(pendingKey);

  if (!pending && hour >= PACKING_LAST_HOUR) return null;

  let result;
  let owed;

  try {
    owed = await stores.jobs.get(evePendingKey(day));

    const found = await gather(stores, day, {
      owed: owed ? owed.entries : [],
    });

    result = await sendPacket(stores, {
      day, to, mail, env, now, pending, pendingKey,
      sentKey: `${SENT}${day}`, idempotencyKey: `packing-${day}`,
      event: "packing.already_sent", printed: found.printed,
      entries: chooseDay({ ...found, day }), late: true,
    });
    await prune(stores, day);
  } catch (error) {
    const message = String((error && error.message) || error);

    log.error({ event: "packing.failed", error: message });
    await ping(pingUrl(env), {
      ok: false, body: scrub({ failed: "packing", day, error: message }),
      fetchImpl,
    });
    throw error;
  }

  // The 3 PM packet never went: it is never sent now (James,
  // 2026-11-21), and the farm's mail is the bigger problem.
  if (owed) {
    const message = `The ${EVE_TIME} packing slips for ${day} never went ` +
      `out, and none goes after ${PACKING_TIME}: the farm's email is not ` +
      "reaching it. Check the mail log and Resend.";

    log.info({ event: "packing.sent", ...result });
    log.error({ event: "packing.eve.missed", day });
    await ping(pingUrl(env), {
      ok: false, body: scrub({ failed: "packing.eve", day, error: message }),
      fetchImpl,
    });
    throw new Error(message);
  }

  await ping(pingUrl(env), { ok: true, fetchImpl });
  log.info({ event: "packing.sent", ...result });

  if (missingPingKey(env)) {
    throw new Error(`${PING_KEY} is not set: the packing slips went out ` +
      "but nothing told Healthchecks. Set it on production.");
  }

  return result;
};

// --- The 3 PM run -------------------------------------------------------

// The 3 PM packet for `day`: its first try, or the retry of one that
// failed (`retryOnly` tries nothing new). -> the summary, or null.
const evePacket = async (stores, day, {
  env, mail, now, fetchImpl, to, retryOnly,
}) => {
  if (await stores.jobs.get(`${EVE}${day}`)) return null;

  const pendingKey = evePendingKey(day);
  const pending = await stores.jobs.get(pendingKey);

  if (!pending && retryOnly) return null;

  let result;

  try {
    const found = await gather(stores, day);
    // What the day's 6 AM packet printed: it counted this packet's
    // orders as printed, so an order it sent is never this one's too.
    // One it still owes is printed by this retry, and its own retry
    // then finds it printed and leaves it out.
    const morning = await stores.jobs.get(`${SENT}${day}`);
    const taken = new Set((morning && morning.ids) || []);

    result = await sendPacket(stores, {
      day, to, mail, env, now, pending, pendingKey,
      sentKey: `${EVE}${day}`, idempotencyKey: `packing-eve-${day}`,
      event: "packing.eve.already_sent", printed: found.printed,
      entries: chooseDay({ ...found, day, reprint: true }), taken,
    });
  } catch (error) {
    const message = String((error && error.message) || error);

    log.error({ event: "packing.eve.failed", day, error: message });
    await ping(pingUrl(env), {
      ok: false, body: scrub({ failed: "packing.eve", day, error: message }),
      fetchImpl,
    });
    throw error;
  }

  log.info({ event: "packing.eve.sent", ...result });

  return result;
};

// From EVE_HOUR, once a day: one email per kind of fulfillment with
// every slip for tomorrow and nothing for a later day (#694), so the
// farm can pack the night before, and no email for a kind with nothing
// to print. It starts by EVE_LAST_HOUR or not at all.
//
// A 3 PM packet that failed is retried by every 15-minute run after,
// past midnight, until it goes (James's revision of #694): the retry
// is the on-time email again, its orders and time fixed by the first
// try, so what goes is what would have gone at 3 PM. It stops at the
// 6 AM run and is never sent after (James, 2026-11-21); that run sends
// only what is late against it, never a catch-up, and pings /fail.
// The next day's 6 AM run prunes it. As a guard, a retry that ever
// went after the 6 AM packet would leave out each order that packet
// sent, so none is printed twice (qa on PR #701).
//
// A failure pings the packing check's /fail; a success leaves the
// check to the morning's packet, which its schedule expects, so after
// a 3 PM failure the check stays down until the morning's packet goes,
// even if a retry sent the 3 PM one.
// -> { day, late, quiet, slips, revised, cancelled, kinds } or null
// when nothing was done this run. Throws when a kind's email could not
// go.
export const packingEve = async (stores, {
  env = process.env, mail = sendMail, now = clock(),
  fetchImpl = globalThis.fetch,
} = {}) => {
  const to = farmEmails(env);

  if (!to.length) return null;

  const date = today(now, tz);
  const hour = parts(now, tz).hour;
  const opts = { env, mail, now, fetchImpl, to };
  let result = null;
  let failed = null;

  // Yesterday's packet for today, while it is still owed, and only
  // until the 6 AM run.
  if (hour < PACKING_HOUR) {
    try {
      result = await evePacket(stores, date, { ...opts, retryOnly: true });
    } catch (error) {
      failed = error;
    }
  }
  if (hour >= EVE_HOUR) {
    try {
      result = (await evePacket(stores, addDays(date, 1), {
        ...opts, retryOnly: hour >= EVE_LAST_HOUR,
      })) || result;
    } catch (error) {
      failed = failed || error;
    }
  }
  if (failed) throw failed;

  return result;
};

// A day's slips as the 3 PM packet would build them from the orders
// and printed records in `stores`, every group in one PDF, for the
// staging toolbar's preview (#334). It reads and writes nothing, sends
// nothing.
// -> { day, entries, bytes } (bytes null when there is nothing to pack).
export const packetPreview = async (stores, day, {
  env = process.env, now = clock(),
} = {}) => {
  const entries = chooseDay({
    ...(await gather(stores, day)), day, reprint: true,
  });

  return {
    day, entries,
    bytes: entries.length ? packetPdf({
      entries, now, day, title: packetTitle(day), env,
    }) : null,
  };
};

// --- After the packet ---------------------------------------------------

// An order due today that changed after it was printed, once today's
// packet is out: the farm hears at once, with its revision sheet and
// a fresh slip, and the snapshot moves on so each change is mailed
// once. The key names the change by its content, so a retry of the
// same change is the same message and a newer change a new one.
//
// Known gap (#292 QA, nit a), left for later: an order that goes from
// A to B, back to A and to B again on its day repeats B's key within
// Resend's 24 hours, so the last mail is deduplicated and never sent,
// and the farm's newest sheet shows A. A count of the order's changes
// that day in the key would close it.
// -> the ids mailed this run.
export const changedAfterPrint = async (stores, {
  env = process.env, mail = sendMail, now = clock(),
} = {}) => {
  const day = today(now, tz);
  const to = farmEmails(env);

  if (!to.length || !(await stores.jobs.get(`${SENT}${day}`))) return [];

  const { open, printed, gone } = await gather(stores, day, { every: false });
  const entries = choose({ open, printed, gone, day })
    .filter((e) => e.order.fulfilment.date === day && e.kind !== "reprint");
  const sent = [];

  for (const e of entries) {
    const record = printedOf(e);
    const change = hash(record.snapshot);
    const filename = fileName(day, `-${e.order.id}-${change.slice(0, 6)}`);

    try {
      await mail({
        to, idempotencyKey: `packing-changed-${day}-${e.order.id}-${change}`,
        ...farmChangedAfterPrint(e, { date: day, links: mailLinks(env) }),
        attachments: [attachment(filename, packetPdf({
          entries: [e], now, cover: false, env,
          title: `Changed after printing, ${label(day)}`,
        }))],
      }, { env });
    } catch (error) {
      if (!alreadySent(error)) throw error;
    }
    await remember(stores, [record], now);
    await stores.jobs.set(`${CHANGED}${day}/${e.order.id}/${change}`, {
      at: now.toISOString(), kind: e.kind,
    });
    sent.push(e.order.id);
  }

  return sent;
};
