// A tap on a discount badge is never dropped (#644). A scroll shuts a
// badge's tooltip at once (#569); a tap that came about 155 ms after
// the one that opened it, just as Bootstrap's timer for the end of
// that show ran out, used to show nothing. The motion spec found it
// on a slow runner (cart-motion.spec.mjs, "shuts on any scroll"); this
// spec lands taps on that timer on purpose, in every project.

import { OrderPage, expect, settleCart, test } from "./support/order.mjs";

// Runs in the page: taps a badge, scrolls the pane's body, which shuts
// the badge's tooltip (#569), and taps the badge again `delay` ms
// after the first tooltip began to show, for every delay given.
// Returns the delays whose second tap showed nothing.
//
// The second tap has to land on Bootstrap's own timer: the end of a
// show waits on its 150 ms fade plus 5 ms, so the delays straddle
// 155 ms, more than once each, since the timers drift by a few.
const retap = async ({ delays }) => {
  const wait = (ms) => new Promise((done) => { setTimeout(done, ms); });
  const pane = document.getElementById("order-cart");
  const badge = pane.querySelector("[data-badge='delivery']");
  const body = pane.querySelector("[data-cart-body]");
  const open = () => document.querySelector(".tooltip.show") !== null;
  const dropped = [];

  for (const delay of delays) {
    let began = 0;

    badge.addEventListener("show.bs.tooltip", () => {
      began = performance.now();
    }, { once: true });
    badge.click();
    await wait(30);
    if (!open()) throw new Error(`the first tap showed nothing (${delay})`);
    body.dispatchEvent(new Event("scroll"));
    if (document.querySelector(".tooltip")) {
      throw new Error(`the scroll left the tooltip (${delay})`);
    }

    await wait(Math.max(0, began + delay - performance.now()));
    badge.click();
    await wait(50);
    if (!open()) {
      dropped.push(delay);
      // The dropped tap left Bootstrap's click flag set: one more tap
      // clears it.
      badge.click();
      await wait(50);
    }
    body.dispatchEvent(new Event("scroll"));
    // Every timer of this round has run out before the next.
    await wait(200);
  }

  return dropped;
};

// 145 to 165 ms, three times over.
const RETAP_DELAYS = [0, 1, 2].flatMap(() => Array.from(
  { length: 21 }, (_, i) => 145 + i
));

// Runs in the page: opens a badge's tooltip, taps the badge again so
// the tooltip fades out, and `shut`s it ("scroll" or "escape") partway
// through that fade. Then taps once more. Returns whether that tap
// showed a tooltip and whether the tooltip faded in.
const shutFading = async ({ shut }) => {
  const wait = (ms) => new Promise((done) => { setTimeout(done, ms); });
  const pane = document.getElementById("order-cart");
  const badge = pane.querySelector("[data-badge='delivery']");
  const body = pane.querySelector("[data-cart-body]");

  badge.click();
  // The show's fade is over.
  await wait(250);
  badge.click();
  // Halfway through the hide's 150 ms fade.
  await wait(60);
  if (shut === "scroll") {
    body.dispatchEvent(new Event("scroll"));
  } else {
    badge.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    }));
  }
  // Every timer of the hide has run out.
  await wait(250);
  badge.click();
  await wait(50);

  const tip = document.querySelector(".tooltip.show");
  const shown = {
    shown: tip !== null, fades: tip?.classList.contains("fade"),
  };

  badge.click();
  await wait(250);

  return shown;
};

const openCart = async (page) => {
  const order = new OrderPage(page);

  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("nff-cart-first-add", "1");
    } catch {
      // Blocked storage: the first Add's lesson runs, and its own
      // spec covers it.
    }
  });
  await order.open({ eggs: 2, wings: 1 });
  await settleCart(order);
};

test("a tap soon after a scroll shut the last tooltip shows its own",
  async ({ page }) => {
    test.setTimeout(120_000);
    await openCart(page);

    const dropped = await page.evaluate(retap, { delays: RETAP_DELAYS });

    expect(dropped, "the delays (ms) whose tap showed nothing")
      .toEqual([]);
  });

test("a scroll or Escape while a tooltip fades out breaks nothing",
  async ({ page }) => {
    const errors = [];

    page.on("pageerror", (error) => errors.push(error.message));
    await openCart(page);

    for (const shut of ["scroll", "escape"]) {
      const after = await page.evaluate(shutFading, { shut });

      expect(after, `the next tap's tooltip, after a ${shut}`)
        .toEqual({ shown: true, fades: true });
    }
    expect(errors, "the page's errors").toEqual([]);
  });
