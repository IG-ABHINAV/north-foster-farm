import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { pickupSchedule } from "../netlify/functions/lib/pickups.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import { missedDelivery } from "../netlify/functions/lib/templates.mjs";
import {
  BASE, THANKSGIVING, ny, placed, words,
} from "./delivery-moved-setup.mjs";

// The admin's tellMissed passes the schedule from the env it holds, so
// the miss email names the next delivery day from that env, not from
// process.env (#642 review).
describe("missedDelivery with a schedule passed in", () => {
  let was;

  // The process.env holds the schedule with no delivery line.
  before(() => {
    was = process.env.PICKUP_SCHEDULE;
    process.env.PICKUP_SCHEDULE = BASE;
  });
  after(() => {
    if (was === undefined) delete process.env.PICKUP_SCHEDULE;
    else process.env.PICKUP_SCHEDULE = was;
  });

  it("names the moved day from the passed schedule", async () => {
    const { id, stores } = await placed({
      date: "2026-11-19", now: ny("2026-11-16"), schedule: THANKSGIVING,
    });
    const order = {
      ...await getOrder(stores, id),
      attempted: { date: "2026-11-19", cause: "farm",
        at: ny("2026-11-19", 15).toISOString() },
    };
    const offers = (text) => text.match(/Deliver it[^\n<]*/g) || [];
    const moved = offers(words(missedDelivery(order, {
      now: ny("2026-11-19", 16),
      schedule: pickupSchedule({ PICKUP_SCHEDULE: THANKSGIVING }),
    })));
    const plain = offers(words(missedDelivery(order, {
      now: ny("2026-11-19", 16),
    })));

    assert.ok(moved.length > 0);
    for (const offer of moved) {
      assert.ok(offer.includes("Wednesday, November 25"), offer);
    }
    // Without it, process.env's schedule: Thanksgiving Thursday is a
    // holiday, so the next delivery is a week later.
    assert.ok(plain.some((o) => o.includes("December 3")), plain);
    assert.ok(!plain.some((o) => o.includes("November 25")), plain);
  });
});
