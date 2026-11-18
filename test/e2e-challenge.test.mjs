// The e2e helper challenge.mjs: telling Netlify's bot challenge from a
// 403 of the site's own. The body is cut from the one the full staging
// run 44379156341 logged (2026-11-18), its token already masked there.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  challengeError, checkResponse, isChallenge, takeChallenges,
} from "../e2e/support/challenge.mjs";

const CHALLENGE = "<!doctype html><html lang=en><meta charset=utf-8>" +
  "<title>staging--north-foster-farm.netlify.app</title><script>" +
  "solve(\"1a484d5ecca8ec9e\", difficulty).then(function (result) {" +
  "return fetch(\"\\/.netlify\\/submit-challenge\", {method: \"POST\"," +
  "body: JSON.stringify({token: \"***\", nonce: result.nonce})});" +
  "});</script>";

test("a 403 with the challenge's script is the challenge", () => {
  assert.equal(isChallenge(403, CHALLENGE), true);
});

test("the site's own 403 and other statuses are not", () => {
  assert.equal(isChallenge(403, "{\"error\":\"forbidden\"}"), false);
  assert.equal(isChallenge(401, CHALLENGE), false);
  assert.equal(isChallenge(403, undefined), false);
});

test("the error names the challenge, not its page", () => {
  const { message } = challengeError("e2e stock.unpin", 403);

  assert.match(message, /^e2e stock\.unpin: 403 from Netlify's bot challenge/);
  assert.doesNotMatch(message, /doctype/);
});

test("a watcher notes a challenged URL once, and taking clears it",
  async () => {
    takeChallenges();
    await checkResponse(403, "https://x.test/api/stock", () => CHALLENGE);
    await checkResponse(403, "https://x.test/api/me", () => "nope");
    await checkResponse(200, "https://x.test/", () => CHALLENGE);
    await checkResponse(403, "https://x.test/a", () => {
      throw new Error("closed");
    });
    assert.deepEqual(takeChallenges(), ["https://x.test/api/stock"]);
    assert.deepEqual(takeChallenges(), []);
  });
