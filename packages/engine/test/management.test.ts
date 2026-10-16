import { afterEach, describe, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  acceptInvitation,
  agentDetail,
  budgetPercent,
  ConflictError,
  createModelGateway,
  DEFAULT_AGENT_BUDGET_NANO_USD,
  deleteCredential,
  drainOutbox,
  ForbiddenError,
  inviteMany,
  listInvitationsWithStatus,
  listRuns,
  orgOverview,
  postPersonMessage,
  resendInvitation,
  rotateCredential,
  setAgentChannels,
  updateChannel,
  updateOrgSettings,
  usageReport,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("organization settings", () => {
  test("admins change context and settings; values are validated", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(updateOrgSettings(f.db, member.id, f.org.id, { context: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOrgSettings(f.db, f.owner.id, f.org.id, { routerModel: "gpt-9" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(updateOrgSettings(f.db, f.owner.id, f.org.id, { timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultCredentialId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ValidationError);
    const s = await updateOrgSettings(f.db, f.owner.id, f.org.id, {
      context: "Acme builds rockets. We deploy on Fridays never.",
      routerModel: "claude-haiku-5-5",
      timezone: "America/Sao_Paulo",
      defaultCredentialId: f.credential.id,
    });
    expect(s).toMatchObject({ name: "Acme", timezone: "America/Sao_Paulo", defaultCredentialId: f.credential.id });
    // The new context reaches the next prompt.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev hi" });
    await drainOutbox(f.db, f.handlers);
    expect(JSON.stringify(f.provider.calls[0]?.request.system)).toContain("We deploy on Fridays never.");
  });
});

describe("invitations", () => {
  test("invite many, resend (old link dies), accept only by the invited email; statuses", async () => {
    f = await setup();
    const existing = await addMember(f.db, f.org.id, "member", "bia");
    const results = await inviteMany(f.db, f.owner.id, f.org.id, {
      emails: ["joao@example.com", "JOAO@example.com", "not-an-email", existing.email, "rita@example.com"],
      role: "member",
    });
    expect(results.map((r) => [r.email, r.status])).toEqual([
      ["joao@example.com", "invited"],
      ["not-an-email", "invalid_email"],
      [existing.email, "already_member"],
      ["rita@example.com", "invited"],
    ]);
    const again = await inviteMany(f.db, f.owner.id, f.org.id, { emails: ["joao@example.com"], role: "member" });
    expect(again[0]?.status).toBe("already_invited");
    const joaoInvite = results[0];
    if (joaoInvite?.status !== "invited") throw new Error("expected invite");

    const { token } = await resendInvitation(f.db, f.owner.id, f.org.id, joaoInvite.invitationId);
    const joao = await addUser(f.db, "joao");
    await expect(acceptInvitation(f.db, { id: joao.id, email: "joao@example.com" }, joaoInvite.token)).rejects.toThrow(
      "invalid or has expired",
    );
    await expect(acceptInvitation(f.db, { id: joao.id, email: "other@example.com" }, token)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await acceptInvitation(f.db, { id: joao.id, email: "joao@example.com" }, token);

    const later = new Date(Date.now() + 8 * 86_400_000);
    const statuses = await listInvitationsWithStatus(f.db, f.owner.id, f.org.id, later);
    expect(statuses.map((s) => [s.email, s.status])).toEqual([["rita@example.com", "expired"]]);
    const member = await addMember(f.db, f.org.id, "member");
    await expect(
      inviteMany(f.db, member.id, f.org.id, { emails: ["x@example.com"], role: "member" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("credentials", () => {
  test("rotate keeps the id (the agent uses the new key); purge is refused while in use", async () => {
    f = await setup();
    await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, f.credential.id, {
      apiKey: "sk-ant-rotated-9999",
    });
    await f.gateway.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      onDelta: () => {},
    });
    expect(f.provider.calls[0]?.apiKey).toBe("sk-ant-rotated-9999");
    await expect(deleteCredential(f.db, f.owner.id, f.org.id, f.credential.id)).rejects.toBeInstanceOf(ConflictError);
    await f.db.update(schema.agents).set({ credentialId: null });
    await deleteCredential(f.db, f.owner.id, f.org.id, f.credential.id);
    expect(await f.db.select().from(schema.providerCredentials)).toEqual([]);
  });
});

describe("agents, runs and usage", () => {
  test("agent detail, channels, run history with cost, usage by kind, overview", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev please check the deploy",
    });
    await drainOutbox(f.db, f.handlers);
    const cost = 1000 * 2000 + 100 * 10000;

    const detail = await agentDetail(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(detail.month).toMatchObject({
      spentNanoUsd: cost,
      runs: 1,
      tokens: 1100,
      // No budget of its own: the workspace default counts.
      budgetNanoUsd: DEFAULT_AGENT_BUDGET_NANO_USD,
      budgetUsedPercent: budgetPercent(cost, DEFAULT_AGENT_BUDGET_NANO_USD),
    });
    expect(detail.channels.map((c) => c.name)).toEqual(["general"]);

    const [run] = await listRuns(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect(run).toMatchObject({
      status: "done",
      what: "@dev please check the deploy",
      costNanoUsd: cost,
      inputTokens: 1000,
      outputTokens: 100,
      turns: 1,
    });

    const report = await usageReport(f.db, f.owner.id, f.org.id);
    expect(report.byKind).toEqual([
      { kind: "agent", calls: 1, partialCalls: 0, inputTokens: 1000, outputTokens: 100, costNanoUsd: cost },
    ]);
    expect(report.agents.find((a) => a.handle === "dev")?.costNanoUsd).toBe(cost);

    const overview = await orgOverview(f.db, f.owner.id, f.org.id);
    expect(overview).toMatchObject({
      people: 1,
      agents: 1,
      budgetUsedPercent: budgetPercent(cost, DEFAULT_AGENT_BUDGET_NANO_USD),
      approvalsWaitingForMe: 0,
    });
    expect(overview).not.toHaveProperty("myAgentsSpendNanoUsd");

    // Owners of an agent see its runs; other members don't.
    const member = await addMember(f.db, f.org.id, "member");
    await expect(listRuns(f.db, member.id, f.org.id, { agentId: f.agent.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(usageReport(f.db, member.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);

    const eng = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "eng", createdByUserId: f.owner.id })
      .returning();
    const channels = await setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, [
      { channelId: eng[0]?.id ?? "", autoReply: false },
    ]);
    expect(channels).toEqual([{ id: eng[0]?.id ?? "", name: "eng", autoReply: false }]);
    await expect(
      setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, [{ channelId: crypto.randomUUID() }]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("channel updates: creator or admin, unique names, #general keeps its name", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(updateChannel(f.db, member.id, f.org.id, f.general.id, { topic: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(updateChannel(f.db, f.owner.id, f.org.id, f.general.id, { name: "main" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const updated = await updateChannel(f.db, f.owner.id, f.org.id, f.general.id, {
      topic: "Everything",
      visibility: "public",
    });
    expect(updated.topic).toBe("Everything");
  });

  test("the owner is told when an agent crosses 80% and 100% of its budget", async () => {
    f = await setup({
      budgetNanoUsd: 100_000_000,
      reply: () => ({ chunks: ["x"], usage: { inputTokens: 21_000, outputTokens: 0 } }),
    });
    const events: { level: string; spent: number }[] = [];
    const gateway = createModelGateway({
      db: f.db,
      keyWrappers: [f.keyWrapper],
      providers: { anthropic: f.provider },
      platformCredentials: noPlatformCredentials,
      onBudgetThreshold: ({ level, spentNanoUsd }) => {
        events.push({ level, spent: spentNanoUsd });
      },
    });
    const call = () =>
      gateway.stream({
        orgId: f.org.id,
        agentId: f.agent.id,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 300,
        onDelta: () => {},
      });
    for (let i = 0; i < 2; i++) await call(); // 84M of 100M
    expect(events).toEqual([{ level: "warning", spent: 84_000_000 }]);
    await call(); // 126M: over
    expect(events.at(-1)).toEqual({ level: "exhausted", spent: 126_000_000 });
  });
});
