// The implementer's own test for #615, from the security review of
// #618: bin/nff e2e checks pages the way e2e.yml's plan job does, and
// refuses a bad one before any dispatch, so nothing reaches GitHub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPages, e2eCommand } from "../bin/e2e/dispatch.mjs";

const world = (table) => {
  const posts = [];
  const lines = [];

  return {
    io: { flags: {}, out: (line) => lines.push(String(line)) },
    deps: {
      api: async (path, { method = "GET", body } = {}) => {
        if (method === "POST") posts.push(body);
        throw new Error(`no call expected: ${method} ${path}`);
      },
      table,
      branch: async () => "lane/pages-input",
      changed: async () => ["content/about/index.md"],
      wait: async () => {},
    },
    posts,
    printed: () => lines.join("\n"),
  };
};

describe("bin/nff e2e: pages checked before dispatch (#615)", () => {
  it("checkPages keeps site paths and names the rest", () => {
    const { pages, bad } = checkPages([" /about/ ", "", "/", "/a-b/c.d_e/",
      "/../x", "//x", "/a//b", "about", "/a b", "/a;b", "/é/"]);

    assert.deepEqual(pages.slice(0, 3), ["/about/", "/", "/a-b/c.d_e/"]);
    assert.deepEqual(bad, ["/../x", "//x", "/a//b", "about", "/a b",
      "/a;b", "/é/"]);
  });

  it("a bad named page exits 2 and dispatches nothing", async () => {
    const w = world({ shared: [], entries: [] });
    const code = await e2eCommand(["e2e/keyboard.spec.mjs", "/../etc"],
      w.io, w.deps);

    assert.equal(code, 2, w.printed());
    assert.equal(w.posts.length, 0);
    assert.match(w.printed(), /Not a site path e2e\.yml takes: \/\.\.\/etc/);
  });

  it("a bad page from the table exits 2, printed safely", async () => {
    const w = world({ shared: [], entries: [{
      paths: ["content/about/**"],
      specs: ["e2e/keyboard.spec.mjs"],
      pages: ["/about/\x1b[31m"],
    }] });

    assert.equal(await e2eCommand([], w.io, w.deps), 2, w.printed());
    assert.equal(w.posts.length, 0);
    assert.ok(!w.printed().includes("\x1b"), w.printed());
    assert.match(w.printed(), /Not a site path e2e\.yml takes: \/about\//);
  });
});
