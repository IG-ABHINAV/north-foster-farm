// The one email rule (#678), for the browser's forms and the server
// alike: the order gate, sign-in, the access gate and the group log
// all import it.
//
// Normalizing trims, lowercases and drops trailing periods, so
// "Pat@Example.com." and "pat@example.com" are the same address.
// Validating takes anything without spaces before the @, and after it
// a domain of labels of letters, digits and hyphens joined by single
// periods, no hyphen at either end of a label, and a final label of
// at least two letters. That is stricter than type="email", which
// lets "you@farm" through, and refuses what Square refuses, such as
// "name@example..com".

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const ADDRESS = new RegExp(`^[^\\s@]+@(?:${LABEL}\\.)+[a-z]{2,}$`, "i");

export const normalizeEmail = (value) =>
  String(value || "").trim().toLowerCase().replace(/\.+$/, "");

export const looksLikeEmail = (value) => ADDRESS.test(normalizeEmail(value));
