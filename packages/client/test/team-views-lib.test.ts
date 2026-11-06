import { describe, expect, test } from "bun:test";
import type { AgentGroup, TeamAgent } from "../src/api/types";
import {
  chartByPerson,
  filterTeam,
  mapColumns,
  noSectorsCopy,
  reportsTo,
  sectorGap,
  sectorReach,
  sortTeam,
} from "../src/lib/team-views";

const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id,
  name: id,
  handle: id.toLowerCase(),
  role: "",
  appearance: null,
  ownerUserId: null,
  capabilities: [],
  busy: false,
  canTalk: true,
  channelIds: [],
  ...over,
});
const ada = agent("Ada", { role: "Dev", ownerUserId: "u-lukas", channelIds: ["c-eng"], busy: true });
const kai = agent("Kai", { role: "Revisor", channelIds: ["c-eng", "c-ops"] });
const milo = agent("Milo", { role: "Financeiro", ownerUserId: "u-amara" });
const lodi = agent("Lodi");
const eng: AgentGroup = { id: "g-eng", name: "Engenharia", agentIds: ["Kai", "Ada"], leadUserId: "u-lukas" };
const members = new Set(["u-lukas", "u-amara"]);

describe("Equipe's views (ADR 0148)", () => {
  test("an empty Setores offers the first one only to who can create it", () => {
    expect(noSectorsCopy(true).title).toBe("team.sectors.emptyTitle");
    expect(noSectorsCopy(false).text).toBe("team.sectors.emptyViewer");
  });

  test("the list: a filter, then a search by name, role or a channel's name", () => {
    const names = (list: TeamAgent[]) => list.map((a) => a.name);
    const all = [ada, kai, milo];
    const base = { q: "", meId: "u-amara", channelName: (id: string) => ({ "c-eng": "engenharia" })[id] };
    expect(names(filterTeam(all, { ...base, filter: "mine" }))).toEqual(["Milo"]);
    expect(names(filterTeam(all, { ...base, filter: "working" }))).toEqual(["Ada"]);
    expect(names(filterTeam(all, { ...base, filter: "noOwner" }))).toEqual(["Kai"]);
    expect(names(filterTeam(all, { ...base, filter: "waiting", waitingIds: new Set(["Kai"]) }))).toEqual(["Kai"]);
    expect(names(filterTeam(all, { ...base, filter: "all", q: "ENGEN" }))).toEqual(["Ada", "Kai"]);
    expect(names(filterTeam(all, { ...base, filter: "all", q: "finan" }))).toEqual(["Milo"]);
  });

  test("sorting by a column puts the empty ones last either way", () => {
    const names = {
      sector: (id: string) => (eng.agentIds.includes(id) ? "Engenharia" : ""),
      owner: (id: string | null) => id ?? "",
    };
    expect(sortTeam([milo, kai, ada], "name", false, names).map((a) => a.name)).toEqual(["Ada", "Kai", "Milo"]);
    expect(sortTeam([milo, kai, ada], "sector", true, names).map((a) => a.name)).toEqual(["Ada", "Kai", "Milo"]);
    expect(sortTeam([kai, milo, ada], "owner", false, names).map((a) => a.name)).toEqual(["Milo", "Ada", "Kai"]);
  });

  test("the org chart: under the owner, else the setor's lead, else nobody; the right hand on its own", () => {
    expect(reportsTo(kai, [eng], members)).toBe("u-lukas");
    // A lead who left the workspace leads nobody.
    expect(reportsTo(kai, [eng], new Set(["u-amara"]))).toBeNull();
    const cols = chartByPerson([ada, kai, milo, lodi], [eng], members, (a) => a.id === "Lodi");
    expect(cols.map((c) => [c.personId, c.agents.map((a) => a.name)])).toEqual([
      ["u-lukas", ["Ada", "Kai"]],
      ["u-amara", ["Milo"]],
    ]);
    expect(chartByPerson([kai], [], members).map((c) => c.personId)).toEqual([null]);
  });

  test("the map: a column per channel in the sidebar's order, an agent in each of its channels, none last", () => {
    const cols = mapColumns([ada, kai, milo, lodi], ["c-ops", "c-eng", "c-empty"], (a) => a.id === "Lodi");
    expect(cols.map((c) => [c.channelId, c.agents.map((a) => a.name)])).toEqual([
      ["c-ops", ["Kai"]],
      ["c-eng", ["Ada", "Kai"]],
      [null, ["Milo"]],
    ]);
    // A channel I don't see doesn't place an agent.
    expect(mapColumns([kai], ["c-eng"]).map((c) => c.channelId)).toEqual(["c-eng"]);
    expect(mapColumns([agent("X", { channelIds: ["c-secret"] })], ["c-eng"]).map((c) => c.channelId)).toEqual([null]);
  });

  test("a setor's people, channels and what it is missing", () => {
    expect(sectorReach({ ...eng, backupUserId: "u-amara" }, [ada, kai, milo])).toEqual({
      agents: [kai, ada],
      people: ["u-lukas", "u-amara"],
      channelIds: ["c-eng", "c-ops"],
    });
    expect(sectorGap({ ...eng, leadUserId: null })).toBe("noLead");
    expect(sectorGap(eng)).toBe("noBackup");
    expect(sectorGap({ ...eng, backupUserId: "u-amara" })).toBeNull();
  });
});
