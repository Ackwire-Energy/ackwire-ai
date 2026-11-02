import { describe, expect, test } from "bun:test";
import {
  OPEN_WIKI_ACCESS,
  type WikiAccess,
  wikiAccessDraft,
  wikiAccessLimited,
  wikiAccessOf,
  wikiBaseLevels,
  wikiRowCap,
} from "../src/lib/wiki";

const none = { roleIds: [], userIds: [] };

describe("the wiki access form", () => {
  test("every shape survives a trip through the form", () => {
    const shapes: WikiAccess[] = [
      OPEN_WIKI_ACCESS,
      { ...OPEN_WIKI_ACCESS, audience: { roleIds: ["r"], userIds: ["u"] } },
      { ...OPEN_WIKI_ACCESS, editors: { roleIds: ["r"], userIds: [] } },
      {
        audience: { roleIds: ["r", "s"], userIds: [] },
        editors: { roleIds: ["r"], userIds: [] },
        agentIds: ["a", "b"],
        agentEditorIds: ["a"],
      },
      { ...OPEN_WIKI_ACCESS, agentIds: [] },
      { ...OPEN_WIKI_ACCESS, agentEditorIds: ["a"] },
    ];
    for (const shape of shapes) expect(wikiAccessOf(wikiAccessDraft(shape))).toEqual(shape);
  });

  test("levels read as a person would say them", () => {
    const d = wikiAccessDraft({
      audience: { roleIds: ["finance", "sales"], userIds: [] },
      editors: { roleIds: ["finance"], userIds: [] },
      agentIds: null,
      agentEditorIds: ["nina"],
    });
    expect(d.people).toBe("none");
    expect(d.roles).toEqual({ finance: "edit", sales: "view" });
    expect(d.agents).toBe("view");
    expect(d.agentRows).toEqual({ nina: "edit" });
  });

  test("a list where everyone chosen edits needs no editors' list", () => {
    const d = wikiAccessDraft({ ...OPEN_WIKI_ACCESS, audience: none });
    expect(wikiAccessOf({ ...d, roles: { r: "edit" } }).editors).toBeNull();
    expect(wikiAccessOf({ ...d, roles: { r: "edit", s: "view" } }).editors).toEqual({ roleIds: ["r"], userIds: [] });
  });

  test("a row switched off leaves the lists", () => {
    const d = wikiAccessDraft({ ...OPEN_WIKI_ACCESS, audience: { roleIds: ["r", "s"], userIds: [] } });
    expect(wikiAccessOf({ ...d, roles: { r: "edit", s: "none" } }).audience?.roleIds).toEqual(["r"]);
  });

  test("everyone can edit drops rows left behind", () => {
    const d = wikiAccessDraft({ ...OPEN_WIKI_ACCESS, audience: { roleIds: ["r"], userIds: [] } });
    expect(wikiAccessOf({ ...d, people: "edit" })).toEqual(OPEN_WIKI_ACCESS);
    expect(wikiAccessLimited(OPEN_WIKI_ACCESS)).toBe(false);
  });

  test("a limited folder caps what a page may offer", () => {
    expect(wikiBaseLevels("edit")).toEqual(["edit", "view", "none"]);
    expect(wikiBaseLevels("view")).toEqual(["view", "none"]);
    expect(wikiBaseLevels("none")).toEqual(["none"]);
    expect(wikiRowCap("edit", undefined)).toBe("edit");
    expect(wikiRowCap("view", undefined)).toBe("view");
    expect(wikiRowCap("view", "edit")).toBe("edit");
    expect(wikiRowCap("none", "view")).toBe("view");
    expect(wikiRowCap("none", undefined)).toBe("none");
  });
});
