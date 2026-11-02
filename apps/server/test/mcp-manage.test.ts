import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  APP_MANAGE_TOOL_NAMES,
  APP_TOOL_NAMES,
  appAccessOf,
  appScopesFor,
  parseScopes,
  reachableFromInternet,
} from "@agenteschat/engine";
import { callTool, connectApp, mcp } from "./ai-apps";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

const MANAGE = { access: "manage" as const, scope: "read write manage", name: "Claude" };

async function setup() {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const ownerId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  return { b, ownerId, ...seeded };
}

const toolNames = async (bearer: string) =>
  (
    (await (await mcp(t, bearer, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
      result: { tools: { name: string }[] };
    }
  ).result.tools.map((x) => x.name);

const data = (r: Awaited<ReturnType<typeof callTool>>) => r.structuredContent as Record<string, unknown>;

const appCreated = (orgId: string, userId: string) =>
  t.db
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.orgId, orgId),
        eq(schema.notifications.userId, userId),
        eq(schema.notifications.kind, "app_created"),
      ),
    );

describe("scopes", () => {
  test("access levels: each brings the ones before it; none asked is all", () => {
    expect(appScopesFor("read")).toEqual(["read"]);
    expect(appScopesFor("manage")).toEqual(["read", "write", "manage"]);
    expect(appAccessOf(["read", "write"])).toBe("write");
    expect(parseScopes("")).toEqual(["read", "write", "manage"]);
    expect(parseScopes("read write offline_access")).toEqual(["read", "write"]);
    expect(parseScopes("manage")).toEqual(["read", "write", "manage"]);
  });

  test("the manage tools only for a connection given manage", async () => {
    const { b, orgId } = await setup();
    const write = await connectApp(t, b, orgId, { name: "Writer", scope: "read write manage", access: "write" });
    expect(await toolNames(write.access)).toEqual([...APP_TOOL_NAMES]);
    const refused = (await (
      await mcp(t, write.access, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "create_agent", arguments: { name: "Ghost" } },
      })
    ).json()) as { error?: { message: string } };
    expect(refused.error?.message).toBe("Tool create_agent not found");
    const asked = await connectApp(t, b, orgId, { name: "Asker", access: "manage" });
    expect(await toolNames(asked.access)).toEqual([...APP_TOOL_NAMES]);
    const manage = await connectApp(t, b, orgId, MANAGE);
    expect(await toolNames(manage.access)).toEqual([...APP_TOOL_NAMES, ...APP_MANAGE_TOOL_NAMES]);
    const [grant] = await t.db.select().from(schema.appGrants).where(eq(schema.appGrants.displayName, "Claude"));
    expect(grant?.scopes).toEqual(["read", "write", "manage"]);
  });

  test("Settings shows manage access, and whether apps on the internet can reach the server", async () => {
    const { b, orgId } = await setup();
    await connectApp(t, b, orgId, MANAGE);
    const list = (await (await b(`/api/app/organizations/${orgId}/apps`)).json()) as {
      serverPublic: boolean;
      apps: { access: string }[];
    };
    expect(list.apps[0]?.access).toBe("manage");
    // The test server is http://localhost:3000.
    expect(list.serverPublic).toBe(false);
    expect(reachableFromInternet("https://app.agentes.chat")).toBe(true);
    expect(reachableFromInternet("http://app.agentes.chat")).toBe(false);
    expect(reachableFromInternet("https://agentes.lan")).toBe(false);
    expect(reachableFromInternet("https://192.168.1.20")).toBe(false);
  });
});

