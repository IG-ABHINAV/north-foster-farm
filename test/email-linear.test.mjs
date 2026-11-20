// The email rule on hostile input (#678, round two): normalizing runs
// in linear time and gives the same answer twice, and an address over
// 254 characters is refused.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  looksLikeEmail, mayBeEmail, normalizeEmail,
} from "../assets/scripts/utils/email.js";

const MILLION = 1_000_000;

// The CPU time this thread has used, in milliseconds. Unlike the
// clock, it stops while the thread waits for a core, so a busy
// machine barely moves it: on 2026-11-20, at load averages near 100,
// the clock made a million characters take 30 to 90 times as long as
// 125,000 (#689).
const cpuMs = () => {
  const { user, system } = process.threadCpuUsage();

  return (user + system) / 1e3;
};

// The CPU time one call of `fn` takes, in milliseconds: the average
// over as many calls as fill 20 ms, so a call of a few microseconds
// is still measured well.
const timed = (fn) => {
  const start = cpuMs();
  let calls = 0;
  let spent = 0;

  while (spent < 20 && calls < 100_000) {
    fn();
    calls += 1;
    spent = cpuMs() - start;
  }

  return spent / calls;
};

// A call this long ends the climb: a quadratic rule reaches it within
// a few doublings, long before a million, where it would take hours.
const ENOUGH_MS = 250;

// How much longer normalizing and validating `make(n)` takes when n
// grows eightfold, measured at the largest n reached, doubling from
// about 1,000 up to a million or until a run takes ENOUGH_MS. A
// linear rule takes about 8 times as long and a quadratic one about
// 64, whatever the load (#689).
const growth = (make) => {
  const runs = [];

  for (let k = 10; k >= 0; k -= 1) {
    const n = Math.round(MILLION / 2 ** k);
    const value = make(n);
    const ms = timed(() => {
      normalizeEmail(value);
      looksLikeEmail(value);
    });

    runs.push({ n, ms });
    if (ms >= ENOUGH_MS) break;
  }

  const last = runs.at(-1);
  const first = runs.at(-4) || runs[0];
  const note = `${first.n}: ${first.ms.toFixed(2)} ms, `
    + `${last.n}: ${last.ms.toFixed(2)} ms`;

  return { ratio: runs.length < 4 ? Infinity : last.ms / first.ms, note };
};

describe("normalizing in linear time", () => {
  for (const [name, make] of [
    ["periods, then x", (n) => `${".".repeat(n)}x`],
    ["periods at the end", (n) => `a@b.com${".".repeat(n)}`],
    ["spaces and periods, then x", (n) => `${". ".repeat(n)}x`],
    ["spaces at the end", (n) => `a@b.com${" ".repeat(n)}`],
  ]) {
    it(`takes time in proportion to ${name}`, (t) => {
      // Warms the rule up, so the first sizes time compiled code.
      growth((n) => make(Math.min(n, 1_000)));

      const { ratio, note } = growth(make);

      t.diagnostic(`${ratio.toFixed(1)}x, ${note}`);
      assert.ok(ratio < 24, `${ratio.toFixed(1)} times as long, ${note}`);
    });
  }
});

describe("normalizing twice", () => {
  it("gives what normalizing once did", () => {
    for (const value of [
      "a@b.com .", "a@b.com. ", " A@B.COM.. ", "a@b.com", "a@b.com.",
      "a@b.com \t.\n", ". .a@b.com", "", " ", ".", ". . .",
      "Pat@Example.COM.", "a@b.com .", "İ@b.com.",
    ]) {
      const once = normalizeEmail(value);

      assert.equal(normalizeEmail(once), once, JSON.stringify(value));
      assert.equal(looksLikeEmail(once), looksLikeEmail(value),
        JSON.stringify(value));
    }
  });

  it("drops spaces and periods mixed at the end", () => {
    assert.equal(normalizeEmail("a@b.com ."), "a@b.com");
    assert.equal(normalizeEmail("a@b.com. "), "a@b.com");
    assert.equal(normalizeEmail(" A@B.COM.. "), "a@b.com");
  });
});

describe("the length limit", () => {
  // An address `length` characters long: a's, then @example.com.
  const address = (length) => {
    const domain = "example.com";
    const local = "a".repeat(length - domain.length - 1);

    return `${local}@${domain}`;
  };

  it("refuses a 255-character address", () => {
    assert.equal(address(255).length, 255);
    assert.equal(looksLikeEmail(address(255)), false);
  });

  it("takes a 254-character address", () => {
    assert.equal(looksLikeEmail(address(254)), true);
  });

  it("counts the length after normalizing, never truncating first", () => {
    const padded = `${address(254)}${" ".repeat(300)}.`;

    assert.equal(looksLikeEmail(padded), true);
    assert.equal(looksLikeEmail(`a@b.com${" ".repeat(300)}junk`), false);
  });
});

describe("whether a value may be an address", () => {
  it("takes one @ and no space, valid or not", () => {
    for (const value of [
      "pat@bücher.de", "pat@ex_ample.com", "pat@[10.0.0.1]",
      " pat@example.com ", "pat@example.com.",
    ]) {
      assert.equal(mayBeEmail(value), true, value);
    }
  });

  it("refuses no @, two of them, or a space", () => {
    for (const value of [
      "", "vff", "a@b@c.com", "asked by pat@example.com", "pat @x.com",
    ]) {
      assert.equal(mayBeEmail(value), false, value);
    }
  });
});
