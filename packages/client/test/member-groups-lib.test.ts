import { describe, expect, test } from "bun:test";
import type { AgentStatus, MemberPresence, OrgRole } from "../src/api/types";
import { memberGroups, sheetGroups } from "../src/lib/member-groups";
import { agentFaceOf, agentMemberLine, agentWhyKey, isAgentOff, liveLine } from "../src/lib/presence";

const role = (id: string, position: number, hoist = true): OrgRole => ({
  id,
  kind: "custom",
  name: id,
  icon: "shield",
  color: "indigo",
  position,
  permissions: [],
  mentionable: false,
  hoist,
  people: 0,
  editable: false,
  givable: false,
});
const everyone: OrgRole = { ...role("everyone", 99), kind: "everyone" };
const person = (userId: string, roleIds: string[] = [], owner = false) => ({
  userId,
  name: userId,
  role: owner ? ("owner" as const) : ("member" as const),
  roleIds,
});

const presence: Record<string, MemberPresence> = {
  heitor: "online",
  walter: "busy",
  caio: "online",
  bia: "away",
  lara: "offline",
  davi: "hidden",
  ivo: "offline",
};

const group = (opts: Partial<Parameters<typeof memberGroups>[0]> = {}) =>
  memberGroups({
    people: [
      person("lara", ["admin"]),
      person("caio", ["comercial", "admin"]),
      person("bia"),
      person("heitor", ["admin"], true),
      person("davi"),
      person("walter", ["admin"]),
      person("ivo", [], true),
    ],
    agents: [
      { id: "rui", name: "Rui" },
      { id: "theo", name: "Theo" },
      { id: "ada", name: "Ada" },
    ],
    roles: [role("comercial", 2), role("admin", 0), role("quiet", 1, false), everyone],
    presenceOf: (id) => presence[id],
    busy: (id) => id === "theo",
    ...opts,
  });

const ids = (g: ReturnType<typeof group>[number]) =>
  g.rows.map((r) => (r.kind === "person" ? r.person.userId : r.agent.id));

describe("memberGroups", () => {
  test("owner first, hoisted roles top first, agents, online, offline", () => {
    const groups = group();
    expect(groups.map((g) => g.key)).toEqual(["owner", "role:admin", "agents", "online", "offline"]);
    expect(groups.map(ids)).toEqual([
      ["heitor"],
      ["caio", "walter"],
      ["theo", "ada", "rui"],
      ["bia"],
      ["davi", "ivo", "lara"],
    ]);
    expect(groups[1]?.role?.id).toBe("admin");
  });

  test("the highest hoisted role wins and a person shows once", () => {
    const groups = group({ roles: [role("comercial", 0), role("admin", 1)] });
    expect(groups.map((g) => [g.key, ids(g)])).toContainEqual(["role:comercial", ["caio"]]);
    expect(groups.map((g) => [g.key, ids(g)])).toContainEqual(["role:admin", ["walter"]]);
    expect(groups.flatMap(ids).filter((id) => id === "caio")).toHaveLength(1);
  });

  test("offline people only under Offline, a hidden one too, an offline owner as well", () => {
    const offline = group().find((g) => g.key === "offline");
    expect(offline && ids(offline)).toEqual(["davi", "ivo", "lara"]);
  });

  test("a role that isn't hoisted and the base role never get a group; empty groups are left out", () => {
    const groups = group({ agents: [], roles: [role("quiet", 0, false), { ...everyone, hoist: true }] });
    expect(groups.map((g) => g.key)).toEqual(["owner", "online", "offline"]);
    expect(ids(groups[1] as (typeof groups)[number])).toEqual(["bia", "caio", "walter"]);
  });
});

