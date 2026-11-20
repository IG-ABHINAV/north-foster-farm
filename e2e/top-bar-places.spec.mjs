// #682: the top bar's link for an event that is not a pop-up and has
// no link of its own opens the home page's map on its Places layer
// (/#places), not the ZIP check (/#map). A pop-up's link and an
// event's own link are unchanged, and every other #map link still
// lands on the ZIP check as #606 left it.
//
// data/series.json gives the top bar pop-ups only, so no build of the
// site shows the first two cases. The tests build the real
// layouts/partials/top-bar.html in a small Hugo site of their own,
// whose lib/pickup-lists.html hands it one event per page, and set
// the bar it prints on a page of the real site. Site data is not
// touched.

import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import launchEmail from "../data/emails/launch-email.json"
  with { type: "json" };
import { expect, test } from "./support/order.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = "#home-map-zip-input";

// A day well ahead, so the bar's build never sees the event as ended.
const ahead = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);

const address = {
  street: "1 Fixture Road", city: "Foster", state: "RI", zip: "02825",
};

// One event per fixture page: the bar's three kinds of link.
const EVENTS = {
  plain: {
    id: "fx-plain", kind: "market", name: "Fixture Farm Day",
    place: "Fixture Hall", slug: "fixture-hall", date: ahead,
    start: "10:00", end: "14:00", address,
  },
  "pop-up": {
    id: "fx-pop", kind: "pop-up", name: "Fixture Pop-up",
    place: "Fixture Barn", slug: "fixture-barn", date: ahead,
    start: "10:00", end: "14:00", address,
  },
  "own-link": {
    id: "fx-own", kind: "market", name: "Fixture Supper",
    place: "Fixture Grange", slug: "fixture-grange", date: ahead,
    start: "17:00", end: "20:00", address,
    href: "https://example.com/fixture-supper",
  },
};

