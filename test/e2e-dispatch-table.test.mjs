// The implementer's guard on e2e/dispatch.json (#610): what a shared
// file runs is shared too. A partial a shared template or shortcode
// calls renders on every page that file does, and a module a shared
// script imports runs wherever that script does, so mapping either to
// one page would select too few specs when it changes.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const TABLE = JSON.parse(readFileSync(join(root, "e2e/dispatch.json"),
  "utf8"));
const shared = (path) => TABLE.shared.some((g) => matchesGlob(path, g));
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);

  return statSync(p).isDirectory() ? walk(p) : [p];
});
const rel = (p) => relative(root, p);

// Every literal partial a template calls, as a repository path.
const CALL = /\bpartials?(?:Cached|\.Include(?:Cached)?)?\s+"([^"]+)"/g;
const partialsOf = (file) => [...readFileSync(file, "utf8")
  .matchAll(CALL)]
  .map((m) => `layouts/partials/${/\.\w+$/.test(m[1]) ? m[1]
    : `${m[1]}.html`}`)
  .filter((p) => existsSync(join(root, p)));

const IMPORT = /(?:import|from)\s*\(?\s*["'](\.[^"']+)["']/g;
const importsOf = (file) => [...readFileSync(file, "utf8")
  .matchAll(IMPORT)]
  .map((m) => resolve(dirname(file), m[1]))
  .filter((p) => existsSync(p) && statSync(p).isFile())
  .map(rel);

// The files a shared file reaches, directly or not, that are not shared.
const unshared = (files, next) => {
  const missing = new Set();
  const seen = new Set();
  const visit = (path, from) => {
    for (const to of next(join(root, path))) {
      if (!shared(to)) missing.add(`${to} (from ${from})`);
      if (seen.has(to)) continue;
      seen.add(to);
      visit(to, from);
    }
  };

  files.filter(shared).forEach((f) => visit(f, f));

  return [...missing].sort();
};

describe("e2e/dispatch.json's shared files", () => {
  it("shares every partial a shared template or shortcode calls", () => {
    const templates = walk(join(root, "layouts")).map(rel);

    assert.deepEqual(unshared(templates, partialsOf), []);
  });

  it("shares every module a shared script imports", () => {
    const scripts = walk(join(root, "assets/scripts")).map(rel)
      .filter((f) => /\.m?js$/.test(f));

    assert.deepEqual(unshared(scripts, importsOf), []);
  });

  it("shares the table itself, so a change to it runs every spec", () => {
    assert.ok(shared("e2e/dispatch.json"));
  });
});
