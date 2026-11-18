// The Membership tab's layout (#602) and the account head on a phone
// (#601), measured in the browser. Each test proves rows of the test
// agent's criteria table. It runs on the production build, where
// PurgeCSS has had its say, so a class the build stripped shows here
// as a style that is missing. desktop measures every width James
// named; phone (Chromium) and iphone (WebKit) measure their own width
// and 320 px. Canned, so nothing is saved.

import { expect, test } from "./support/order.mjs";
import { CUSTOMER } from "./support/canned.mjs";
import {
  CLOSED_ROUNDS, HOSTED_GROUP, MEMBER_GROUP, ME, VIEW, groups, signIn,
} from "./support/membership.mjs";

// The widths each project measures: null is the project's own.
const widthsFor = (project) => (project === "desktop"
  ? [1280, 768, 390, 320] : [null, 320]);
const phoneWidthsFor = (project) => (project === "desktop"
  ? [390, 320] : [null, 320]);
const label = (w) => (w ? `${w} px` : "its own width");

const atWidth = async (page, width) => {
  if (width) await page.setViewportSize({ width, height: 800 });
};

const open = async (page, context, baseURL, options) => {
  await signIn(page, context, baseURL, options);
  await page.goto("/account/#membership");
  await expect(groups(page).own.locator("[data-mem-round]").first())
    .toBeVisible();
};

// Each round of a group block, measured: its column, its two lines,
// the date, the window and the pill.
const measureRounds = (block) => block.locator("[data-mem-round]")
  .evaluateAll((cols) => cols.map((col) => {
    const box = (el) => el.getBoundingClientRect();
    const style = (el) => getComputedStyle(el);
    const date = col.querySelector("[data-round='date']");
    const window = col.querySelector("[data-round='window']");
    const [when, status] = col.querySelectorAll("p");
    const pill = status.querySelector(".account-round-pill");
    const ps = style(pill);

    return {
      col: box(col).toJSON(),
      dateRects: date.getClientRects().length,
      windowRects: window.getClientRects().length,
      dateWeight: Number(style(date).fontWeight),
      windowWeight: Number(style(window).fontWeight),
      when: box(when).toJSON(),
      status: box(status).toJSON(),
      whenSize: parseFloat(style(when).fontSize),
      statusSize: parseFloat(style(status).fontSize),
      whenColor: style(when).color,
      statusColor: style(status).color,
      pill: box(pill).toJSON(),
      pillText: pill.textContent.trim(),
      // Drawn as a pill: a fill or an outline, and round corners.
      pillDrawn: (ps.backgroundColor !== "rgba(0, 0, 0, 0)"
        || parseFloat(ps.borderTopWidth) > 0 || ps.boxShadow !== "none")
        && parseFloat(ps.borderTopLeftRadius) > 0,
    };
  }));

