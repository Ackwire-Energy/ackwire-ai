import { describe, expect, test } from "bun:test";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";

describe("mock: approvals", () => {
  test("seeds the screen's demo approvals on the org's real agents and channels", async () => {
    const api = createFakeApi();
    const list = await api.approvals.list(ORG_ID);
    expect(list.map((a) => [a.status, a.action])).toEqual([
      ["pending", "merge"],
      ["pending", "deploy"],
      ["approved", "rollback"],
      ["refused", "publish"],
    ]);
    expect(list[0]?.agentId).toBe(ADA_ID);
    expect(list[1]?.agentId).toBe(ATLAS_ID);
    expect(list.every((a) => a.channelId === ENG_ID)).toBe(true);
  });

  test("deciding records who and when", async () => {
    const api = createFakeApi();
    const [first] = await api.approvals.list(ORG_ID);
    const decided = await api.approvals.decide(ORG_ID, first?.id ?? "", "approved");
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toEqual({ userId: "u-walter", name: "Walter" });
    expect((await api.approvals.list(ORG_ID))[0]?.status).toBe("approved");
  });

  test("production (no seed) and orgs without agents start empty", async () => {
    expect(await createFakeApi(seedState(), { seed: false }).approvals.list(ORG_ID)).toEqual([]);
    expect(await createFakeApi(seedState({ agents: [] })).approvals.list(ORG_ID)).toEqual([]);
  });
});

describe("mock: permissions", () => {
  test("defaults, toggling, and approval-gated scopes stay granted", async () => {
    const api = createFakeApi();
    const initial = await api.permissions.get(ORG_ID, ADA_ID);
    expect(initial.connectors.map((c) => c.name)).toEqual(["GitHub", "Sentry", "Sandbox", "Drive"]);
    expect(initial.granted).not.toContain("drive-write");
    expect(initial.granted).toContain("gh-merge");
    const next = await api.permissions.set(ORG_ID, ADA_ID, ["gh-read", "unknown-scope"]);
    expect(next.granted.sort()).toEqual(["gh-merge", "gh-read"]);
    // Other agents are independent.
    expect((await api.permissions.get(ORG_ID, ATLAS_ID)).granted).toContain("sentry-read");
  });
});

describe("mock: memory, proposals, runs, invites, presence", () => {
  test("memory: seeded for the first agent only; editing keeps the replaced text", async () => {
    const api = createFakeApi();
    const list = await api.memory.list(ORG_ID, ADA_ID);
    expect(list).toHaveLength(7);
    expect(await api.memory.list(ORG_ID, ATLAS_ID)).toEqual([]);
    const fact = list.find((m) => m.kind === "fact" && !m.supersedes && !m.archived && !m.lowTrust);
    const edited = await api.memory.edit(ORG_ID, fact?.id ?? "", "Novo texto.");
    expect(edited.text).toBe("Novo texto.");
    expect(edited.supersedes).toBe(fact?.text ?? "");
    expect(edited.editedByUserId).toBe("u-walter");
    expect((await api.memory.setPinned(ORG_ID, edited.id, true)).pinned).toBe(true);
    expect((await api.memory.setArchived(ORG_ID, edited.id, true)).archived).toBe(true);
  });

  test("proposals: accept with an edited text, refuse", async () => {
    const api = createFakeApi();
    const [p1, p2] = await api.proposals.list(ORG_ID);
    expect(p1?.decider).toEqual({ type: "user", userId: "u-joao", name: "João" });
    expect(p2?.target).toEqual({ type: "org_context" });
    const accepted = await api.proposals.accept(ORG_ID, p1?.id ?? "", "Texto final");
    expect(accepted).toMatchObject({ status: "accepted", after: "Texto final" });
    expect((await api.proposals.refuse(ORG_ID, p2?.id ?? "")).status).toBe("refused");
  });

  test("runs, invite link and presence", async () => {
    const api = createFakeApi();
    const runs = await api.runs.list(ORG_ID, ADA_ID);
    expect(runs.runs[0]?.summary).toBe("Pediu aprovação para o merge do PR #42");
    expect(runs.total).toBe(runs.runs.length);
    expect((await api.invites.createLink(ORG_ID)).url).toStartWith("http://localhost:3000/invite/");
    expect(Object.keys(await api.presence.list(ORG_ID))).toEqual(["u-walter"]);
  });
});
