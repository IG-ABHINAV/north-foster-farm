import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { paidOnReplaced, replacedReport } from "../bin/schedule-env.mjs";

// `schedule set` prints this report after PICKUP_SCHEDULE is set and
// before the build hook, so it must never throw (#642 review). bin/nff
// passes a count that reads the orders store and runs paidOnReplaced.
const terms = { delivery: { weekday: 4 } };
const moved = [{ date: "2026-11-25" }];

describe("bin/nff schedule set, paid orders on a replaced day", () => {
  it("reports a failed orders read and resolves, so the hook runs",
    async () => {
      const lines = await replacedReport(async () => {
        throw new Error("Blobs answered 503");
      }, moved, terms);

      assert.deepEqual(lines, [
        "Couldn't count paid orders on 2026-11-26: Blobs answered 503",
      ]);
    });

  it("reads no orders when the schedule moves no delivery", async () => {
    let reads = 0;
    const lines = await replacedReport(async () => {
      reads += 1;
      return [];
    }, [], terms);

    assert.equal(reads, 0);
    assert.deepEqual(lines, []);
  });

  it("names the paid delivery orders still on the replaced day",
    async () => {
      const order = (id, status, method, date) => ({
        id, status, fulfilment: { method, date },
      });
      const orders = [
        order("b", "paid", "delivery", "2026-11-26"),
        order("a", "paid", "delivery", "2026-11-26"),
        order("c", "cancelled", "delivery", "2026-11-26"),
        order("d", "paid", "pickup", "2026-11-26"),
      ];
      const lines = await replacedReport(
        async () => paidOnReplaced(orders, moved, terms), moved, terms);

      assert.deepEqual(lines, [
        "Delivery moved to 2026-11-25 from 2026-11-26: 2 paid delivery " +
          "orders still on 2026-11-26 (a, b).",
      ]);
    });
});
