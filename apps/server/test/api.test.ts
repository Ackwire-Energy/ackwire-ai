import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

describe("sign-up policy (self-host)", () => {
  test("first account signs up; then sign-up closes", async () => {
    const anon = browser(t);
    expect(await (await anon("/api/app/auth-config")).json()).toMatchObject({ signupOpen: true, firstRun: true });
    await signUp(browser(t), "owner@example.com");
    expect(await (await anon("/api/app/auth-config")).json()).toMatchObject({ signupOpen: false, firstRun: false });
    const res = await browser(t)("/api/auth/sign-up/email", {
      json: { email: "stranger@example.com", password: "correct horse battery", name: "s" },
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("Sign-up is closed");
  });

  test("auth-config: no legal links or support address unless configured; password reset when email goes out", async () => {
    // The test server's fake email sender delivers; people connect their own computers.
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      termsUrl: null,
      privacyUrl: null,
      supportEmail: null,
      passwordReset: true,
      workspaceComputer: false,
    });
    await t.close();
    t = await createTestServer({
      env: {
        TERMS_URL: "https://example.com/terms",
        PRIVACY_URL: "https://example.com/privacy",
        SUPPORT_EMAIL: "help@example.com",
        MACHINE_PROVISIONING: "external",
        OPERATOR_API_TOKEN: "o".repeat(40),
      },
    });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      termsUrl: "https://example.com/terms",
      privacyUrl: "https://example.com/privacy",
      supportEmail: "help@example.com",
      workspaceComputer: true,
    });
  });

  test("ALLOW_SIGNUP=true keeps it open", async () => {
    await t.close();
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    await signUp(browser(t), "a@example.com");
    await signUp(browser(t), "b@example.com");
  });

  test("an invited email can sign up and join", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const { url } = (await (
      await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
    ).json()) as { url: string };
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const token = url.split("/invite/")[1];
    expect((await ana(`/api/app/invitations/${token}/accept`, { json: {} })).status).toBe(200);
    const me = (await (await ana("/api/app/me")).json()) as { organizations: { id: string; role: string }[] };
    expect(me.organizations).toEqual([
      {
        id: orgId,
        name: "Acme",
        role: "member",
        permissions: expect.arrayContaining(["read", "post", "talk_to_agents"]),
        rank: null,
        logo: null,
        standing: { state: "active", reason: null },
      },
    ] as never);
  });
});

describe("app API protections", () => {
  test("requires a session", async () => {
    expect((await browser(t)("/api/app/me")).status).toBe(401);
  });

  test("CSRF: writes need our Origin and JSON", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    expect(
      (await owner("/api/app/organizations", { json: { name: "X" }, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await owner("/api/app/organizations", { json: { name: "X" }, origin: null })).status).toBe(403);
    const form = await t.app.request("/api/app/organizations", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        cookie: owner.cookie(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "name=X",
    });
    expect(form.status).toBe(415);
  });

  test("validation errors use the error shape, a sentence per field", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const res = await owner("/api/app/organizations", { json: { name: "", teamSize: "huge" } });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("invalid_request");
    expect(error.message).toMatch(/^name: [^;]+\. teamSize: [^;]+$/);
  });
});