test.describe("a round on the Membership tab (#602)", () => {
  // Criterion 6.
  test("sets the date bold and the window regular", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    for (const r of await measureRounds(groups(page).own)) {
      expect(r.dateWeight).toBeGreaterThanOrEqual(700);
      expect(r.windowWeight).toBeLessThanOrEqual(500);
    }
  });

  // Criterion 9.
  test("puts the second line under the first, smaller and gray", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    for (const r of await measureRounds(groups(page).own)) {
      expect(r.status.top).toBeGreaterThanOrEqual(r.when.bottom - 0.5);
      expect(r.statusSize).toBeLessThan(r.whenSize);
      expect(r.statusColor).not.toBe(r.whenColor);
    }
  });

  for (const width of [1280, 768, 390, 320, null]) {
    // Criteria 7, 10, 13 and 34.
    test(`keeps the date and window whole, the pill first, at ${
      label(width)}`, async ({ page, context, baseURL }, info) => {
      const widths = widthsFor(info.project.name);

      test.skip(!widths.includes(width), "another project's width");
      await atWidth(page, width);
      await open(page, context, baseURL, {
        view: { ...VIEW, member: { ...VIEW.member, rounds: CLOSED_ROUNDS } },
      });

      const rounds = await measureRounds(groups(page).own);

      expect(rounds.map((r) => r.pillText)).toEqual(["Closed", "Open",
        "Next"]);
      for (const r of rounds) {
        expect(r.dateRects, `${r.pillText}: the date whole`).toBe(1);
        expect(r.windowRects, `${r.pillText}: the window whole`).toBe(1);
        // The pill opens the second line, at its left, never the right.
        expect(Math.abs(r.pill.left - r.status.left)).toBeLessThan(1);
        expect(r.pill.top - r.status.top).toBeLessThan(8);
        expect(r.pillDrawn, `${r.pillText}: drawn as a pill`).toBe(true);
        // The pill and its sentence wrap inside the column.
        expect(r.status.right).toBeLessThanOrEqual(r.col.right + 0.5);
        expect(r.when.right).toBeLessThanOrEqual(r.col.right + 0.5);
      }
    });
  }

  // Criterion 8: given less room than the line needs, it breaks at the
  // dot, the dot staying with the date, and nowhere else.
  test("breaks the first line at the dot when it must wrap", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const m = await groups(page).own.locator("[data-mem-round]").evaluateAll(
      (cols) => cols.map((col) => {
        const date = col.querySelector("[data-round='date']");
        const window = col.querySelector("[data-round='window']");
        const when = col.querySelector("p");

        // Room for the date and its dot, not for the window as well.
        when.style.width = `${date.getBoundingClientRect().width + 24}px`;

        const walk = document.createTreeWalker(when, NodeFilter.SHOW_TEXT);
        let dot = null;

        for (let n = walk.nextNode(); n && !dot; n = walk.nextNode()) {
          const i = n.data.indexOf("·");

          if (i >= 0) {
            const range = document.createRange();

            range.setStart(n, i);
            range.setEnd(n, i + 1);
            dot = range.getBoundingClientRect();
          }
        }

        const d = date.getBoundingClientRect();
        const w = window.getBoundingClientRect();

        return {
          dateRects: date.getClientRects().length,
          windowRects: window.getClientRects().length,
          wrapped: w.top >= d.bottom - 1,
          dotWithDate: !!dot && Math.abs(dot.top - d.top) < 4,
        };
      })
    );

    for (const r of m) {
      expect(r).toEqual({ dateRects: 1, windowRects: 1, wrapped: true,
        dotWithDate: true });
    }
  });

  // Criterion 14 (James's review, 2026-11-18): side by side from lg,
  // 992 px.
  for (const width of [992, 1280]) {
    test(`sets two rounds side by side at ${width} px`, async ({
      page, context, baseURL,
    }, info) => {
      test.skip(info.project.name !== "desktop", "desktop widths only");
      await atWidth(page, width);
      await open(page, context, baseURL);

      const [a, b] = await measureRounds(groups(page).own);

      expect(Math.abs(a.col.top - b.col.top)).toBeLessThan(1);
      expect(b.col.left).toBeGreaterThanOrEqual(a.col.right - 1);
    });
  }

  // Criterion 15 (James's review, 2026-11-18): "The rounds should sit
  // in a single column on med screens", so stacked below 992 px, 768
  // px included.
  for (const width of [768, 390, 320, null]) {
    test(`stacks the rounds at ${label(width)}`, async ({
      page, context, baseURL,
    }, info) => {
      const widths = info.project.name === "desktop"
        ? [768, 390, 320] : [null, 320];

      test.skip(!widths.includes(width), "another project's width");
      await atWidth(page, width);
      await open(page, context, baseURL);

      const [a, b] = await measureRounds(groups(page).own);

      expect(Math.abs(a.col.left - b.col.left)).toBeLessThan(1);
      expect(b.col.top).toBeGreaterThanOrEqual(a.col.bottom - 0.5);
    });
  }

  // Criterion 16: the hosted group has the open round alone.
  test("sets one round alone at the left", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const { hosted } = groups(page);
    const m = await hosted.evaluate((block) => {
      const cols = block.querySelectorAll("[data-mem-round]");
      const heading = Array.from(block.querySelectorAll("h3"))
        .find((h) => h.textContent.trim() === "Pickups");
      const when = cols[0].querySelector("p");

      return {
        count: cols.length,
        left: when.getBoundingClientRect().left
          - heading.getBoundingClientRect().left,
        // Its lines, not the column's gutter.
        inside: Math.max(...Array.from(cols[0].children,
          (el) => el.getBoundingClientRect().right))
          <= block.getBoundingClientRect().right + 0.5,
      };
    });

    expect(m.count).toBe(1);
    expect(Math.abs(m.left)).toBeLessThan(1);
    expect(m.inside).toBe(true);
  });
});

