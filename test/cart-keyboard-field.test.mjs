import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { watchKeyboard } from "../assets/scripts/order/cart/view.mjs";

// The keyboard's rise brings the focused code field into view at once,
// not on a later frame (#635): a phone that draws late left the field
// out of view until that frame came. A stand-in window, visual
// viewport, document and pane; requestAnimationFrame never runs, as on
// a renderer that has not drawn yet.
describe("watchKeyboard and the code field", () => {
  const saved = {};
  let visual;
  let scrolled;
  let frames;
  let field;
  let pane;

  beforeEach(() => {
    for (const k of ["window", "document", "requestAnimationFrame",
      "cancelAnimationFrame"]) saved[k] = globalThis[k];

    scrolled = [];
    frames = [];
    visual = new EventTarget();
    visual.height = 568;
    visual.width = 320;
    visual.offsetTop = 0;
    visual.scale = 1;
    globalThis.window = {
      innerHeight: 568,
      visualViewport: visual,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    field = {
      matches: (s) => s === "[data-field='code']",
      scrollIntoView: (o) => scrolled.push(o),
    };
    const props = new Map();

    pane = {
      style: {
        getPropertyValue: (n) => props.get(n) || "",
        setProperty: (n, v) => props.set(n, v),
        removeProperty: (n) => props.delete(n),
      },
      setAttribute: () => {},
      removeAttribute: () => {},
      hasAttribute: () => false,
      contains: (el) => el === field,
    };
    globalThis.document = { activeElement: field };
    globalThis.requestAnimationFrame = (cb) => frames.push(cb);
    globalThis.cancelAnimationFrame = () => {};
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) globalThis[k] = v;
  });

  const rise = (kb) => {
    visual.height = 568 - kb;
    visual.dispatchEvent(new Event("resize"));
  };

  it("brings the focused field into view before the next frame", () => {
    watchKeyboard(pane);
    rise(300);

    assert.deepEqual(scrolled, [{ block: "nearest" }]);
  });

  it("leaves no later frame to scroll the body again", () => {
    watchKeyboard(pane);
    rise(300);
    for (const cb of frames.splice(0)) cb(0);

    assert.equal(scrolled.length, 1);
  });

  it("scrolls nothing when the focus is elsewhere", () => {
    globalThis.document.activeElement = { matches: () => false };
    watchKeyboard(pane);
    rise(300);
    for (const cb of frames.splice(0)) cb(0);

    assert.equal(scrolled.length, 0);
  });
});