describe("organizations, agents and credentials", () => {
  test("credentials are never returned, not even to owners", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const list = await (await owner(`/api/app/organizations/${orgId}/credentials`)).text();
    expect(list).toContain("9876");
    expect(list).not.toContain("sk-ant-api-secret");
    const agents = await (await owner(`/api/app/organizations/${orgId}/agents`)).json();
    expect(agents).toMatchObject({
      agents: [{ handle: "dev", model: "claude-sonnet-5-5", hasCredential: true, monthlyBudgetUsd: 50 }],
    });
    const rows = await t.db.select().from(schema.providerCredentials);
    expect(JSON.stringify(rows)).not.toContain("sk-ant-api-secret");
  });

  test("members can chat but can't manage agents or credentials", async () => {
    await t.close();
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const { url } = (await (
      await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
    ).json()) as { url: string };
    await ana(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
    expect((await ana(`/api/app/organizations/${orgId}/agents`, { json: { name: "X", handle: "xx" } })).status).toBe(
      403,
    );
    expect((await ana(`/api/app/organizations/${orgId}/credentials`)).status).toBe(403);
    expect((await ana(`/api/app/organizations/${orgId}/usage`)).status).toBe(403);
    expect((await ana(`/api/app/organizations/${orgId}/agents`)).status).toBe(200);
  });

  test("who coordinates the team (ADR 0092): on every agent listed, moved by an admin's PATCH, never by an agent's owner", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId, agentId: devId } = await seedOrg(owner);
    const api = (path: string, init?: Parameters<typeof owner>[1]) =>
      owner(`/api/app/organizations/${orgId}${path}`, init);
    const coordinators = async () => {
      const { agents } = (await (await api("/agents")).json()) as {
        agents: { handle: string; coordinator: boolean }[];
      };
      return Object.fromEntries(agents.map((a) => [a.handle, a.coordinator]));
    };
    const ops = (await (await api("/agents", { json: { name: "Ops", handle: "ops" } })).json()) as { id: string };
    // The workspace's first agent coordinates it.
    expect(await coordinators()).toEqual({ dev: true, ops: false });
    const moved = await api(`/agents/${ops.id}`, { method: "PATCH", json: { coordinator: true } });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ id: ops.id, coordinator: true });
    expect(await coordinators()).toEqual({ dev: false, ops: true });

    // Bia owns Ops: she changes its look, not who coordinates.
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
    const [biaUser] = await t.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "bia@example.com"));
    expect((await api(`/agents/${ops.id}`, { method: "PATCH", json: { ownerUserId: biaUser?.id } })).status).toBe(200);
    const asBia = (path: string, json: Record<string, unknown>) =>
      bia(`/api/app/organizations/${orgId}${path}`, { method: "PATCH", json });
    const look = { color: "violet", eyes: "sleepy", accessory: "crown" };
    expect((await asBia(`/agents/${ops.id}`, { appearance: look })).status).toBe(200);
    expect((await asBia(`/agents/${ops.id}`, { coordinator: false })).status).toBe(403);
    expect((await asBia(`/agents/${devId}`, { coordinator: true })).status).toBe(403);
    expect(await coordinators()).toEqual({ dev: false, ops: true });
  });

  test("unknown models are rejected", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const res = await owner(`/api/app/organizations/${orgId}/agents`, {
      json: { name: "X", handle: "xx", model: "gpt-5" },
    });
    expect(res.status).toBe(400);
  });
});

describe("chat over HTTP", () => {
  test("post a mention, workers run the agent, the reply appears in the channel, usage is billed", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId, channelId, agentId } = await seedOrg(owner);
    const posted = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
      json: { body: "@dev status?" },
    });
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as { id: string; mentionedAgentIds: string[] };
    expect(message.mentionedAgentIds).toEqual([agentId]);

    await t.drain();
    // Asked in the channel, answered in the channel.
    const timeline = (await (await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`)).json()) as {
      messages: { author: { type: string }; body: string; threadId: string | null }[];
    };
    expect(timeline.messages.map((m) => [m.author.type, m.body, m.threadId])).toEqual([
      ["person", "@dev status?", null],
      ["agent", "Echo: [owner]: @dev status?.", null],
    ]);
    expect(t.provider.calls[0]?.apiKey).toBe("sk-ant-api-secret-9876");
    // Per-agent cost is an admin endpoint (the owner here); members get 403 (see above).
    const usage = (await (await owner(`/api/app/organizations/${orgId}/usage`)).json()) as {
      usage: { calls: number; costUsd: number }[];
    };
    expect(usage.usage[0]?.calls).toBe(1);
    expect(usage.usage[0]?.costUsd).toBeGreaterThan(0);
  });

  test("a channel created with a category is placed in it", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const org = `/api/app/organizations/${orgId}`;
    const category = (await (await owner(`${org}/channel-categories`, { json: { name: "Produto" } })).json()) as {
      id: string;
    };
    const res = await owner(`${org}/channels`, { json: { name: "roadmap", categoryId: category.id } });
    expect(res.status).toBe(201);
    const channel = (await res.json()) as { id: string; categoryId: string | null };
    expect(channel.categoryId).toBe(category.id);
    const list = (await (await owner(`${org}/channels`)).json()) as {
      channels: { id: string; categoryId: string | null }[];
    };
    expect(list.channels.filter((c) => c.categoryId === category.id).map((c) => c.id)).toEqual([channel.id]);
  });

  test("organizations are isolated: another org's owner can't read or post", async () => {
    await t.close();
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const a = browser(t);
    await signUp(a, "a@example.com");
    const { orgId, channelId } = await seedOrg(a);
    const b = browser(t);
    await signUp(b, "b@example.com");
    const other = (await (await b("/api/app/organizations", { json: { name: "Other" } })).json()) as {
      organization: { id: string };
    };

    expect((await b(`/api/app/organizations/${orgId}/channels/${channelId}/messages`)).status).toBe(403);
    expect(
      (await b(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "hi" } })).status,
    ).toBe(403);
    // Using their own org id with A's channel id doesn't help either.
    expect((await b(`/api/app/organizations/${other.organization.id}/channels/${channelId}/messages`)).status).toBe(
      404,
    );
  });
});
