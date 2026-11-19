// A conditional write counts as made only when the store clearly took
// it (#677). The real @netlify/blobs client runs over a fake of its
// edge API, which answers each PUT with a bare status and an etag, as
// the edge does (the shape test/cancel-lost-write.test.mjs uses).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The client sleeps 5 s before each retry unless NODE_ENV is test
// (src/retry.ts), and test/setup.mjs drops NODE_ENV. Set before the
// client loads.
process.env.NODE_ENV = "test";

const { getStore } = await import("@netlify/blobs");
const { maskKey, wrap } = await import("../netlify/functions/lib/store.mjs");
const { updateOrder } = await import("../netlify/functions/lib/records.mjs");

const EDGE = "https://blobs.test";

// `answer(n, stored)` may answer the nth PUT itself, after the edge
// has stored it or not (`stored`), with a status of its own.
const edge = (seed, answer = () => null) => {
  const blobs = new Map();
  let tag = 0;
  let puts = 0;
  const put = (path, text) => {
    tag += 1;
    blobs.set(path, { text, etag: `"e${tag}"` });
  };

  for (const [path, value] of seed) put(path, JSON.stringify(value));

  const fetch = async (url, options = {}) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const method = (options.method || "get").toLowerCase();
    const headers = options.headers || {};
    const found = blobs.get(path);

    if (method === "get") {
      return found
        ? new Response(found.text, {
          status: 200, headers: { etag: found.etag },
        })
        : new Response(null, { status: 404 });
    }
    if (method === "delete") {
      blobs.delete(path);

      return new Response(null, { status: 204 });
    }
    if (method !== "put") throw new Error(`fake edge: no ${method}`);

    puts += 1;

    const refused = (headers["if-match"]
      && (!found || found.etag !== headers["if-match"]))
      || (headers["if-none-match"] === "*" && found);

    if (!refused) put(path, options.body);

    const own = answer(puts, !refused);

    if (own) return new Response(null, { status: own });

    return refused
      ? new Response(null, { status: 412 })
      : new Response(null, {
        status: 200, headers: { etag: blobs.get(path).etag },
      });
  };

  return { fetch, read: (path) => JSON.parse(blobs.get(path).text) };
};

const storeOver = (fetch) => wrap(getStore({
  name: "orders", siteID: "site", token: "t", consistency: "strong",
  edgeURL: EDGE, uncachedEdgeURL: EDGE, fetch,
}));

// The fake's reads, with every PUT refused unstored with `status`.
const refusingPuts = (fake, status) => async (url, options = {}) => (
  (options.method || "get").toLowerCase() === "put"
    ? new Response(null, { status })
    : fake.fetch(url, options));

const PATH = "/site/site:orders/order/NFF-1001";
const KEY = "order/NFF-1001";
const ORDER = { id: "NFF-1001", customer: { email: "pat@example.com" } };

const watch = (t) => {
  const lines = [];

  t.mock.method(console, "warn", (text) => {
    lines.push(JSON.parse(text));
  });

  return lines;
};

describe("a conditional write through the store", () => {
  it("counts a 200 as made, unlogged", async (t) => {
    const lines = watch(t);
    const fake = edge([[PATH, { n: 1 }]]);
    const store = storeOver(fake.fetch);
    const { etag } = await store.getTagged(KEY);

    assert.equal(await store.swap(KEY, { n: 2 }, etag), true);
    assert.deepEqual(fake.read(PATH), { n: 2 });
    assert.deepEqual(lines, []);
  });

  it("counts a 409 that stored nothing as not made, and logs it",
    async (t) => {
      const lines = watch(t);
      const fake = edge([[PATH, { n: 1, secret: "contents" }]]);
      const store = storeOver(refusingPuts(fake, 409));
      const { etag } = await store.getTagged(KEY);

      assert.equal(await store.swap(KEY, { n: 2 }, etag), false);
      assert.deepEqual(fake.read(PATH), { n: 1, secret: "contents" });
      assert.deepEqual(lines.map((l) => [l.event, l.store, l.key, l.status]),
        [["blobs.write_refused", "orders", "order/nff**001", 409]]);
      assert.ok(!JSON.stringify(lines).includes("contents"));
    });

  it("counts a write the store took but answered 503 to as made",
    async (t) => {
      const lines = watch(t);
      const fake = edge([[PATH, { n: 1 }]], () => 503);
      const store = storeOver(fake.fetch);
      const { etag } = await store.getTagged(KEY);

      assert.equal(await store.swap(KEY, { n: 2 }, etag), true);
      assert.deepEqual(fake.read(PATH), { n: 2 });
      assert.equal(lines.at(-1).event, "blobs.answer_lost");
    });

  it("counts a write as made when the client's retry of it met a 412",
    async (t) => {
      const lines = watch(t);
      // The first PUT is stored and answered 500; the client sends it
      // again with the old etag, and that one is refused.
      const fake = edge([[PATH, { n: 1 }]], (n) => (n === 1 ? 500 : null));
      const store = storeOver(fake.fetch);
      const { etag } = await store.getTagged(KEY);

      assert.equal(await store.swap(KEY, { n: 2 }, etag), true);
      assert.deepEqual(fake.read(PATH), { n: 2 });
      assert.deepEqual(
        lines.filter((l) => l.event.startsWith("blobs.answer"))
          .map((l) => l.status), [412],
      );
    });

  it("leaves a change applied once when its answer was lost",
    async (t) => {
      watch(t);
      const fake = edge([[PATH, { ...ORDER, history: [] }]],
        (n) => (n === 1 ? 500 : null));
      const stores = { orders: storeOver(fake.fetch) };

      await updateOrder(stores, "NFF-1001", (order) => ({
        ...order, history: [...order.history, { event: "noted" }],
      }));

      assert.deepEqual(fake.read(PATH).history, [{ event: "noted" }]);
    });

  it("throws when the store refuses every try, each refusal logged",
    async (t) => {
      const lines = watch(t);
      const fake = edge([[PATH, { ...ORDER, status: "paid" }]]);
      const stores = { orders: storeOver(refusingPuts(fake, 409)) };

      await assert.rejects(updateOrder(stores, "NFF-1001", (order) => ({
        ...order, status: "cancelled",
      })), /too fast to save/);
      assert.equal(fake.read(PATH).status, "paid");
      assert.equal(lines.length, 8);
      assert.ok(lines.every((l) => l.event === "blobs.write_refused"
        && l.status === 409 && l.key === "order/nff**001"));
      assert.ok(!JSON.stringify(lines).includes("paid"));
    });
});

describe("a create through the store", () => {
  it("is false when another value holds the key", async (t) => {
    watch(t);
    const fake = edge([[PATH, { key: "theirs" }]]);

    assert.equal(await storeOver(fake.fetch).create(KEY, { key: "mine" }),
      false);
  });

  it("throws when refused with the key still empty", async (t) => {
    watch(t);
    const store = storeOver(refusingPuts(edge([]), 409));

    await assert.rejects(store.create(KEY, { key: "mine" }),
      /refused to create order\/nff\*\*001/);
  });
});

describe("maskKey", () => {
  it("keeps the kind and masks every part after it", () => {
    assert.equal(maskKey("customer/pat.smith@example.com"),
      "customer/pat***ith@exa*****com");
    assert.equal(maskKey("by-email/pat@example.com/NFF-1001"),
      "by-email/***@exa*****com/nff**001");
    assert.equal(maskKey("jobs"), "jobs");
  });
});