describe("an agent off for now", () => {
  test("sits under Offline with the people there, by name, and leaves Agentes", () => {
    const groups = group({ agentOff: (id) => id === "rui" || id === "ada" });
    expect(groups.map((g) => [g.key, ids(g)])).toEqual([
      ["owner", ["heitor"]],
      ["role:admin", ["caio", "walter"]],
      ["agents", ["theo"]],
      ["online", ["bia"]],
      ["offline", ["ada", "davi", "ivo", "lara", "rui"]],
    ]);
  });

  test("every agent off: no Agentes group", () => {
    expect(group({ agentOff: () => true }).map((g) => g.key)).toEqual(["owner", "role:admin", "online", "offline"]);
  });

  test("off is out of office or offline (held, or no AI); at work, waiting on you or free is not", () => {
    expect(isAgentOff("out")).toBe(true);
    expect(isAgentOff("offline")).toBe(true);
    for (const face of ["working", "waiting", "online"] as const) expect(isAgentOff(face)).toBe(false);
  });

  const status = (presence: AgentStatus["presence"], working?: boolean): AgentStatus => ({
    agentId: "ada",
    presence,
    status: null,
    activeAt: null,
    ...(working === undefined ? {} : { working }),
  });
  const off = (...args: Parameters<typeof agentFaceOf>) => isAgentOff(agentFaceOf(...args).presence);

  test("one rule for the row's face and the list's group: a run in progress is never off", () => {
    // Out of office, paused or with no AI, idle: off.
    expect(off(status("out"), "ready")).toBe(true);
    expect(off(status("offline"), "ready")).toBe(true);
    expect(off(status("online"), "no_ai")).toBe(true);
    expect(agentFaceOf(status("online"), "no_ai")).toEqual({ presence: "offline", noAi: true });
    // A run this app hears, or one the server says thinks: at work, whatever its plan or AI reads.
    expect(off(status("out"), "ready", true)).toBe(false);
    expect(off(status("online"), "no_ai", true)).toBe(false);
    expect(off(status("online", true), "no_ai")).toBe(false);
    expect(agentFaceOf(status("out"), "ready", true)).toEqual({ presence: "working", noAi: false });
    // Its computer away is not "no AI".
    expect(off(status("online"), "waiting")).toBe(false);
    expect(off(undefined, undefined)).toBe(false);
  });

  test("the one exception: held by the operators, it is off even with a run going (the hold stops that run)", () => {
    expect(agentFaceOf(status("offline"), "ready", true)).toEqual({ presence: "offline", noAi: false });
    expect(off(status("offline", true), "ready", true)).toBe(true);
  });

  test("the line under an agent in a members list: its work, else its own line, else why it is off", () => {
    expect(agentMemberLine("Esperando você", "Sem limite · volta às 16:00", "out")).toEqual({ work: "Esperando você" });
    expect(agentMemberLine("retorno às 00:32", null, "noAi")).toEqual({ work: "retorno às 00:32" });
    expect(agentMemberLine(null, "Sem limite · volta às 16:00", "out")).toEqual({
      line: "Sem limite · volta às 16:00",
    });
    expect(agentMemberLine(null, null, "offline")).toEqual({ why: "offline" });
    expect(agentMemberLine(null, undefined, null)).toBeNull();
  });

  test("a line whose end has passed reads as none", () => {
    const at = Date.parse("2026-01-02T16:00:00Z");
    const line = { until: "2026-01-02T16:00:00Z" };
    expect(liveLine(line, at - 1)).toBe(line);
    expect(liveLine(line, at + 1)).toBeNull();
    expect(liveLine({ until: null }, at)).toEqual({ until: null });
    expect(liveLine(null)).toBeNull();
  });

  test("why its face says what it says: no AI, out of office, held; nothing for its work or while free", () => {
    expect(agentWhyKey("working", false)).toBeNull();
    expect(agentWhyKey("waiting", false)).toBeNull();
    expect(agentWhyKey("online", false)).toBeNull();
    expect(agentWhyKey("out", false)).toBe("out");
    expect(agentWhyKey("offline", false)).toBe("offline");
    expect(agentWhyKey("offline", true)).toBe("noAi");
  });
});

describe("the phone's members sheet", () => {
  const w = (name: string, kind: "person" | "agent") => ({ name, kind });
  const all = [w("Theo", "agent"), w("Rui", "agent"), w("Lara", "person"), w("Ada", "agent"), w("Bia", "person")];
  const offNames = new Set(["Rui", "Lara", "Ada"]);
  const off = (x: { name: string }) => offNames.has(x.name);
  const names = (rows: { name: string }[]) => rows.map((r) => r.name);

  test("agents and people here, then everyone off by name; counts leave the off ones out", () => {
    const groups = sheetGroups(all, all, off);
    expect(groups.map((g) => [g.key, g.count, names(g.rows)])).toEqual([
      ["agents", 1, ["Theo"]],
      ["people", 1, ["Bia"]],
      ["offline", 3, ["Ada", "Lara", "Rui"]],
    ]);
  });

  test("a search filters all three groups and keeps the counts", () => {
    const found = all.filter((x) => x.name.includes("a"));
    const groups = sheetGroups(all, found, off);
    expect(groups.map((g) => [g.key, g.count, names(g.rows)])).toEqual([
      ["agents", 1, []],
      ["people", 1, ["Bia"]],
      ["offline", 3, ["Ada", "Lara"]],
    ]);
  });
});
