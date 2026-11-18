// The keyboard walk's page list, read from the local build's sitemap
// when Playwright collects the tests (#607; e2e/support/canned.mjs).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  builtSitemap, namedPages, sitemapLocs,
} from "../e2e/support/canned.mjs";

const dir = mkdtempSync(join(tmpdir(), "e2e-pages-"));

after(() => rmSync(dir, { recursive: true, force: true }));

// Two of the build's own lines, as serve.mjs writes them for port 8895.
const xml = (origin) => [
  "<urlset>",
  `<url><loc>${origin}/news/august-update/</loc></url>`,
  `<url><loc>${origin}/</loc></url>`,
  "</urlset>",
].join("\n");

const file = (name, text) => {
  const path = join(dir, name);

  writeFileSync(path, text);

  return path;
};

describe("sitemapLocs", () => {
  it("reads every address", () => {
    assert.deepEqual(
      sitemapLocs(xml("http://localhost:8895")).map((u) => u.href),
      ["http://localhost:8895/news/august-update/", "http://localhost:8895/"],
    );
  });
});

describe("builtSitemap", () => {
  it("gives the paths of a build for the site under test", () => {
    assert.deepEqual(
      builtSitemap("http://localhost:8895",
        file("ours.xml", xml("http://localhost:8895"))),
      ["/news/august-update/", "/"],
    );
  });

  it("is null for a build served on another port", () => {
    assert.equal(builtSitemap("http://localhost:8895",
      file("other.xml", xml("http://localhost:9000"))), null);
  });

  it("is null against staging, with no build of its own", () => {
    assert.equal(builtSitemap(
      "https://staging--north-foster-farm.netlify.app",
      file("local.xml", xml("http://localhost:8895")),
    ), null);
  });

  it("is null with no build or no base URL", () => {
    assert.equal(builtSitemap("http://localhost:8895",
      join(dir, "missing.xml")), null);
    assert.equal(builtSitemap(undefined,
      file("unset.xml", xml("http://localhost:8895"))), null);
  });

  it("is null for an empty sitemap", () => {
    assert.equal(builtSitemap("http://localhost:8895",
      file("empty.xml", "<urlset></urlset>")), null);
  });
});

describe("namedPages", () => {
  const paths = ["/", "/about/", "/news/", "/404.html"];

  it("is every page when none is named", () => {
    assert.deepEqual(namedPages(paths, undefined), paths);
    assert.deepEqual(namedPages(paths, " "), paths);
  });

  it("keeps the named pages in the walk's order", () => {
    assert.deepEqual(namedPages(paths, "/404.html  /"), ["/", "/404.html"]);
  });

  it("throws on a page the walk doesn't have", () => {
    assert.throws(() => namedPages(paths, "/about/ /abuot/"),
      /E2E_PAGES names pages the walk doesn't have: \/abuot\//);
  });
});