// Builds the fixture site and returns each page's top bar, as HTML.
const buildBars = () => {
  const site = mkdtempSync(join(tmpdir(), "nff-top-bar-site-"));
  const out = mkdtempSync(join(tmpdir(), "nff-top-bar-build-"));
  const put = (path, text) => {
    mkdirSync(dirname(join(site, path)), { recursive: true });
    writeFileSync(join(site, path), text);
  };

  try {
    put("hugo.toml", [
      'baseURL = "/"',
      'disableKinds = ["taxonomy", "term", "RSS", "sitemap"]',
      "",
    ].join("\n"));
    put("data/fixture.json", JSON.stringify({ events: EVENTS }));
    put("layouts/partials/top-bar.html", readFileSync(
      join(root, "layouts/partials/top-bar.html"), "utf8"));
    put("layouts/partials/lib/pickup-lists.html", [
      "{{- $e := index hugo.Data.fixture.events .Params.fixture -}}",
      '{{- return (dict "markets" slice "events" (slice $e)) -}}',
      "",
    ].join("\n"));
    put("layouts/single.html", '{{ partial "top-bar.html" . }}\n');
    put("layouts/home.html", "home\n");
    for (const name of Object.keys(EVENTS)) {
      put(`content/${name}.md`,
        `---\ntitle: ${name}\nfixture: ${name}\n---\n`);
    }

    const run = spawnSync("hugo", ["--quiet", "-s", site, "-d", out],
      { encoding: "utf8" });

    if (run.status !== 0) {
      throw new Error(`fixture build failed: ${run.stderr || run.error}`);
    }

    return Object.fromEntries(Object.keys(EVENTS).map((name) => [
      name,
      readFileSync(join(out, name, "index.html"), "utf8").trim(),
    ]));
  } finally {
    rmSync(site, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
};

// Sets a fixture bar on the page in place of the build's own.
const showBar = async (page, html) => {
  await page.evaluate((markup) => {
    document.querySelector("[data-top-bar]")?.remove();
    document.body.insertAdjacentHTML("afterbegin", markup);
  }, html);

  return page.locator("[data-top-bar] a.top-bar-link");
};

// The home page scrolls smoothly to its anchor, and the schedule can
// lay out rows above the map after the first paint: wait for the
// network to go quiet and the ZIP field to hold still, as
// map-link.spec.mjs does (#606).
const settledBox = async (page) => {
  await page.waitForLoadState("networkidle");

  let last = null;
  let still = 0;

  await expect.poll(async () => {
    const now = await page.locator(INPUT).evaluate((el) => {
      const r = el.getBoundingClientRect();

      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        scrollY: Math.round(window.scrollY),
      };
    });
    const same = last && now.top === last.top && now.bottom === last.bottom
      && now.scrollY === last.scrollY;

    still = same ? still + 1 : 0;
    last = now;

    return still;
  }, { intervals: [100], timeout: 15_000 }).toBeGreaterThanOrEqual(5);

  return last;
};

// #606's landing: the field's whole box in the window's upper two
// thirds.
const expectZipCheck = async (page, what) => {
  await expect(page, what).toHaveURL(/\/#map$/);

  const box = await settledBox(page);
  const height = page.viewportSize().height;
  const limit = Math.floor(height * 2 / 3);

  expect(box.top, `${what}: the field's top is on screen`)
    .toBeGreaterThanOrEqual(0);
  expect(box.bottom, `${what}: the field's bottom (${box.bottom} of ` +
    `${height}) is within the window's upper two thirds (${limit})`)
    .toBeLessThanOrEqual(limit);
};

test.describe("the top bar's link to the map (#682)", () => {
  let bars;

  test.beforeAll(() => {
    bars = buildBars();
  });

  test("the top bar's link for an event that is not a pop-up and has "
    + "no link of its own is /#places, and following it opens the home "
    + "page's map on the Places layer", async ({ page }) => {
    await page.goto("/about/");

    const link = await showBar(page, bars.plain);

    await expect(link).toHaveAttribute("href", /^\/#places$/);
    await expect(link).not.toHaveAttribute("target", /./);

    await link.click();
    await expect(page).toHaveURL(/\/#places$/);
    await expect(page.locator("[data-map]").first())
      .toHaveAttribute("data-layer", "places");
  });

  test("a pop-up's top bar link and an event's own link are unchanged",
    async ({ page }) => {
      await page.goto("/about/");

      const popUp = await showBar(page, bars["pop-up"]);

      await expect(popUp, "the pop-up opens its card on the map")
        .toHaveAttribute("href", /^\/#place-fixture-barn$/);
      await expect(popUp).not.toHaveAttribute("target", /./);

      const own = await showBar(page, bars["own-link"]);

      await expect(own, "the event's own link")
        .toHaveAttribute("href", EVENTS["own-link"].href);
      await expect(own).toHaveAttribute("target", "_blank");
      await expect(own).toHaveAttribute("rel", "noopener");
    });

  test("every other link to #map (the news post, the order page's "
    + "delivery card, the launch email) still lands on the ZIP check as "
    + "#606 left it", async ({ page }) => {
    // The news post's "our map", followed in place.
    await page.goto("/news/three-quarters-of-the-way/");
    await page.locator("main .prose")
      .getByRole("link", { name: "our map" }).click();
    await expectZipCheck(page, "the news post");

    // The order page's delivery card opens the map in a new tab: go to
    // its address in this one.
    await page.goto("/order/");

    const card = page.locator("a.order-method-map[data-map-link='map']");

    await expect(card).toHaveCount(1);
    await page.goto(await card.getAttribute("href"));
    await expectZipCheck(page, "the order page's delivery card");

    // The launch email's link, at its path on this site, from another
    // page: a goto to the /#map already open would only set the hash.
    await page.goto("/about/");

    const sent = launchEmail.body.match(/https:\/\/[^\s)]+#map\b/);

    expect(sent, "the launch email links to the map").not.toBeNull();

    const url = new URL(sent[0]);

    await page.goto(url.pathname + url.hash);
    await expectZipCheck(page, "the launch email");
  });
});
