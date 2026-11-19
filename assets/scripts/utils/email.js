// The one email rule (#678), for the browser's forms and the server
// alike: the order gate, sign-in, the access gate and the group log
// all import it.
//
// Normalizing drops trailing periods and spaces together, trims and
// lowercases, so "Pat@Example.com." and "pat@example.com" are the
// same address. It runs in linear time on any input, and normalizing
// twice gives what normalizing once did.
// Validating takes at most 254 characters: anything without spaces
// before the @, and after it a domain of labels of letters, digits
// and hyphens joined by single periods, no hyphen at either end of a
// label, and a final label of at least two letters. That is stricter
// than type="email", which lets "you@farm" through, and refuses what
// Square refuses, such as "name@example..com".

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const ADDRESS = new RegExp(`^[^\\s@]+@(?:${LABEL}\\.)+[a-z]{2,}$`, "i");
const MAX = 254;
const SPACE = /\s/;

// Whether `c` is a period or a space of any kind, the commonest first.
const trailing = (c) => c === "." || c === " " || SPACE.test(c);

export const normalizeEmail = (value) => {
  const s = String(value || "");
  let end = s.length;

  while (end > 0 && trailing(s[end - 1])) end -= 1;

  return s.slice(0, end).trim().toLowerCase();
};

export const looksLikeEmail = (value) => {
  const address = normalizeEmail(value);

  return address.length <= MAX && ADDRESS.test(address);
};

// Whether a whole value may be an address, valid or not: one "@" and
// no space once trimmed. For masking, where missing an address the
// rule refuses would leave it in full.
export const mayBeEmail = (value) => {
  const s = String(value || "").trim();
  const at = s.indexOf("@");

  return at >= 0 && at === s.lastIndexOf("@") && !/\s/.test(s);
};