test.describe("the group on the Membership tab (#602)", () => {
  // Criteria 1 and 2.
  test("the group's name is the account email's size, bold, the address "
    + "one small gray line", async ({ page, context, baseURL }) => {
    await open(page, context, baseURL);

    const m = await groups(page).own.evaluate((block) => {
      const style = (el) => getComputedStyle(el);
      const name = block.querySelector("h2");
      const address = block.querySelector("[data-mem='address']");
      const email = document.getElementById("account-email");
      const a = address.getBoundingClientRect();

      return {
        nameSize: parseFloat(style(name).fontSize),
        emailSize: parseFloat(style(email).fontSize),
        rootSize: parseFloat(style(document.documentElement).fontSize),
        nameWeight: Number(style(name).fontWeight),
        addressSize: parseFloat(style(address).fontSize),
        bodySize: parseFloat(style(document.body).fontSize),
        addressLines: Math.round(a.height
          / parseFloat(style(address).lineHeight)),
        under: a.top >= name.getBoundingClientRect().bottom - 0.5,
        nameColor: style(name).color,
        addressColor: style(address).color,
      };
    });

    expect(m.nameSize).toBe(m.emailSize);
    expect(m.nameSize).toBe(1.25 * m.rootSize);
    expect(m.nameWeight).toBeGreaterThanOrEqual(700);
    expect(m.addressLines).toBe(1);
    expect(m.under).toBe(true);
    expect(m.addressSize).toBeLessThan(m.bodySize);
    expect(m.addressColor).not.toBe(m.nameColor);
  });

  // Criterion 31: the space above each section heading, from the
  // lowest thing drawn before it to the heading, the same in the
  // member's group as in the host's.
  test("gives every section heading the host's space above it", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const gaps = await page.locator("#mem-groups").evaluate((root) => {
      const shown = (el) => el.getClientRects().length > 0
        && getComputedStyle(el).visibility !== "hidden";
      const lowest = (el) => Math.max(el.getBoundingClientRect().bottom,
        ...Array.from(el.querySelectorAll("*")).filter(shown)
          .map((d) => d.getBoundingClientRect().bottom));
      const before = (el) => {
        for (let n = el; n && n !== root; n = n.parentElement) {
          for (let s = n.previousElementSibling; s;
            s = s.previousElementSibling) {
            if (shown(s)) return s;
          }
        }

        return null;
      };

      return Array.from(root.querySelectorAll("[data-mem-group]"),
        (block) => Array.from(block.querySelectorAll("h3"))
          .filter(shown)
          .map((h) => {
            // The heading's section, and what shows before it.
            const section = h.closest("section");
            const prev = before(section);

            return {
              heading: h.textContent.trim(),
              gap: h.getBoundingClientRect().top - lowest(prev),
            };
          }));
    });

    const [own, hosted] = gaps;
    const host = hosted.find((g) => g.heading === "Invite members").gap;

    expect(own.map((g) => g.heading)).toEqual(["Pickups",
      "Membership QR code", "Leave the group"]);
    // #579: never flush under what came before.
    expect(host).toBeGreaterThan(8);
    for (const g of [...own, ...hosted]) {
      expect(Math.abs(g.gap - host), g.heading).toBeLessThan(1);
    }
  });

  // Criteria 25 and 26.
  test("veils the QR code in white and centers Coming soon on it", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const code = groups(page).own.getByRole("region",
      { name: "Membership QR code" });
    const img = code.getByRole("img");

    await expect(img).toBeVisible();
    await img.scrollIntoViewIfNeeded();

    const m = await img.evaluate((image) => {
      const r = image.getBoundingClientRect();
      const white = (bg) => {
        const c = bg.match(/rgba?\(([^)]+)\)/);
        const [red, green, blue, alpha = "1"] = c ? c[1].split(",")
          .map((x) => x.trim()) : [];

        return c && red === "255" && green === "255" && blue === "255"
          ? Number(alpha) : 0;
      };
      // How much white an element lays over the code: its own fill, or
      // its ::before or ::after's, times its opacity.
      const veil = (el) => Math.max(...[null, "::before", "::after"]
        .map((p) => {
          const s = getComputedStyle(el, p);

          if (p && s.content === "none") return 0;

          return white(s.backgroundColor) * Number(s.opacity);
        }));
      // At a point of the code, the most white over it: from what is
      // stacked above the image there, or, for a veil that lets the
      // pointer through, the image's own box's ::before or ::after.
      const over = ([x, y]) => {
        const stack = document.elementsFromPoint(x, y);
        const above = stack.slice(0, stack.indexOf(image));

        return Math.max(0, ...above.map(veil),
          stack[0] === image ? veil(image.parentElement) : 0);
      };
      const corners = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4],
        [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4]];
      const badge = Array.from(image.parentElement.querySelectorAll("*"))
        .find((el) => el.textContent.trim() === "Coming soon"
          && el.children.length === 0);
      const b = badge.getBoundingClientRect();
      const center = document.elementFromPoint((r.left + r.right) / 2,
        (r.top + r.bottom) / 2);

      return {
        veils: corners.map(over),
        dx: (b.left + b.right) / 2 - (r.left + r.right) / 2,
        dy: (b.top + b.bottom) / 2 - (r.top + r.bottom) / 2,
        badgeOnTop: !!center && (center === badge || badge.contains(center)
          || center.contains(badge)),
      };
    });

    // Something covers the whole code, white and see-through.
    for (const v of m.veils) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    expect(Math.abs(m.dx)).toBeLessThan(1.5);
    expect(Math.abs(m.dy)).toBeLessThan(1.5);
    expect(m.badgeOnTop).toBe(true);
  });
});

