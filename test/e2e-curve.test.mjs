// The per-frame cart spec's check against the page's own ease record
// (#559, fix round on fb5908d7; e2e/support/curve.mjs). The frames are
// run 43321018668's clear on the iphone project, which the old step
// bound failed: a 48 ms frame on the curve's fast start, then 322 ms
// with nothing drawn.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  curve, movesIn, offCurve, offRest, progressOf, travelOf,
} from "../e2e/support/curve.mjs";

const EASE = "cubic-bezier(0.2, 0.8, 0.25, 1)";

// A floating frame of the sheet: the pane and its parts by top edge,
// each 20px tall, the foot always at the pane's bottom.
const frame = ({ top, move = null, y = 1600, bottom = 0, ...more }) => ({
  placement: "floating",
  fold: "open",
  y,
  vh: 664,
  bottom,
  resting: false,
  move,
  ops: {},
  pane: { top, bottom: 651 - bottom, left: 10, right: 380 },
  total: { top: top + 15, bottom: top + 35, left: 20, right: 370 },
  foot: { top: 567 - bottom, bottom: 638 - bottom, left: 20, right: 370 },
  ...more,
});
const at = (ms, no = 1) => ({ no, at: ms, duration: 420, easing: EASE });
const paneAt = (ms) => 230 + (516 - 230) * progressOf(at(ms));

describe("the cart's curve", () => {
  it("is the shared ease, start and end held", () => {
    const ease = curve(EASE);

    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    assert.equal(ease(-1), 0);
    assert.equal(ease(2), 1);
    // The CI frame: 48 ms of 420 is 43% of the way, 123px of the
    // 286px fold, as the timeline showed (230 to 353).
    assert.ok(Math.abs(ease(48 / 420) - 0.43) < 0.015);
    // One frame at 60 fps is about a sixth of the way.
    assert.ok(Math.abs(ease(16.7 / 420) - 0.16) < 0.02);
  });

  it("is linear when named so, and unknown otherwise", () => {
    assert.equal(curve("linear")(0.3), 0.3);
    assert.equal(curve("ease-in-out"), null);
    assert.throws(() => progressOf({ at: 1, duration: 2, easing: "ease" }));
  });

  it("reads no progress for a frame with no move", () => {
    assert.equal(progressOf(null), null);
  });
});

describe("the moves in a recording", () => {
  it("are runs of one move number, with the still frames around them", () => {
    const frames = [
      frame({ top: 230 }),
      frame({ top: 260, move: at(20, 4) }),
      frame({ top: 300, move: at(40, 4) }),
      frame({ top: 320, move: at(10, 5) }),
      frame({ top: 330 }),
    ];

    assert.deepEqual(movesIn(frames), [
      { no: 4, start: 1, end: 2, pre: 0, post: null },
      { no: 5, start: 3, end: 3, pre: null, post: 4 },
    ]);
  });
});

