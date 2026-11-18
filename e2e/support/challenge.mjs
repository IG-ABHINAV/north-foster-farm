// Netlify's bot protection can answer a request with its own page in
// place of the site's: a 403 whose script solves a proof of work and
// posts it to /.netlify/submit-challenge. The full staging run
// 44379156341 met it mid-run, and four tests failed on what followed
// (the order page with no stock, a 403 from the e2e endpoint) with
// nothing naming the cause. This recognises that page, so a spec that
// meets it fails saying so. It retries nothing.

const MARK = "submit-challenge";

// Whether a response is the challenge, from its status and body.
export const isChallenge = (status, body) => (
  status === 403 && typeof body === "string" && body.includes(MARK)
);

// The error to throw for one: names the challenge, not its page.
export const challengeError = (what, status) => new Error(
  `${what}: ${status} from Netlify's bot challenge, not the site ` +
  "(staging's bot protection; e2e/support/challenge.mjs)"
);

// The challenged requests of the test running in this worker, filled
// by the watchers in counted.mjs and read when the test ends.
let seen = [];

export const noteChallenge = (url) => {
  seen.push(url);
};

// -> the challenged URLs since the last call, and clears them.
export const takeChallenges = () => {
  const urls = seen;

  seen = [];

  return urls;
};

// For a watcher: notes the response if it is the challenge. Reading a
// 403's body costs nothing a passing run pays.
export const checkResponse = async (status, url, body) => {
  if (status !== 403) return;
  try {
    if (isChallenge(status, await body())) noteChallenge(url);
  } catch {
    // A body that can't be read is not the challenge's to explain.
  }
};
