// A page with market links (/about/, the home page) shows "Order for
// pickup here" under each market open for pickup once /api/dates
// answers (schedule.js), a line that moves everything below it. On
// staging a market is often open, so a spec that measures the page or
// points at the footer waits for that answer first. Then two frames,
// for the reveal to lay out.

const frames = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
}));

// Runs `load` (a goto or a reload) and waits for the page's dates,
// body and all: the line shows once the page has read them.
export const settled = async (page, load) => {
  const dates = page.waitForResponse("**/api/dates");

  await load();
  await (await dates).finished();
  await frames(page);
};