// The section headings' gaps at e146cd21, from its CSS
// (_account.scss): 1.5rem (--account-gap) above each, the margin-top
// of `.account-membership-group .account-group`, and 1.5rem below,
// the margin-bottom of `.account-group-head`. In rem, so the root's
// size turns them to pixels.
const OLD_ABOVE_REM = 1.5;
const OLD_BELOW_REM = 1.5;

// Each section heading of both groups, measured: above, from the
// lowest thing drawn before its section to the heading's top; below,
// from the heading's bottom to the highest thing drawn after it in
// its section. A row's pulled-up edge (Bootstrap's negative gutter
// margin) is not drawn, so what is measured below is its columns.
const headingGaps = (page) => page.locator("#mem-groups").evaluate(
  (root) => {
    const shown = (el) => el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== "hidden";
    const lowest = (el) => Math.max(el.getBoundingClientRect().bottom,
      ...Array.from(el.querySelectorAll("*")).filter(shown)
        .map((d) => d.getBoundingClientRect().bottom));
    const before = (el) => {
      for (let n = el; n && n !== root; n = n.parentElement) {
        for (let s = n.previousElementSibling; s;
          s = s.previousElementSibling) {
          if (shown(s)) return s;
        }
      }

      return null;
    };
    const highestAfter = (h, section) => {
      const tops = Array.from(section.querySelectorAll("*"))
        .filter((el) => shown(el) && !el.contains(h)
          && (h.compareDocumentPosition(el)
            & Node.DOCUMENT_POSITION_FOLLOWING)
          && !h.contains(el)
          && parseFloat(getComputedStyle(el).marginTop) >= 0)
        .map((el) => el.getBoundingClientRect().top);

      return Math.min(...tops);
    };

    return Array.from(root.querySelectorAll("[data-mem-group] h3"))
      .filter(shown)
      .map((h) => {
        const section = h.closest("section");
        const r = h.getBoundingClientRect();

        return {
          heading: h.textContent.trim(),
          above: r.top - lowest(before(section)),
          below: highestAfter(h, section) - r.bottom,
        };
      });
  }
);

