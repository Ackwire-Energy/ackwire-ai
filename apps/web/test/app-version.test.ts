import { describe, expect, test } from "bun:test";
import { createVersionWatch, entryOf } from "../src/lib/app-version";

const page = (entry: string) =>
  `<!doctype html><html><head><script>var t = 1;</script><script type="module" crossorigin src="${entry}"></script></head></html>`;

describe("app version", () => {
  test("finds the app's module script in index.html", () => {
    expect(entryOf(page("/assets/index-abc.js"))).toBe("/assets/index-abc.js");
    expect(entryOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(entryOf("<html></html>")).toBeNull();
  });

  test("a new bundle on the server makes the tab stale, once", async () => {
    let html = page("/assets/index-abc.js");
    let staleCalls = 0;
    const watch = createVersionWatch({
      loaded: "/assets/index-abc.js",
      fetchHtml: async () => html,
      onStale: () => staleCalls++,
    });
    await watch.check();
    expect(watch.stale).toBe(false);
    html = page("/assets/index-def.js");
    await watch.check();
    await watch.check();
    expect(watch.stale).toBe(true);
    expect(staleCalls).toBe(1);
  });

  test("a failed fetch or an unknown page bundle never marks it stale", async () => {
    const failing = createVersionWatch({
      loaded: "/assets/index-abc.js",
      fetchHtml: async () => {
        throw new Error("offline");
      },
      onStale: () => {},
    });
    await failing.check();
    expect(failing.stale).toBe(false);
    const dev = createVersionWatch({ loaded: null, fetchHtml: async () => page("/assets/x.js"), onStale: () => {} });
    await dev.check();
    expect(dev.stale).toBe(false);
  });
});
