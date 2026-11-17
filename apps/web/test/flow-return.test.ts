import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { flowReturn } from "@/lib/flow-return";

const KEY = "test.flow";
afterEach(() => sessionStorage.clear());
const at = (path: string) => window.history.replaceState(null, "", path);

test("a flow saved before a sign-in elsewhere is taken once on the way back, with the address's parameters", () => {
  const back = flowReturn<{ name: string }>(KEY);
  at("/org/o1/agents/new?channel=c1");
  expect(back.path({ install: "https://github.com/acme/skills" })).toBe(
    "/org/o1/agents/new?resume=1&install=https%3A%2F%2Fgithub.com%2Facme%2Fskills",
  );
  back.save("o1", { name: "Lia" });
  // Not the way back: nothing is taken, and what was saved waits.
  expect(back.take("o1")).toBeNull();
  at("/org/o1/agents/new?resume=1&connected=github");
  expect(back.take("o1")).toEqual({ draft: { name: "Lia" }, params: { connected: "github" } });
  expect(window.location.search).toBe("");
  // Once: a reload of the same address starts afresh.
  at("/org/o1/agents/new?resume=1");
  expect(back.take("o1")).toBeNull();
});

test("another workspace's, an old one or a broken one is dropped, and the address is cleaned all the same", () => {
  const back = flowReturn<{ name: string }>(KEY);
  back.save("o1", { name: "Lia" });
  at("/org/o2/agents/new?resume=1");
  expect(back.take("o2")).toBeNull();
  expect(sessionStorage.getItem(KEY)).toBeNull();

  sessionStorage.setItem(
    KEY,
    JSON.stringify({ org: "o1", at: Date.now() - 2 * 60 * 60 * 1000, draft: { name: "Lia" } }),
  );
  at("/org/o1/agents/new?resume=1");
  expect(back.take("o1")).toBeNull();

  sessionStorage.setItem(KEY, "{not json");
  at("/org/o1/agents/new?resume=1");
  expect(back.take("o1")).toBeNull();
  expect(window.location.search).toBe("");

  back.save("o1", { name: "Lia" });
  back.forget();
  at("/org/o1/agents/new?resume=1");
  expect(back.take("o1")).toBeNull();
});