test.describe("the Membership tab's section headings (#608)", () => {
  // Done when 3: each section heading (Pickups, Membership QR code,
  // Leave the group; Pickups, Invite members, Members) has more space
  // above it than below it, and more above and less below than at
  // e146cd21. The step is one of the page's scale; the test holds the
  // direction, and the report says the values.
  test("gives each section heading more room above and less below", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const root = await page.evaluate(() => parseFloat(
      getComputedStyle(document.documentElement).fontSize));
    const oldAbove = OLD_ABOVE_REM * root;
    const oldBelow = OLD_BELOW_REM * root;
    const gaps = await headingGaps(page);

    // The Members heading carries its count, "Members (1)".
    expect(gaps.map((g) => g.heading.replace(/\s*\(\d+\)$/, ""))).toEqual([
      "Pickups",
      "Membership QR code", "Leave the group", "Pickups", "Invite members",
      "Members"]);
    for (const g of gaps) {
      const at = `${g.heading}: ${g.above} px above, ${g.below} px below`;

      expect(g.above, at).toBeGreaterThan(g.below);
      expect(g.above, `${at}, more above than ${oldAbove}`)
        .toBeGreaterThan(oldAbove + 0.5);
      expect(g.below, `${at}, less below than ${oldBelow}`)
        .toBeLessThan(oldBelow - 0.5);
      expect(g.below, `${at}, not flush`).toBeGreaterThan(0);
    }
  });

  // Spec 4's last line (the coordinator's reading, not a "Done when"
  // line): with the Order now button gone, the host's Download QR code
  // button is filled again, as before #602.
  test("fills the host's Download QR code button", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL);

    const button = groups(page).hosted.getByRole("link",
      { name: "Download QR code" });

    await expect(button).toBeVisible();

    const m = await button.evaluate((a) => {
      const s = getComputedStyle(a);
      const probe = document.createElement("span");

      probe.style.backgroundColor = "var(--bs-primary)";
      a.parentElement.append(probe);

      const primary = getComputedStyle(probe).backgroundColor;

      probe.remove();

      return { ground: s.backgroundColor, primary };
    });

    expect(m.ground).toBe(m.primary);
  });
});

// The accounts #608's head criteria name: a member with credit (who
// also hosts a group), a host who is in no group and has no credit,
// and an account in no group at all.
const HOST_ONLY = {
  me: { signedIn: true, membership: true, customer: CUSTOMER,
    member: null, credit: 0 },
  view: { member: null, hosts: VIEW.hosts },
};
const NO_GROUP = {
  me: { signedIn: true, membership: false, customer: CUSTOMER,
    member: null, credit: 0 },
};

// The widths #608 names for the head; phone and iphone measure their
// own width and 320 px.
const headWidthsFor = (project, page) => (project === "desktop"
  ? [320, 390, 768, 1280] : [page.viewportSize().width, 320]);

const openAccount = async (page, context, baseURL, options) => {
  await signIn(page, context, baseURL, options);
  await page.goto("/account/");
  await expect(page.locator("#account-email")).toBeVisible();
};

// The head's Sign out line, measured: Sign out, the credit (the text
// "Credit: $N", wherever it sits), and any dot or bullet drawn between
// them, as text or as a ::before or ::after.
const signOutLine = (page) => page.locator("#account-app .account-head")
  .evaluate((head) => {
    const DOT = /[·•∙⋅]/;
    const box = (el) => el.getBoundingClientRect().toJSON();
    const email = head.querySelector("#account-email");
    const signout = head.querySelector("#account-signout");
    const shown = (el) => el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== "hidden";
    const texts = [];
    const walk = document.createTreeWalker(head, NodeFilter.SHOW_TEXT);

    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!email.contains(n) && shown(n.parentElement)) texts.push(n);
    }

    const creditNode = texts.find((n) => /Credit:/.test(n.data));
    let credit = null;

    if (creditNode) {
      const range = document.createRange();

      range.selectNodeContents(creditNode);

      const el = creditNode.parentElement;
      const tops = new Set(Array.from(range.getClientRects(),
        (r) => Math.round(r.top)));

      const text = el.textContent.replace(/\s+/g, " ");

      credit = {
        text: text.slice(text.indexOf("Credit:")).trim(),
        rect: range.getBoundingClientRect().toJSON(),
        lines: tops.size,
        size: parseFloat(getComputedStyle(el).fontSize),
      };
    }

    // Dots as text, each with its box and style.
    const dots = [];

    for (const n of texts) {
      for (let i = 0; i < n.data.length; i += 1) {
        if (DOT.test(n.data[i])) {
          const range = document.createRange();

          range.setStart(n, i);
          range.setEnd(n, i + 1);

          const s = getComputedStyle(n.parentElement);

          dots.push({ rect: range.getBoundingClientRect().toJSON(),
            size: parseFloat(s.fontSize), color: s.color });
        }
      }
    }
    // Dots drawn as generated content, outside the address.
    for (const el of head.querySelectorAll("*")) {
      if (!email.contains(el) && !el.contains(email) && shown(el)) {
        for (const p of ["::before", "::after"]) {
          const s = getComputedStyle(el, p);

          if (s.content !== "none" && DOT.test(s.content)
            && s.display !== "none") {
            dots.push({ rect: null, size: parseFloat(s.fontSize),
              color: s.color });
          }
        }
      }
    }

    return {
      email: box(email),
      signout: shown(signout) ? box(signout) : null,
      credit,
      dots,
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });

const signOut = (page) => page.locator("#account-app .account-head")
  .getByRole("button", { name: "Sign out", exact: true });

// A color with no hue to speak of, lighter than the text: a gray.
const gray = (color) => {
  const [r, g, b] = color.match(/[\d.]+/g).map(Number);

  return Math.max(r, g, b) - Math.min(r, g, b) <= 24
    && Math.min(r, g, b) >= 64;
};

test.describe("the account head (#608)", () => {
  // Done when 1: no group's name in the head, at 320, 390, 768 and
  // 1280 px, for a member (who also hosts) and for a host.
  test("shows no group name in the head, for a member and a host", async ({
    page, context, baseURL,
  }, info) => {
    const widths = headWidthsFor(info.project.name, page);

    for (const [who, options] of [["member", {}], ["host", HOST_ONLY]]) {
      await openAccount(page, context, baseURL, options);
      // The account is the one meant: its groups are on the tab.
      await page.goto("/account/#membership");
      await expect(page.locator("#mem-groups [data-mem-group]").first())
        .toBeVisible();

      const head = page.locator("#account-app .account-head");

      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });
        for (const name of [MEMBER_GROUP, HOSTED_GROUP]) {
          await expect(head, `${who} at ${width} px: ${name}`)
            .not.toContainText(name, { useInnerText: true });
        }
      }
    }
  });

  // Done when 2: "Sign out", the separator, then "Credit: $N", on one
  // line under the email address, the separator at the credit's small
  // gray size (0.875rem, the credit's size today); an account with no
  // credit line shows Sign out alone, with no separator. At #608's
  // widths.
  test("puts the credit on the Sign out line after a separator, or Sign out "
    + "alone", async ({ page, context, baseURL }, info) => {
    const widths = headWidthsFor(info.project.name, page);

    await openAccount(page, context, baseURL);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });

      const m = await signOutLine(page);
      const at = `member at ${width} px`;

      await expect(signOut(page), at).toBeVisible();
      expect(m.signout, `${at}: Sign out shown`).not.toBeNull();
      expect(m.credit, `${at}: the credit shown`).not.toBeNull();
      expect(m.credit.text, at).toMatch(/^Credit: \$\d[\d,]*(\.\d\d)?$/);
      expect(m.credit.lines, `${at}: the credit whole`).toBe(1);
      // Under the address, on one line with Sign out, after it.
      expect(m.signout.top, at).toBeGreaterThanOrEqual(m.email.bottom - 0.5);
      expect(m.credit.rect.top, at)
        .toBeGreaterThanOrEqual(m.email.bottom - 0.5);
      expect(Math.abs((m.signout.top + m.signout.bottom) / 2
        - (m.credit.rect.top + m.credit.rect.bottom) / 2),
      `${at}: one line`).toBeLessThan(4);
      expect(m.credit.rect.left, at).toBeGreaterThan(m.signout.right);
      // One separator, between them, small and gray as the credit is.
      expect(m.dots, `${at}: one separator`).toHaveLength(1);

      const [dot] = m.dots;

      if (dot.rect) {
        expect(dot.rect.left, at).toBeGreaterThanOrEqual(m.signout.right
          - 0.5);
        expect(dot.rect.right, at).toBeLessThanOrEqual(m.credit.rect.left
          + 0.5);
      }
      expect(m.credit.size, `${at}: the credit's size`).toBe(0.875 * m.root);
      expect(dot.size, `${at}: the separator's size`).toBe(m.credit.size);
      expect(gray(dot.color), `${at}: a gray separator (${dot.color})`)
        .toBe(true);
    }

    for (const [who, options] of [["host", HOST_ONLY],
      ["no group", NO_GROUP]]) {
      await openAccount(page, context, baseURL, options);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });

        const m = await signOutLine(page);
        const at = `${who} at ${width} px`;

        await expect(signOut(page), at).toBeVisible();
        expect(m.signout, `${at}: Sign out shown`).not.toBeNull();
        expect(m.credit, `${at}: no credit line`).toBeNull();
        expect(m.dots, `${at}: no separator`).toEqual([]);
      }
    }
  });
});

