// The implementer's own tests for #684, beside the criteria tests in
// credit-restore-once.test.mjs: what a repeated restore answers, a
// restore with no refund id, and the refund id refundOrder passes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { refundOrder } from "../netlify/functions/lib/admin.mjs";
import {
  creditBalance, getLedger, grantCredit, restoreCredit, spendCredit,
} from "../netlify/functions/lib/credit.mjs";
import { saveOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const tz = "America/New_York";
const ny = (iso, h = 9) => instant(iso, h, 0, tz);
const EMAIL = "pat@example.com";
const ORDER = "NFF-2611-K3WM";

// A member with two grants, $15 of them spent on ORDER across both.
const member = async (stores) => {
  await grantCredit(stores, EMAIL, {
    amount: 1_000, from: { group: "vff", round: "2026-11-08", kind: "host" },
    now: ny("2026-11-09"), timeZone: tz,
  });
  await grantCredit(stores, EMAIL, {
    amount: 1_000, from: { group: "vff", round: "2026-11-22", kind: "host" },
    now: ny("2026-11-23"), timeZone: tz,
  });
  await spendCredit(stores, EMAIL, {
    orderId: ORDER, amount: 1_500, now: ny("2026-11-24"),
  });
};

const lines = (ledger) => ledger.entries.flatMap((e) => e.spent)
  .filter((x) => x.refund);

describe("a restore's refund id (#684)", () => {
  it("names the refund on every line it adds, across grants", async () => {
    const stores = testStores();
    const now = ny("2026-11-25");

    await member(stores);
    await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 1_200, refundId: "r-1", now,
    });

    const added = lines(await getLedger(stores, EMAIL));

    assert.equal(added.length, 2);
    assert.ok(added.every((x) => x.refundId === "r-1"));
  });

  it("answers a repeat with what the refund put back the first time",
    async () => {
      const stores = testStores();
      const now = ny("2026-11-25");

      await member(stores);

      const first = await restoreCredit(stores, EMAIL, {
        orderId: ORDER, amount: 1_200, refundId: "r-1", now,
      });
      const again = await restoreCredit(stores, EMAIL, {
        orderId: ORDER, amount: 1_200, refundId: "r-1", now,
      });

      assert.equal(first.restored, 1_200);
      assert.equal(again.restored, 1_200);
      assert.equal(await creditBalance(stores, EMAIL, now), 1_700);
      assert.equal(lines(again.ledger).length, 2);
    });

  it("restores every time without a refund id, as before", async () => {
    const stores = testStores();
    const now = ny("2026-11-25");

    await member(stores);
    await restoreCredit(stores, EMAIL, { orderId: ORDER, amount: 400, now });
    await restoreCredit(stores, EMAIL, { orderId: ORDER, amount: 400, now });

    const added = lines(await getLedger(stores, EMAIL));

    assert.equal(await creditBalance(stores, EMAIL, now), 1_300);
    assert.ok(added.every((x) => !("refundId" in x)));
  });

  it("is the refund's key when refundOrder puts credit back, so an " +
    "edit's refund retried by its key goes back once", async () => {
    const stores = testStores();
    const now = ny("2026-11-25");

    await member(stores);
    await saveOrder(stores, {
      id: ORDER, status: "paid", submittedAt: "2026-11-24T14:00:00.000Z",
      customer: { email: EMAIL, name: "pat" },
      creditFrom: EMAIL,
      lines: [],
      totals: { total: 1_500 },
      payments: [{ amount: 1_500, via: "credit" }],
      refunds: [],
    }, ny("2026-11-24"));

    await refundOrder(stores, ORDER, {
      now, amount: 500, key: "edit-k", env: {},
    });

    const added = lines(await getLedger(stores, EMAIL));

    assert.deepEqual(added.map((x) => [x.refundId, x.amount]),
      [["edit-k-0", -500]]);

    // The ledger kept the restore and the order lost its record of it:
    // the retry asks again under the same key.
    await restoreCredit(stores, EMAIL, {
      orderId: ORDER, amount: 500, refundId: "edit-k-0", now,
    });
    assert.equal(await creditBalance(stores, EMAIL, now), 1_000);
  });
});