describe("create_agent", () => {
  test("as the person, audited with the app, told in their inbox; same name or key again: the same agent", async () => {
    const { b, orgId, ownerId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const made = data(
      await callTool(t, app.access, "create_agent", {
        name: "Escritora",
        role: "Writes the newsletter",
        instructions: "Write in a warm tone.",
        avatar_color: "rose",
        idempotency_key: "agent-1",
      }),
    );
    expect(made).toMatchObject({ name: "Escritora", handle: "escritora", existing: false });
    const [agent] = await t.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, String(made.id)));
    expect(agent?.ownerUserId).toBe(ownerId);
    expect(agent?.instructions).toBe("Write in a warm tone.");
    expect(agent?.appearance?.color).toBe("rose");
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, "apps.created")));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(ownerId);
    expect(audit[0]?.details).toMatchObject({ client: "Claude", key: "agent-1", name: "Escritora" });

    const retry = data(
      await callTool(t, app.access, "create_agent", { name: "Escritora 2", idempotency_key: "agent-1" }),
    );
    expect(retry).toMatchObject({ id: made.id, existing: true });
    const again = data(await callTool(t, app.access, "create_agent", { name: " escritora " }));
    expect(again).toMatchObject({ id: made.id, existing: true });
    const all = await t.db.select().from(schema.agents).where(eq(schema.agents.orgId, orgId));
    expect(all.filter((a) => a.name.toLowerCase().startsWith("escritora"))).toHaveLength(1);

    const [notice] = await appCreated(orgId, ownerId);
    expect(notice?.latest).toEqual({ title: "Claude", created: { agent: 1 } });
    expect(notice?.source).toEqual({ agentId: made.id });
  });

  test("a taken handle gets the next free one", async () => {
    const { b, orgId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const made = data(await callTool(t, app.access, "create_agent", { name: "Builder", handle: "dev" }));
    expect(made.handle).toBe("dev-2");
  });

  test("a member without create_agents can't create one", async () => {
    const { b, orgId } = await setup();
    const member = await joinByInvitation(t, b, orgId, "member@example.com");
    const app = await connectApp(t, member, orgId, MANAGE);
    const res = await callTool(t, app.access, "create_agent", { name: "Sneaky" });
    expect(res.isError).toBe(true);
    const rows = await t.db.select().from(schema.agents).where(eq(schema.agents.name, "Sneaky"));
    expect(rows).toHaveLength(0);
  });
});

describe("update_agent_instructions", () => {
  test("an admin replaces them; a member can't", async () => {
    const { b, orgId, agentId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const res = data(
      await callTool(t, app.access, "update_agent_instructions", { agent: "@dev", instructions: "Ship small PRs." }),
    );
    expect(res.id).toBe(agentId);
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(agent?.instructions).toBe("Ship small PRs.");
    const [audit] = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "apps.updated"));
    expect(audit?.details).toMatchObject({ client: "Claude", changed: ["instructions"] });

    const member = await joinByInvitation(t, b, orgId, "member@example.com");
    const memberApp = await connectApp(t, member, orgId, MANAGE);
    const refused = await callTool(t, memberApp.access, "update_agent_instructions", {
      agent: "dev",
      instructions: "Delete everything.",
    });
    expect(refused.isError).toBe(true);
    const [after] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    expect(after?.instructions).toBe("Ship small PRs.");
  });
});

describe("skills", () => {
  test("create_skill from a SKILL.md or plain Markdown, turned on for an agent; list_skills lists them", async () => {
    const { b, orgId, agentId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const made = data(
      await callTool(t, app.access, "create_skill", {
        markdown: "---\nname: release-notes\ndescription: Writes release notes\n---\n# Steps\nRead the merged PRs.",
        agent: "dev",
        idempotency_key: "skill-1",
      }),
    );
    expect(made).toMatchObject({ name: "release-notes", existing: false, agent: { id: agentId } });
    const plain = data(
      await callTool(t, app.access, "create_skill", {
        markdown: "Answer support tickets kindly.",
        name: "support-replies",
        description: "Replies to support tickets",
      }),
    );
    expect(plain.existing).toBe(false);
    const same = data(
      await callTool(t, app.access, "create_skill", {
        markdown: "---\nname: release-notes\ndescription: Other text\n---\nOther body.",
      }),
    );
    expect(same).toMatchObject({ id: made.id, existing: true });
    const [skill] = await t.db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, String(made.id)));
    expect(skill?.body).toBe("# Steps\nRead the merged PRs.");
    const on = await t.db
      .select()
      .from(schema.agentSkills)
      .where(eq(schema.agentSkills.skillId, String(made.id)));
    expect(on.map((r) => r.agentId)).toEqual([agentId]);
    const listed = data(await callTool(t, app.access, "list_skills", {})).skills as { name: string }[];
    expect(listed.map((s) => s.name).sort()).toEqual(["release-notes", "support-replies"]);
    const bad = await callTool(t, app.access, "create_skill", { markdown: "No name here." });
    expect(bad.isError).toBe(true);
  });

  test("a member without manage_agents can't install one", async () => {
    const { b, orgId } = await setup();
    const member = await joinByInvitation(t, b, orgId, "member@example.com");
    const app = await connectApp(t, member, orgId, MANAGE);
    const res = await callTool(t, app.access, "create_skill", {
      markdown: "---\nname: sneaky\ndescription: No\n---\nBody",
    });
    expect(res.isError).toBe(true);
  });
});

