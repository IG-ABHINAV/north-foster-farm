// The Playwright projects, by name. playwright.config.mjs refuses to
// load when its projects differ, and bin/e2e/retries.mjs reads a log's
// `[PROJECT]` as a test only when it names one of these, since the
// name goes into the issues `bin/nff promote main` files (#696,
// security 1).
export const PROJECTS = Object.freeze(["desktop", "phone", "iphone"]);