describe("a part on its curve", () => {
  it("passes a starved frame on the fast start (run 43321018668)", () => {
    const frames = [
      frame({ top: 230 }),
      frame({ top: 353, move: at(48) }),
      frame({ top: 515, move: at(370) }),
      frame({ top: 516 }),
    ];

    assert.equal(offCurve(frames), null);
  });

  it("fails a part that snaps while the others ease", () => {
    // The clear before round 3: the fold to closed in one frame.
    const frames = [
      frame({ top: 230 }),
      frame({ top: 459, move: at(17) }),
      frame({ top: 500, move: at(200) }),
      frame({ top: 516 }),
    ];
    const off = offCurve(frames);

    assert.equal(off.at, 1);
    assert.match(off.why, /the pane's top is \d+\.\dpx off its curve/);
  });

  it("fails one part on a clock of its own", () => {
    const frames = [
      frame({ top: 230 }),
      frame({ top: paneAt(100), move: at(100) }),
      frame({ top: 516 }),
    ];

    // The total row lags the pane by 30px.
    frames[1].total = {
      ...frames[1].total,
      top: frames[1].total.top - 30,
      bottom: frames[1].total.bottom - 30,
    };
    assert.match(offCurve(frames).why, /the total's top/);
  });

  it("holds a settled pane's parts against the page", () => {
    // Inline, the page scrolling 12px a frame: the screen moves, the
    // part on the page eases on the curve.
    const inline = (top, y, move) => frame({
      top: top - y, y, move, placement: "inline",
    });
    const frames = [
      inline(1000, 0),
      inline(1000 - 100 * progressOf(at(30)), 12, at(30)),
      inline(1000 - 100 * progressOf(at(200)), 24, at(200)),
      inline(900, 36),
    ];

    for (const f of frames) {
      f.pane = { ...f.pane, bottom: 1570 - f.y };
      f.foot = { ...f.foot, top: 1500 - f.y, bottom: 1560 - f.y };
    }
    assert.equal(offCurve(frames), null);
  });

  it("skips a part that comes or goes in the move", () => {
    const frames = [
      frame({ top: 230, lines: { top: 245 } }),
      frame({ top: paneAt(50), move: at(50), lines: { top: 600 } }),
      frame({ top: 516 }),
    ];

    assert.equal(offCurve(frames), null);
  });

  it("skips a part faded to nothing", () => {
    const frames = [
      frame({ top: 230, clear: { top: 220, bottom: 244 } }),
      frame({
        top: paneAt(50), move: at(50), clear: { top: 400, bottom: 424 },
        ops: { clear: 0.01 },
      }),
      frame({ top: 516, clear: { top: 506, bottom: 530 } }),
    ];

    assert.equal(offCurve(frames), null);
  });
});

describe("the cart unchanged", () => {
  it("fails a 23px step of the minimized pane (James's phone)", () => {
    const frames = [
      frame({ top: 516 }),
      frame({ top: 516, y: 1602 }),
      frame({ top: 539, y: 1604 }),
    ];

    assert.match(offRest(frames).why, /pane's top jumped 23\.0px/);
    assert.equal(offRest(frames).at, 2);
  });

  it("passes the resting place on its ease, and fails it without", () => {
    const eased = [
      frame({ top: 516, bottom: 0, resting: true }),
      frame({ top: 496, bottom: 20, resting: true }),
      frame({ top: 486, bottom: 30 }),
    ];

    assert.equal(offRest(eased), null);

    const cut = eased.map((f) => ({ ...f, resting: false }));

    assert.match(offRest(cut).why, /resting place moved 20\.0px/);
  });

  it("leaves the frames of a move to the curve check", () => {
    const frames = [
      frame({ top: 230 }),
      frame({ top: 353, move: at(48) }),
      frame({ top: 516 }),
    ];

    assert.equal(offRest(frames), null);
  });
});

// A move whose whole ease fell between two frames (#635). The frames
// are run 44315232945's minimize on scroll, on the iphone project: the
// open pane's top at 230, then, 488 ms later with no frame between, at
// 487 minimized. The ease is the lines' height giving up the 257px.
describe("a move the frames missed", () => {
  const fold = (keys = [{ height: "257px" }, { height: "0px" }]) => ({
    duration: 420, keys,
  });
  const missedFold = (began, gap = 488) => [
    frame({ top: 230, t: 17503 }),
    frame({ top: 487, t: 17503 + gap, began }),
    frame({ top: 487, t: 17503 + gap + 202 }),
  ];

  it("sums each eased length's range, by the axis it moves", () => {
    assert.deepEqual(travelOf([
      {
        offset: 0, height: "120px", paddingTop: "8px", opacity: "1",
        flexBasis: "90px", translate: "0px 12px", maxHeight: "none",
      },
      {
        offset: 1, height: "0px", paddingTop: "0px", opacity: "0",
        flexBasis: "130px", translate: "0px 0px", maxHeight: "none",
      },
    ]), { down: 140, across: 40 });
    assert.deepEqual(travelOf(), { down: 0, across: 0 });
  });

  it("still fails a jump with no ease begun", () => {
    const off = offRest(missedFold([]));

    assert.equal(off.at, 1);
    assert.match(off.why, /pane's top jumped 257\.0px.*at most 8/);
  });

  it("still passes an eased move seen frame by frame", () => {
    const frames = [
      frame({ top: 230, t: 0 }),
      frame({ top: paneAt(48), move: at(48), t: 48, began: [fold()] }),
      frame({ top: paneAt(370), move: at(370), t: 370 }),
      frame({ top: 516, t: 692 }),
    ];

    assert.equal(offCurve(frames), null);
    assert.equal(offRest(frames), null);
  });

  it("passes a whole ease missed between two far-apart frames", () => {
    assert.equal(offRest(missedFold([fold()])), null);
  });

  it("fails a jump larger than the ease's travel", () => {
    const short = fold([{ height: "100px" }, { height: "0px" }]);
    const off = offRest(missedFold([short]));

    assert.equal(off.at, 1);
    assert.match(off.why, /jumped 257\.0px .* more than the 100\.0px/);
  });

  it("fails it when the frames were close enough to see the ease", () => {
    const off = offRest(missedFold([fold()], 400));

    assert.match(off.why, /pane's top jumped 257\.0px.*at most 8/);
  });

  it("allows only the ease's own axis", () => {
    const across = fold([{ flexBasis: "257px" }, { flexBasis: "0px" }]);

    assert.match(offRest(missedFold([across])).why, /more than the 0\.0px/);
  });

  it("holds the next frame pair to the step again", () => {
    const frames = missedFold([fold()]);

    frames[2] = { ...frames[2], ...frame({ top: 507, t: frames[2].t }) };
    assert.equal(offRest(frames).at, 2);
    assert.match(offRest(frames).why, /jumped 20\.0px.*at most 8/);
  });
});

// The floating pane's resting place on its own CSS transition of
// `bottom`, 420 ms, missed whole between two frames (#635): the
// minimized pane rises 20px as the toolbar's gap grows.
describe("a resting place the frames missed", () => {
  const rise = (keys = [{ bottom: "0px" }, { bottom: "20px" }]) => ({
    duration: 420, keys,
  });
  const missedRise = (opts = {}) => {
    const { began = [rise()], gap = 500 } = opts;
    const ended = opts.ended ?? began.length;

    return [
      frame({ top: 516, bottom: 0, t: 0 }),
      frame({
        top: 496, bottom: 20, t: gap, restBegan: began, restEnded: ended,
      }),
      frame({ top: 496, bottom: 20, t: gap + 200 }),
    ];
  };

  it("still fails a move with no transition begun", () => {
    const off = offRest(missedRise({ began: [] }));

    assert.equal(off.at, 1);
    assert.match(off.why, /resting place moved 20\.0px .* with no ease/);
  });

  it("still judges a transition seen on a frame by that frame", () => {
    const frames = [
      frame({ top: 516, bottom: 0, t: 0 }),
      frame({ top: 476, bottom: 10, resting: true, t: 200 }),
      frame({ top: 476, bottom: 20, t: 500 }),
    ];

    // The pane's top went 40px up for 10 of rest: 30px it had no ease
    // for.
    assert.match(offRest(frames).why, /pane's top jumped -30\.0px/);
  });

  it("passes a whole transition missed between two far-apart frames",
    () => {
      assert.equal(offRest(missedRise()), null);
      // Over before its event came: its keyframes are gone, and its
      // having run to its end holds it.
      assert.equal(offRest(missedRise({
        began: [{ duration: 420, keys: null }],
      })), null);
    });

  it("fails a move larger than the transition's travel", () => {
    const short = rise([{ bottom: "0px" }, { bottom: "10px" }]);
    const off = offRest(missedRise({ began: [short] }));

    assert.match(off.why, /moved 20\.0px .* more than the 10\.0px/);
  });

  it("exempts nothing when the frames were close enough to see it", () => {
    assert.match(offRest(missedRise({ gap: 400 })).why, /with no ease/);
  });

  it("exempts nothing for a transition cut off or still running", () => {
    assert.match(offRest(missedRise({ ended: 0 })).why, /with no ease/);
  });
});
