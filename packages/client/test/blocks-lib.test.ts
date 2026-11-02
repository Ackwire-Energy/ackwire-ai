import { describe, expect, test } from "bun:test";
import type { Poll } from "../src/api/types";
import { BLOCK_KIT_CSS, BLOCK_KIT_JS } from "../src/lib/block-kit";
import { blockEvent, blockPage, pollAnswered, pollIsOpen, pollTally, pollToggle } from "../src/lib/blocks";

const HOST = {
  theme: "dark" as const,
  ramp: ["#111"],
  locale: "pt-BR",
  labels: { send: "Mandar", more: "Mais", thousand: "mil" },
};

describe("a block's page", () => {
  test("the policy comes before the kit, and the kit before what the agent wrote", () => {
    const page = blockPage('<ac-stat label="x"></ac-stat>', HOST);
    const policy = page.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(0);
    expect(policy).toBeLessThan(page.indexOf("window.__block"));
    expect(page.indexOf("window.__block")).toBeLessThan(page.indexOf("customElements.define"));
    expect(page.indexOf("customElements.define")).toBeLessThan(page.indexOf('<ac-stat label="x">'));
  });

  test("what the person set can't close the script it travels in", () => {
    const page = blockPage("<p>a</p>", { ...HOST, state: { name: "</script><script>x()</script>" } });
    expect(page).not.toContain("</script><script>x()");
  });

  test("the kit can sit in a page's script and speaks to both hosts", () => {
    expect(BLOCK_KIT_JS).not.toContain("</script");
    expect(BLOCK_KIT_JS).toContain("window.ReactNativeWebView");
    expect(BLOCK_KIT_JS).toContain("parent.postMessage");
  });

  test("nothing in the kit outweighs a plain button's look", () => {
    // That look sits in `:where`, which weighs nothing: a bare `button{...}` reset would take its padding and weight.
    expect(BLOCK_KIT_CSS).toContain(":where(button){");
    expect(BLOCK_KIT_CSS).not.toMatch(/(^|[\n}])button\{/);
  });

  test("the only plain button showing is the block's main action", () => {
    expect(BLOCK_KIT_CSS).toContain(":where(button[data-lead]:not([class])){");
    expect(BLOCK_KIT_JS).toContain('b.toggleAttribute("data-lead",live.length===1&&live[0]===b)');
  });
});

describe("what a frame may say", () => {
  test("only what is ours, in bounds", () => {
    expect(blockEvent({ type: "height", height: 10 })).toBeNull();
    expect(blockEvent("not json")).toBeNull();
    expect(blockEvent({ agentes: 1, type: "navigate", to: "x" })).toBeNull();
    expect(blockEvent({ agentes: 1, type: "height", height: -1 })).toBeNull();
    expect(blockEvent({ agentes: 1, type: "height", height: 1e9 })).toEqual({ type: "height", height: 20_000 });
    expect(blockEvent('{"agentes":1,"type":"ready"}')).toEqual({ type: "ready" });
  });

  test("a draft is plain text, cut to size, and empty can't be sent", () => {
    const e = blockEvent({
      agentes: 1,
      type: "draft",
      label: "L".repeat(99),
      text: `a\n\n${"b".repeat(3000)}`,
      ready: true,
    });
    expect(e).toMatchObject({ type: "draft", ready: true });
    if (e?.type !== "draft") throw new Error("no draft");
    expect(e.label).toHaveLength(40);
    expect(e.text).toHaveLength(2000);
    expect(e.text.startsWith("a b")).toBe(true);
    expect(blockEvent({ agentes: 1, type: "draft", label: "Go", text: "  ", ready: true })).toMatchObject({
      ready: false,
    });
    expect(blockEvent({ agentes: 1, type: "draft", text: "x", ready: true })).toBeNull();
  });
});

describe("polls", () => {
  const poll: Poll = {
    id: "p",
    closesAt: "2030-01-01T00:00:00.000Z",
    closedAt: null,
    people: 4,
    votes: [
      { userId: "a", option: 0 },
      { userId: "b", option: 0 },
      { userId: "b", option: 1 },
    ],
  };

  test("who marked what, and how many answered", () => {
    expect(pollTally(["X", "Y"], poll)).toEqual([
      { option: 0, label: "X", voters: ["a", "b"], share: 0.5 },
      { option: 1, label: "Y", voters: ["b"], share: 0.25 },
    ]);
    expect(pollAnswered(poll)).toBe(2);
  });

  test("a tap marks, moves or clears", () => {
    expect(pollToggle(poll, "a", 1, false)).toEqual([1]);
    expect(pollToggle(poll, "a", 1, true)).toEqual([0, 1]);
    expect(pollToggle(poll, "b", 0, true)).toEqual([1]);
    expect(pollToggle(poll, "a", 0, false)).toEqual([]);
  });

  test("open until its time or its close", () => {
    expect(pollIsOpen(poll, Date.parse("2029-12-31T00:00:00.000Z"))).toBe(true);
    expect(pollIsOpen(poll, Date.parse("2030-01-02T00:00:00.000Z"))).toBe(false);
    expect(pollIsOpen({ ...poll, closedAt: "2029-01-01T00:00:00.000Z" }, 0)).toBe(false);
  });
});