describe("create_routine", () => {
  test("on a schedule phrase, posting in the person's conversation with the agent; merged into one notice", async () => {
    const { b, orgId, ownerId, agentId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    await callTool(t, app.access, "create_agent", { name: "Writer" });
    const made = data(
      await callTool(t, app.access, "create_routine", {
        agent: "dev",
        instructions: "Summarize yesterday's merged PRs.",
        schedule: "dias úteis às 9h",
        name: "Daily PRs",
        idempotency_key: "routine-1",
      }),
    );
    expect(made).toMatchObject({ name: "Daily PRs", existing: false, posts_in: "direct_conversation" });
    const [routine] = await t.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, String(made.id)));
    expect(routine?.agentId).toBe(agentId);
    expect(routine?.createdByUserId).toBe(ownerId);
    expect(routine?.target).toEqual({ type: "dm" });
    const again = data(
      await callTool(t, app.access, "create_routine", {
        agent: "dev",
        instructions: "Other words.",
        schedule: "dias úteis às 9h",
        name: "daily prs",
      }),
    );
    expect(again).toMatchObject({ id: made.id, existing: true });
    const notices = await appCreated(orgId, ownerId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.count).toBe(2);
    expect(notices[0]?.latest).toEqual({ title: "Claude", created: { agent: 1, routine: 1 } });
  });

  test("a schedule it can't read is an error the app can act on", async () => {
    const { b, orgId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const res = await callTool(t, app.access, "create_routine", {
      agent: "dev",
      instructions: "Something.",
      schedule: "whenever the moon is full",
    });
    expect(res.isError).toBe(true);
    expect(await t.db.select().from(schema.routines)).toHaveLength(0);
  });
});

describe("add_memory and create_channel", () => {
  test("a memory said by the person; the key answers once", async () => {
    const { b, orgId, ownerId, agentId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const args = { agent: "dev", text: "The team ships on Thursdays.", idempotency_key: "m-1" };
    const made = data(await callTool(t, app.access, "add_memory", args));
    expect(made.existing).toBe(false);
    expect(data(await callTool(t, app.access, "add_memory", args))).toMatchObject({ id: made.id, existing: true });
    const items = await t.db.select().from(schema.contextItems).where(eq(schema.contextItems.agentId, agentId));
    const mine = items.filter((i) => i.content === "The team ships on Thursdays.");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "fact", createdByKind: "person", createdById: ownerId, trust: "high" });
  });

  test("a member can't write the memory of an agent they don't own", async () => {
    const { b, orgId } = await setup();
    const member = await joinByInvitation(t, b, orgId, "member@example.com");
    const app = await connectApp(t, member, orgId, MANAGE);
    expect((await callTool(t, app.access, "add_memory", { agent: "dev", text: "Nope." })).isError).toBe(true);
  });

  test("create_channel makes one with the person in it; the same name is the same channel", async () => {
    const { b, orgId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    const made = data(await callTool(t, app.access, "create_channel", { name: "Launch Plans", topic: "Q4" }));
    expect(made).toMatchObject({ name: "launch-plans", existing: false });
    expect(data(await callTool(t, app.access, "create_channel", { name: "launch-plans" }))).toMatchObject({
      id: made.id,
      existing: true,
    });
    const general = data(await callTool(t, app.access, "create_channel", { name: "general" }));
    expect(general.existing).toBe(true);
  });
});

describe("import_summary", () => {
  test("what exists, by name", async () => {
    const { b, orgId } = await setup();
    const app = await connectApp(t, b, orgId, MANAGE);
    await callTool(t, app.access, "create_skill", {
      markdown: "---\nname: triage\ndescription: Sorts bugs\n---\nBody",
    });
    const summary = data(await callTool(t, app.access, "import_summary", {}));
    expect((summary.agents as { handle: string }[]).map((a) => a.handle)).toEqual(["dev"]);
    expect((summary.skills as { name: string }[]).map((s) => s.name)).toEqual(["triage"]);
    expect((summary.channels as { name: string }[]).map((c) => c.name)).toContain("general");
    expect(summary.routines).toEqual([]);
  });
});
