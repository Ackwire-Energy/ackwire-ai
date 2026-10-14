import { describe, expect, test } from "bun:test";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";

/** The only mocks left: memory, proposals, the org-wide invite link and "ask for a new invitation". */
describe("mock: memory", () => {
  test("seeded for the first agent only; editing keeps the replaced text", async () => {
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

  test("production builds start empty", async () => {
    expect(await createFakeApi(seedState(), { seed: false }).memory.list(ORG_ID, ADA_ID)).toEqual([]);
  });
});

describe("mock: proposals and invites", () => {
  test("proposals: accept with an edited text, refuse", async () => {
    const api = createFakeApi();
    const [p1, p2] = await api.proposals.list(ORG_ID);
    expect(p1?.decider).toEqual({ type: "user", userId: "u-joao", name: "João" });
    expect(p2?.target).toEqual({ type: "org_context" });
    const accepted = await api.proposals.accept(ORG_ID, p1?.id ?? "", "Texto final");
    expect(accepted).toMatchObject({ status: "accepted", after: "Texto final" });
    expect((await api.proposals.refuse(ORG_ID, p2?.id ?? "")).status).toBe("refused");
  });

  test("org-wide invite link", async () => {
    expect((await createFakeApi().invites.createLink(ORG_ID)).url).toStartWith("http://localhost:3000/invite/");
  });
});
