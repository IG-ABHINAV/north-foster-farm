// The countdown's date never parts at a line break (#627): in a page,
// the notice's last two words are set in a text-nowrap span through
// setKept. The implementer's own test, beside the criteria's.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { DateLists } from "../assets/scripts/order/date-lists.js";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";

// Just enough of a document for setKept: elements with a class, text,
// and children, strings appended as they are.
const doc = {
  createElement: () => ({ className: "", textContent: "" }),
};

const node = () => {
  const n = {
    ownerDocument: doc,
    children: [],
    append: (part) => n.children.push(part),
  };

  Object.defineProperty(n, "textContent", {
    get: () => n.children
      .map((c) => (typeof c === "string" ? c : c.textContent)).join(""),
    set: () => { n.children = []; },
  });

  return n;
};

const made = [];

afterEach(() => {
  for (const lists of made.splice(0)) {
    clearTimeout(lists.timer);
    clearTimeout(lists.closing);
    clearTimeout(lists.again);
  }
});

describe("the countdown in a page", () => {
  it("keeps the date's last two words on one line", () => {
    const now = "2026-11-18T11:09:30.000Z";
    const text = node();
    const chip = { dataset: {} };
    const form = {
      querySelector: (sel) => ({
        "[data-countdown]": chip,
        "[data-countdown-text]": text,
      })[sel] || null,
      querySelectorAll: () => [],
    };
    const lists = new DateLists(form, () => {});

    made.push(lists);
    lists.apply({
      now,
      delivery: deliveryDates(new Date(now), terms),
      onfarm: [],
      scheduled: [],
    });

    assert.equal(text.textContent, "Order within 5 hours and 50 minutes "
      + "for delivery on Thursday, November 19.");

    const kept = text.children.filter((c) => typeof c !== "string");

    assert.deepEqual(kept.map((c) => [c.className, c.textContent]),
      [["text-nowrap", "November 19."]]);
    assert.doesNotMatch(text.textContent, /[\u00a0\u202f]/u,
      "no no-break space");
  });
});
