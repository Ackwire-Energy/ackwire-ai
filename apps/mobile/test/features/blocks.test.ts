import { describe, expect, test } from "bun:test";
import { blockMayLoad, MAX_LIVE_BLOCKS, themeScript, withLiveBlock } from "../../src/features/blocks/logic";

describe("live blocks on the phone", () => {
  test("a block never leaves its page", () => {
    expect(blockMayLoad("about:blank")).toBe(true);
    for (const url of [
      "https://example.com/?d=1",
      "http://x.test",
      "tel:123",
      "intent://x",
      "file:///etc",
      "data:text/html,a",
    ]) {
      expect(blockMayLoad(url)).toBe(false);
    }
  });

  test("only the newest frames run", () => {
    let live: string[] = [];
    for (const key of ["a", "b", "c", "d"]) live = withLiveBlock(live, key);
    expect(live).toEqual(["b", "c", "d"]);
    expect(live).toHaveLength(MAX_LIVE_BLOCKS);
    expect(withLiveBlock(live, "b")).toEqual(["c", "d", "b"]);
  });

  test("a theme reaches the page without a reload", () => {
    expect(themeScript("dark")).toBe('window.__agentesHost&&window.__agentesHost({"theme":"dark"});true;');
  });
});
