// The Membership tab for a member of one group who hosts another
// (#495, QA item 4; James, 6458200999), and what the tab says and
// links to since its rebuild (#602, #600) and James's changes to it
// (#608). Each check proves a row of the test agent's criteria
// table, or a line of #608's "Done when"; the layout is
// measured in membership-layout.spec.mjs. The account's endpoints are
// canned (support/membership.mjs), so this runs on a local build, and
// nothing is saved anywhere.

import { expect, test } from "./support/order.mjs";
import {
  CLOSED_ROUNDS, HOSTED_GROUP, MEMBER_GROUP, SVG, VIEW, groups, signIn,
} from "./support/membership.mjs";

// U+00A0 and U+202F (#598).
const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`);

// Each round's two lines as a reader sees them, spaces collapsed.
const roundLines = (block) => block.locator("[data-mem-round]").evaluateAll(
  (cols) => cols.map((col) => Array.from(col.querySelectorAll("p"),
    (p) => p.textContent.replace(/\s+/g, " ").trim()))
);

test.describe("a member of one group who hosts another", () => {
  test("sees both, and the host's part acts on the hosted group",
    async ({ page, context, baseURL }) => {
      const posted = [];

      await signIn(page, context, baseURL);
      await page.route("**/api/membership/qr**", (route) => {
        const req = route.request();

        if (req.method() !== "GET") posted.push(req.postDataJSON());

        return route.fulfill({ contentType: "image/svg+xml", body: SVG });
      });
      await page.goto("/account/#membership");

      const { blocks, own, hosted } = groups(page);

      await expect(blocks).toHaveCount(2);

      // The member's own group: no host's part.
      await expect(own.locator("[data-mem='name']")).toHaveText(MEMBER_GROUP);
      await expect(own.locator("[data-mem-host]")).toBeHidden();
      await expect(page.locator("[data-mem-leave]"))
        .toContainText("Leave the group");

      // The hosted group: its QR code and members, every request
      // naming it.
      await expect(hosted.locator("[data-mem='name']"))
        .toHaveText(HOSTED_GROUP);
      await expect(hosted.locator("[data-mem-host]")).toBeVisible();
      await expect(page.getByRole("region", { name: HOSTED_GROUP }))
        .toBeVisible();
      await expect(hosted.locator("[data-member]"))
        .toContainText("Rob Example");
      await expect(hosted.locator("[data-mem='qr']"))
        .toHaveAttribute("src", /\?group=gym2$/);
      await expect(hosted.locator("[data-mem='download']"))
        .toHaveAttribute("href", /\?group=gym2&download=1$/);

      // #589: the field holds the short link and Copy copies it, and
      // nothing in the pane replaces the code or the link.
      await expect(hosted.getByLabel("Join link"))
        .toHaveValue("http://localhost/gym2");
      await page.evaluate(() => {
        window.copiedText = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.copiedText.push(t); } },
        });
      });
      await hosted.getByRole("button", { name: "Copy" }).click();
      await expect(hosted.locator("[data-mem='link-copied']"))
        .toHaveText("Link copied");
      expect(await page.evaluate(() => window.copiedText))
        .toEqual(["http://localhost/gym2"]);
      await expect(hosted.getByRole("button", { name: /Generate/ }))
        .toHaveCount(0);
      await expect(hosted.locator("[data-mem='rotate']")).toHaveCount(0);
      await expect(hosted).not.toContainText("/join/");
      expect(posted).toEqual([]);
    });
});

test.describe("the rebuilt Membership tab (#602)", () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    await signIn(page, context, baseURL);
  });

  // Criteria 3, 4 and 5: the group's name over its sections, which are
  // headings under it, and its address without the name again.
  test("lists the group's sections in order", async ({ page }) => {
    await page.goto("/account/#membership");

    const { own, hosted } = groups(page);

    await expect(own.getByRole("heading", { level: 2 }))
      .toHaveText(MEMBER_GROUP);
    await expect(own.getByRole("heading", { level: 3 })).toHaveText(
      ["Pickups", "Membership QR code", "Leave the group"]
    );
    await expect(hosted.getByRole("heading", { level: 2 }))
      .toHaveText(HOSTED_GROUP);
    await expect(hosted.getByRole("heading", { level: 3 })).toHaveText(
      ["Pickups", "Invite members", /^Members\b/]
    );

    // The place is named as the group, so the address leaves it out.
    const address = own.locator("[data-mem='address']");

    await expect(address).toBeVisible();
    await expect(address).toContainText("1 Main St");
    await expect(address).toContainText("RI 02825");
    await expect(address).not.toContainText(MEMBER_GROUP);
  });

  // Criteria 6, 11 and 12: James's sketch, the pill first in line 2.
  test("shows each round as two lines", async ({ page }) => {
    await page.goto("/account/#membership");

    const { own, hosted } = groups(page);

    // Polled: the tab draws its rounds after /api/membership answers,
    // and a one-time read before then finds none (run 44396830525).
    await expect.poll(() => roundLines(own)).toEqual([
      ["Sunday, Nov 22 · 8:30 – 9:00 AM",
        "Open Closes at 11:59 PM on Sat, Nov 21"],
      ["Sunday, Dec 6 · 8:30 – 9:00 AM", "Next Opens on Sun, Nov 22"],
    ]);
    // A group with no next round has the open one alone.
    await expect.poll(() => roundLines(hosted)).toEqual([
      ["Sunday, Nov 22 · 8:30 – 9:00 AM",
        "Open Closes at 11:59 PM on Sat, Nov 21"],
    ]);
  });

  // #608, Done when 4 (supersedes #602's criteria 17 and 18, the
  // "Order now" button): the open round's "Open" pill is the order
  // link, named for where it goes, reached by Tab and drawn with a
  // focus ring; no "Order now" button; the Next and Closed pills are
  // not links. With every kind of round on the tab.
  test("makes the Open pill the order link, with no Order now button",
    async ({ page }) => {
      await page.route("**/api/membership", (route) => route.fulfill({
        json: { ...VIEW, member: { ...VIEW.member, rounds: CLOSED_ROUNDS } },
      }));
      await page.goto("/account/#membership");

      const { own } = groups(page);
      const tab = page.locator("#acct-membership");

      await expect(own.locator("[data-mem-round]")).toHaveCount(3);

      // No "Order now" button, as a link or a button, anywhere, and
      // nothing drawn as a button in the open round. (The pill's own
      // name may say "order now" after "Open": the draft is "Open,
      // order now".)
      for (const role of ["link", "button"]) {
        await expect(tab.getByRole(role, { name: /^\s*order now\s*$/i }))
          .toHaveCount(0);
      }
      await expect(own.locator("[data-mem-round='open'] .btn"))
        .toHaveCount(0);

      // The Open pill is one link to the order page, its name saying
      // where it goes.
      const open = own.locator("[data-mem-round='open']");
      const pill = open.getByRole("link");

      await expect(pill).toHaveCount(1);
      await expect(pill).toBeVisible();
      await expect(pill).toContainText("Open");
      await expect(pill).toHaveAccessibleName(/^Open\b.*\border\b/i);
      await expect(pill).toHaveAttribute("href", /\/order\/(\?[^#]*)?(#.*)?$/);
      // It is the pill itself, not a link beside it: the pill's word
      // sits inside the link.
      expect(await pill.evaluate((a) => !!a.querySelector(
        ".account-round-pill") || a.matches(".account-round-pill")))
        .toBe(true);

      // Next and Closed: their pills are not links, and nothing in
      // those rounds is.
      for (const state of ["next", "closed"]) {
        const round = own.locator(`[data-mem-round='${state}']`);

        await expect(round).toBeVisible();
        for (const role of ["link", "button"]) {
          await expect(round.getByRole(role), state).toHaveCount(0);
        }
        expect(await round.locator(".account-round-pill")
          .evaluate((el) => !!el.closest("a")), state).toBe(false);
      }

      // Reached by Tab, from the top of the page.
      const unfocused = await pill.evaluate((a) => {
        const s = getComputedStyle(a);

        return { outline: s.outlineStyle, shadow: s.boxShadow };
      });
      let reached = false;

      await page.locator("body").focus();
      for (let i = 0; i < 120 && !reached; i += 1) {
        await page.keyboard.press("Tab");
        reached = await pill.evaluate((a) => document.activeElement === a);
      }
      expect(reached, "reached by Tab").toBe(true);

      // A visible focus ring: an outline or a ring drawn as a shadow,
      // which the link does not have before it takes focus.
      const ring = await pill.evaluate((a) => {
        const s = getComputedStyle(a);
        const transparent = (c) => /rgba\([^)]*,\s*0\)$/.test(c)
          || c === "transparent";

        return {
          focusVisible: a.matches(":focus-visible"),
          outline: s.outlineStyle !== "none"
            && parseFloat(s.outlineWidth) > 0
            && !transparent(s.outlineColor),
          shadow: s.boxShadow,
        };
      });

      expect(ring.focusVisible).toBe(true);
      expect(ring.outline || (ring.shadow !== "none"
        && ring.shadow !== unfocused.shadow), "a focus ring").toBe(true);
    });

  // #608, Done when 6 (supersedes #602's criterion 19 test, which
  // followed the button): following the Open pill reaches the order
  // page, with the account's own group asked for (the page then brings
  // its pickup and prices, as the group's link does). The answer is
  // canned as a miss: what /api/group gives is
  // test/group-membership.test.mjs's to check.
  test("takes a member from the Open pill to the order page with the group "
    + "applied", async ({ page }) => {
    const asked = [];

    await page.route("**/api/group", (route) => {
      if (route.request().method() === "POST") {
        asked.push(route.request().postDataJSON());
      }

      return route.fulfill({ status: 404,
        json: { ok: false, message: "That code isn't valid." } });
    });
    await page.goto("/account/#membership");

    const { own } = groups(page);

    await own.locator("[data-mem-round='open']").getByRole("link").click();
    await expect(page).toHaveURL(/\/order\/(\?[^#]*)?(#.*)?$/);
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    // The account's group, or the group's own code: either applies it.
    expect(asked.some((body) => !body.code
      || /^[A-Z0-9-]{6,}$/i.test(body.code))).toBe(true);
  });

  // Criteria 20, 21 and 22.
  test("drops what direction C took out", async ({ page }) => {
    await page.goto("/account/#membership");

    const tab = page.locator("#acct-membership");
    const { own } = groups(page);

    await expect(own.locator("[data-mem-round]").first()).toBeVisible();
    await expect(tab).not.toContainText(/every (\d+ )?weeks?/i);
    await expect(tab).not.toContainText(/runs every/i);
    await expect(tab).not.toContainText(/(This|Next) round/);
    await expect(tab).not.toContainText(/\bRounds\b/);
    // No label column.
    await expect(own.locator("dt:visible")).toHaveCount(0);
  });

  // #608, Done when 5, the paragraph (supersedes #602's criterion 24,
  // James's earlier paragraph): the first sentence alone, as an
  // ordinary paragraph, no longer opened by "Coming soon:".
  test("opens the Membership QR code with James's sentence as a paragraph",
    async ({ page }) => {
      await page.goto("/account/#membership");

      const code = groups(page).own.getByRole("region",
        { name: "Membership QR code" });
      const first = "Scan your code when you make a purchase in person "
        + "(like at a farmers market), and your membership benefits "
        + "will apply automatically.";
      const said = code.locator("p", { hasText: "Scan your code" });

      await expect(code).toBeVisible();
      await expect(said).toHaveCount(1);
      await expect(said).toBeVisible();
      await expect(said).toHaveText(first);
      // Ordinary: not the note, nor inside it.
      expect(await said.evaluate((p) => !p.closest(".zip-note, .alert")))
        .toBe(true);
      await expect(code).not.toContainText("Coming soon:");
    });

  // #608, Done when 5, the note (supersedes #602's criterion 24 check
  // that the second sentence is bold in the paragraph): after the
  // paragraph, a note in the order countdown's style, the shared
  // .zip-note with its bar down the left in the primary color, bold
  // as the countdown is, reading exactly James's sentence (with the
  // coordinator's "a"). James, by screenshot on #608: not Bootstrap's
  // alert.
  test("puts the meantime sentence in a countdown-style note after it",
    async ({ page }) => {
      await page.goto("/account/#membership");

      const code = groups(page).own.getByRole("region",
        { name: "Membership QR code" });
      const second = "In the meantime, let us know that you're a member at "
        + "checkout, and we'll look up your membership by name or email.";
      const note = code.locator(".zip-note");

      await expect(note).toHaveCount(1);
      await expect(note).toBeVisible();
      await expect(note).toHaveText(second);

      const m = await note.evaluate((el) => {
        const s = getComputedStyle(el);
        // A custom property resolved to the color the page draws.
        const resolve = (prop, value) => {
          const probe = document.createElement("span");

          probe.style[prop] = value;
          el.parentElement.append(probe);

          const c = getComputedStyle(probe)[prop];

          probe.remove();

          return c;
        };
        const p = Array.from(el.closest("section").querySelectorAll("p"))
          .find((x) => x.textContent.trim().startsWith("Scan your code"));
        const width = (side) => parseFloat(s[`border${side}Width`]);

        return {
          bar: s.borderLeftStyle !== "none" && width("Left") > 0,
          barWidest: ["Top", "Right", "Bottom"]
            .every((side) => width("Left") > width(side)),
          barColor: s.borderLeftColor,
          primary: resolve("color", "var(--bs-primary)"),
          ground: s.backgroundColor,
          subtle: resolve("backgroundColor", "var(--bs-primary-bg-subtle)"),
          weight: Number(s.fontWeight),
          alert: el.matches(".alert, .alert *"),
          follows: !!p && !!(p.compareDocumentPosition(el)
            & Node.DOCUMENT_POSITION_FOLLOWING),
          below: !!p && el.getBoundingClientRect().top
            >= p.getBoundingClientRect().bottom - 0.5,
        };
      });

      expect(m.bar, "a bar down its left").toBe(true);
      expect(m.barWidest, "the left bar wider than its other edges")
        .toBe(true);
      expect(m.barColor, "the bar in the primary color").toBe(m.primary);
      expect(m.ground, "the shared note's pale ground").toBe(m.subtle);
      expect(m.weight, "bold, as the countdown").toBeGreaterThanOrEqual(700);
      expect(m.alert, "not Bootstrap's alert").toBe(false);
      // After the paragraph, in the page's order and drawn below it.
      expect(m.follows, "after the paragraph").toBe(true);
      expect(m.below, "drawn below the paragraph").toBe(true);
    });

  // Criteria 23 and 26 to 29: the member's own code, coming soon. (Its
  // paragraph, criterion 24, is #608's two tests above.)
  test("shows the Membership QR code as coming soon", async ({ page }) => {
    await page.goto("/account/#membership");

    const { own } = groups(page);
    const code = own.getByRole("region", { name: "Membership QR code" });

    await expect(code).toBeVisible();

    const img = code.getByRole("img");

    await expect(img).toHaveCount(1);
    await expect(img).toBeVisible();
    await expect(img).toHaveAccessibleName(/\bnot\b.*\byet\b/i);
    await expect(code.getByText("Coming soon", { exact: true }))
      .toBeVisible();

    // No code as text, no line about reading it aloud, no key tag and
    // no download.
    const tab = page.locator("#acct-membership");

    await expect(tab).not.toContainText("NFM-");
    await expect(tab).not.toContainText(/letters and numbers/i);
    await expect(code.getByRole("link")).toHaveCount(0);
    await expect(code.getByRole("button")).toHaveCount(0);
    await expect(own.getByRole("link", { name: /key tag/i })).toHaveCount(0);
    await expect(own.getByRole("button", { name: /key tag/i }))
      .toHaveCount(0);
    await expect(own.getByRole("link", { name: /download/i })).toHaveCount(0);
  });

  // Criterion 32, with every kind of round on the tab.
  test("has no no-break space anywhere", async ({ page }) => {
    await page.route("**/api/membership", (route) => route.fulfill({
      json: { ...VIEW, member: { ...VIEW.member, rounds: CLOSED_ROUNDS } },
    }));
    await page.goto("/account/#membership");

    const { own } = groups(page);

    await expect(own.locator("[data-mem-round]")).toHaveCount(3);
    expect(await page.locator("#acct-membership").textContent())
      .not.toMatch(NO_BREAK);
  });
});

const openClosed = async (page, context, baseURL) => {
  await signIn(page, context, baseURL, {
    view: { ...VIEW, member: { ...VIEW.member, rounds: CLOSED_ROUNDS } },
  });
  await page.goto("/account/#membership");

  const { own } = groups(page);

  await expect(own.locator("[data-mem-round]")).toHaveCount(3);

  return own;
};

// #602, criterion 43 (James's review, 2026-11-18): "The closed line
// should actually say 'Next pickup is Sunday, Nov 22'", the pickup's
// own date, with the pill "Closed".
test("writes the closed round's line as Next pickup is its date", async ({
  page, context, baseURL,
}) => {
  const own = await openClosed(page, context, baseURL);
  const [closed] = await roundLines(own);

  expect(closed[1]).toBe("Closed Next pickup is Sunday, Nov 22");
  await expect(own.locator("[data-mem-round]").first()
    .locator(".account-round-pill")).toHaveText("Closed");
});

// #600, criterion 42: between a round's close and its pickup, that
// pickup stays on the tab, first, with its own pill, and takes no
// orders. Its sentence is criterion 43's.
test("keeps the closed pickup first, until it has happened", async ({
  page, context, baseURL,
}) => {
  const own = await openClosed(page, context, baseURL);
  const rounds = own.locator("[data-mem-round]");
  const lines = await roundLines(own);

  expect(lines[0][0]).toBe("Sunday, Nov 22 · 8:30 – 9:00 AM");
  expect(lines[0][1]).toMatch(/^Closed /);
  expect(lines.slice(1)).toEqual([
    ["Sunday, Dec 6 · 8:30 – 9:00 AM",
      "Open Closes at 11:59 PM on Sat, Dec 5"],
    ["Sunday, Dec 20 · 8:30 – 9:00 AM", "Next Opens on Sun, Dec 6"],
  ]);
  for (const role of ["link", "button"]) {
    await expect(rounds.nth(0).getByRole(role)).toHaveCount(0);
  }
  // The open round takes orders through its pill (#608).
  await expect(rounds.nth(1).getByRole("link", { name: /^Open\b/ }))
    .toBeVisible();
  // Where: the group's address, above its rounds.
  await expect(own.locator("[data-mem='address']")).toContainText("1 Main St");
});