// #601, criterion 37 (kept by #608): a short address keeps a readable
// width, on one line, inside the head. #608 took the group's name out
// of the head, so #601's criteria 36 and 38 (the head in one column,
// the group's name and credit as a row under the address) are gone
// with it.
test.describe("the account head's email address (#601)", () => {
  for (const width of [390, 320, null]) {
    test(`keeps a short address on one line at ${label(width)}`, async ({
      page, context, baseURL,
    }, info) => {
      test.skip(!phoneWidthsFor(info.project.name).includes(width),
        "another project's width");
      await atWidth(page, width);
      await signIn(page, context, baseURL, {
        me: { ...ME, customer: { ...ME.customer,
          email: "member@example.com" } },
      });
      await page.goto("/account/#membership");

      await expect(page.locator("#account-email"))
        .toHaveText("member@example.com");

      const m = await page.locator("#account-app .account-head").evaluate(
        (head) => {
          const box = (el) => el.getBoundingClientRect();
          const email = head.querySelector("#account-email");

          return {
            share: box(email).width / box(head).width,
            emailLines: Math.round(box(email).height
              / parseFloat(getComputedStyle(email).lineHeight)),
            inside: box(email).right <= box(head).right + 0.5,
          };
        }
      );

      expect(m.share).toBeGreaterThanOrEqual(0.6);
      expect(m.emailLines).toBe(1);
      expect(m.inside).toBe(true);
    });
  }
});

test.describe("an address too long for one line (#601)", () => {

  // Criterion 37a (coordinator, 2026-11-18, from #601): an address
  // too long for one line breaks only before the @ or before a dot,
  // never inside a word, and stays inside the head.
  const LONG = ["first.last@example.co.uk",
    "jonathan.appleseed@farmmail.com"];

  for (const width of [320, 360, 390]) {
    for (const email of LONG) {
      test(`breaks a ${email.length}-character address only before `
          + `the @ or a dot at ${width} px`, async ({
        page, context, baseURL,
      }) => {
        await atWidth(page, width);
        await signIn(page, context, baseURL, {
          me: { ...ME, customer: { ...ME.customer, email } },
        });
        await page.goto("/account/#membership");
        await expect(page.locator("#account-email")).toHaveText(email);

        const m = await page.locator("#account-app .account-head")
          .evaluate((head) => {
            const el = head.querySelector("#account-email");
            const walk = document.createTreeWalker(el,
              NodeFilter.SHOW_TEXT);
            const chars = [];

            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
              for (let i = 0; i < n.data.length; i += 1) {
                const range = document.createRange();

                range.setStart(n, i);
                range.setEnd(n, i + 1);

                const r = range.getBoundingClientRect();

                if (r.width > 0) {
                  chars.push({ c: n.data[i], top: r.top, right: r.right });
                }
              }
            }

            // The character that starts each line after the first.
            const starts = chars.filter((ch, i) => i > 0
                && ch.top > chars[i - 1].top + 2).map((ch) => ch.c);

            return {
              starts,
              inside: Math.max(...chars.map((ch) => ch.right))
                  <= head.getBoundingClientRect().right + 0.5,
            };
          });

        for (const c of m.starts) expect(["@", "."]).toContain(c);
        expect(m.inside).toBe(true);
      });
    }
  }
});
