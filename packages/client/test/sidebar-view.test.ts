import { expect, test } from "bun:test";
import { dayOnePins, pinsOf, SIDEBAR_VIEW_DEFAULT, sortAgents, togglePin } from "../src/lib/sidebar-view";

const agent = (id: string, name: string, ownerUserId: string | null = null) => ({ id, name, ownerUserId });

test("day one pins my own agents, the most recently active first, then by name, five at most", () => {
  const agents = [
    agent("a", "Ada", "me"),
    agent("b", "Bia", "me"),
    agent("c", "Caio", "other"),
    ...["d", "e", "f", "g"].map((id) => agent(id, id.toUpperCase(), "me")),
  ];
  expect(dayOnePins(agents, "me", new Map([["b", "2026-11-03T10:00:00Z"]]))).toEqual(["b", "a", "d", "e", "f"]);
  expect(dayOnePins(agents, "nobody")).toEqual([]);
});

test("saved pins win over day one's; pinning adds at the end, a sixth is refused, unpinning takes it off", () => {
  expect(pinsOf(SIDEBAR_VIEW_DEFAULT, ["a"])).toEqual({ agents: ["a"], channels: [], people: [] });
  const saved = { ...SIDEBAR_VIEW_DEFAULT, pins: { agents: [], channels: ["1", "2", "3", "4"], people: [] } };
  expect(pinsOf(saved, ["a"]).agents).toEqual([]);
  const five = togglePin(saved.pins, "channels", "5");
  expect(five?.channels).toEqual(["1", "2", "3", "4", "5"]);
  expect(five && togglePin(five, "channels", "6")).toBeNull();
  expect(five && togglePin(five, "channels", "2")?.channels).toEqual(["1", "3", "4", "5"]);
});

test("a group's order: the workspace's, mine first or working first, each keeping the rest in place", () => {
  const list = [agent("a", "Ada"), agent("b", "Bia", "me"), agent("c", "Caio"), agent("d", "Dario", "me")];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  expect(ids(sortAgents(list, "workspace", "me"))).toEqual(["a", "b", "c", "d"]);
  expect(ids(sortAgents(list, "mine", "me"))).toEqual(["b", "d", "a", "c"]);
  expect(ids(sortAgents(list, "working", "me", new Set(["c"])))).toEqual(["c", "a", "b", "d"]);
});
