// The email rule on hostile input (#678, round two): normalizing runs
// in linear time and gives the same answer twice, and an address over
// 254 characters is refused.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  looksLikeEmail, mayBeEmail, normalizeEmail,
} from "../assets/scripts/utils/email.js";

const MILLION = 1_000_000;

// The time `fn` takes, in milliseconds.
const timed = (fn) => {
  const start = process.hrtime.bigint();

  fn();

  return Number(process.hrtime.bigint() - start) / 1e6;
};

describe("normalizing in linear time", () => {
  for (const [name, value] of [
    ["a million periods, then x", `${".".repeat(MILLION)}x`],
    ["a million periods at the end", `a@b.com${".".repeat(MILLION)}`],
    ["a million spaces and periods, then x", `${". ".repeat(MILLION)}x`],
    ["a million spaces at the end", `a@b.com${" ".repeat(MILLION)}`],
  ]) {
    it(`normalizes and validates ${name} in well under 100 ms`, () => {
      const ms = timed(() => {
        normalizeEmail(value);
        looksLikeEmail(value);
      });

      assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
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
