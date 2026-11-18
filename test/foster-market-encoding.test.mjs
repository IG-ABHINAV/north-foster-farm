// The implementer's own check for #628, beside the criteria tests in
// test/foster-market.test.mjs. Their pattern looks for the market's
// name in any spelling; a curly apostrophe saved as double-encoded
// UTF-8 ("Farmersâ\u0080\u0099") is no spelling it knows, so it would
// pass there and print as mojibake on every page, email and slip.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const DIRS = ["content", "layouts", "data", "assets/scripts",
  "netlify/functions"];

// U+2019 written as UTF-8, read as Latin-1 and written as UTF-8 again.
const MOJIBAKE = "â\u0080\u0099";

const files = (dir) => readdirSync(join(ROOT, dir), {
  recursive: true, withFileTypes: true,
}).filter((e) => e.isFile() && /\.(md|html|json|m?js)$/.test(e.name))
  .map((e) => join(e.parentPath, e.name));

describe("#628: the Foster market's apostrophe", () => {
  it("is U+2019 in the series data", () => {
    const { series } = JSON.parse(readFileSync(
      join(ROOT, "data/series.json"), "utf8"));
    const name = series.find((s) => s.code === "WAC5").name;

    assert.deepEqual([...name].filter((ch) => ch > "~"), ["’"]);
  });

  it("is never double-encoded in a customer-read source", () => {
    const bad = DIRS.flatMap(files)
      .filter((file) => readFileSync(file, "utf8").includes(MOJIBAKE))
      .map((file) => relative(ROOT, file));

    assert.deepEqual(bad, []);
  });
});
