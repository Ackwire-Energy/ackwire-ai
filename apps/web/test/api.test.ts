import { describe, expect, test } from "bun:test";
import { createApiClient } from "@/api";
import { ApiError, createRequester } from "@/api/http";
import { createHttpApi } from "@/api/http-client";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${url}`;
    const r = responses[key] ??
      responses[url] ?? { status: 404, body: { error: { code: "not_found", message: "Route not found" } } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

describe("requester", () => {
  test("GET has no body nor content-type; writes are JSON (CSRF rule)", async () => {
    const { fetch, calls } = fakeFetch({
      "/a": { status: 200, body: { ok: 1 } },
      "POST /b": { status: 201, body: {} },
    });
    const request = createRequester(fetch);
    expect(await request("/a")).toEqual({ ok: 1 });
    await request("/b", { json: { x: 1 } });
    const [get, post] = calls as [Call, Call];
    expect(get?.init.method).toBe("GET");
    expect((get.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(get?.init.body).toBeUndefined();
    expect(get?.init.credentials).toBe("same-origin");
    expect(post?.init.method).toBe("POST");
    expect((post.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(post?.init.body).toBe('{"x":1}');
  });

  test("errors become ApiError with the server's code and message; 204 is undefined", async () => {
    const { fetch } = fakeFetch({
      "POST /bad": { status: 409, body: { error: { code: "conflict", message: "@ada is already taken" } } },
      "DELETE /gone": { status: 204 },
    });
    const request = createRequester(fetch);
    const error = await request("/bad", { json: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "conflict", message: "@ada is already taken" });
    expect(await request("/gone", { method: "DELETE" })).toBeUndefined();
  });

  test("query strings skip empty values", async () => {
    const { fetch, calls } = fakeFetch({});
    const request = createRequester(fetch);
    await request("/x", { query: { a: 1, b: undefined, c: null, d: "z" } }).catch(() => {});
    expect(calls[0]?.url).toBe("/x?a=1&d=z");
  });
});

describe("HTTP client (real endpoints)", () => {
  const org = "/api/app/organizations/o1";
  test("me is null when signed out; usage null without permission; preview null when expired", async () => {
    const { fetch } = fakeFetch({
      "/api/app/me": { status: 401, body: { error: { code: "unauthorized", message: "Sign in" } } },
      [`${org}/usage`]: { status: 403, body: { error: { code: "forbidden", message: "no" } } },
      "/api/app/invitations/t1": { status: 404, body: { error: { code: "not_found", message: "expired" } } },
    });
    const api = createHttpApi(fetch);
    expect(await api.account.me()).toBeNull();
    expect(await api.agents.usage("o1")).toBeNull();
    expect(await api.orgs.previewInvitation("t1")).toBeNull();
  });

  test("unwraps list envelopes and builds the documented paths", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/channels`]: { status: 200, body: { channels: [{ id: "c1" }] } },
      [`${org}/channels/c1/messages?threadId=m1&limit=200`]: { status: 200, body: { messages: [{ id: "m1" }] } },
      [`POST ${org}/channels/c1/messages`]: { status: 201, body: { id: "m2" } },
      [`PATCH ${org}/agents/a1`]: { status: 200, body: { id: "a1" } },
      "POST /api/app/invitations/tok/accept": { status: 200, body: { orgId: "o1" } },
    });
    const api = createHttpApi(fetch);
    expect(await api.chat.channels("o1")).toEqual([{ id: "c1" }] as never);
    expect(await api.chat.messages("o1", "c1", { threadId: "m1", limit: 200 })).toEqual([{ id: "m1" }] as never);
    await api.chat.post("o1", "c1", { body: "oi" });
    await api.agents.update("o1", "a1", { monthlyBudgetUsd: 40 });
    await api.orgs.acceptInvitation("tok");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${org}/channels`,
      `GET ${org}/channels/c1/messages?threadId=m1&limit=200`,
      `POST ${org}/channels/c1/messages`,
      `PATCH ${org}/agents/a1`,
      "POST /api/app/invitations/tok/accept",
    ]);
    expect(calls[2]?.init.body).toBe('{"body":"oi"}');
  });

  test("the composed client never sends provider keys anywhere but the credentials endpoint", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${org}/credentials`]: { status: 201, body: { id: "k", keyHint: "7f2a" } },
    });
    const api = createApiClient({ fetch });
    const cred = await api.agents.addCredential("o1", { provider: "anthropic", label: "x", apiKey: "sk-ant-secret" });
    expect(cred).toEqual({ id: "k", keyHint: "7f2a" } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${org}/credentials`);
  });
});

describe("HTTP client: approvals, connectors, scopes (phases 2 and 3)", () => {
  const org = "/api/app/organizations/o1";
  test("approvals: list with filters, approve and refuse with a reason", async () => {
    const approval = { id: "a1", status: "pending", canDecide: true };
    const { fetch, calls } = fakeFetch({
      [`${org}/approvals?status=pending&agentId=ag`]: { status: 200, body: { approvals: [approval] } },
      [`POST ${org}/approvals/a1/approve`]: { status: 200, body: { ...approval, status: "approved" } },
      [`POST ${org}/approvals/a1/refuse`]: {
        status: 409,
        body: { error: { code: "conflict", message: "Already decided" } },
      },
    });
    const api = createHttpApi(fetch);
    expect(await api.approvals.list("o1", { status: "pending", agentId: "ag" })).toEqual([approval] as never);
    expect((await api.approvals.approve("o1", "a1")).status).toBe("approved");
    const refused = await api.approvals.refuse("o1", "a1", "Precisa de revisão").catch((e) => e);
    expect(refused).toMatchObject({ status: 409, code: "conflict" });
    expect(calls[1]?.init.body).toBe("{}");
    expect(calls[2]?.init.body).toBe('{"reason":"Precisa de revisão"}');
  });

  test("connectors: catalog, connections, API key, OAuth start, disconnect", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/app/connectors/catalog": { status: 200, body: { connectors: [{ id: "github" }], builtinScopes: [] } },
      [`${org}/connectors`]: { status: 200, body: { connections: [{ id: "c1" }] } },
      [`POST ${org}/connectors`]: { status: 201, body: { id: "c2" } },
      [`POST ${org}/connectors/github/oauth/start`]: { status: 200, body: { authorizeUrl: "https://gh/authorize" } },
      [`DELETE ${org}/connectors/c1`]: { status: 204 },
    });
    const api = createHttpApi(fetch);
    expect((await api.connectors.catalog()).connectors).toEqual([{ id: "github" }] as never);
    expect(await api.connectors.list("o1")).toEqual([{ id: "c1" }] as never);
    await api.connectors.connectWithKey("o1", { connector: "sentry", apiKey: "sntrys_123456" });
    expect(await api.connectors.startOAuth("o1", "github", { returnTo: "/org/o1/settings" })).toBe(
      "https://gh/authorize",
    );
    await api.connectors.disconnect("o1", "c1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/app/connectors/catalog",
      `GET ${org}/connectors`,
      `POST ${org}/connectors`,
      `POST ${org}/connectors/github/oauth/start`,
      `DELETE ${org}/connectors/c1`,
    ]);
    expect(calls[3]?.init.body).toBe('{"returnTo":"/org/o1/settings"}');
  });

  test("agent scopes: GET and PUT { scopes }", async () => {
    const grants = [{ connectionId: null, scope: "context:read" }];
    const { fetch, calls } = fakeFetch({
      [`${org}/agents/a1/scopes`]: { status: 200, body: { scopes: grants } },
      [`PUT ${org}/agents/a1/scopes`]: { status: 200, body: { scopes: grants } },
    });
    const api = createHttpApi(fetch);
    expect(await api.scopes.get("o1", "a1")).toEqual(grants);
    expect(await api.scopes.set("o1", "a1", grants)).toEqual(grants);
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ scopes: grants }));
  });
});

describe("HTTP client: management (phase 4)", () => {
  const org = "/api/app/organizations/o1";
  test("settings, overview, people, invitations, usage report", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/settings`]: { status: 200, body: { name: "Acme", context: "" } },
      [`PATCH ${org}/settings`]: { status: 200, body: { name: "Acme", context: "novo" } },
      [`${org}/overview`]: { status: 200, body: { people: 7, agents: 4 } },
      [`${org}/people`]: { status: 200, body: { people: [{ userId: "u", online: true }] } },
      [`${org}/invitations/all`]: { status: 200, body: { invitations: [{ id: "i", status: "expired" }] } },
      [`POST ${org}/invitations/batch`]: { status: 200, body: { results: [{ email: "a@x.com", status: "invited" }] } },
      [`POST ${org}/invitations/i/resend`]: { status: 200, body: { url: "u", expiresAt: "e" } },
      [`${org}/usage/report`]: { status: 200, body: { totalUsd: 1 } },
    });
    const api = createHttpApi(fetch);
    await api.orgs.settings("o1");
    expect((await api.orgs.updateSettings("o1", { context: "novo" })).context).toBe("novo");
    expect((await api.orgs.overview("o1")).people).toBe(7);
    expect((await api.orgs.people("o1"))[0]?.online).toBe(true);
    expect((await api.orgs.allInvitations("o1"))[0]?.status).toBe("expired");
    expect(await api.orgs.inviteMany("o1", { emails: ["a@x.com"], role: "member" })).toEqual([
      { email: "a@x.com", status: "invited" },
    ]);
    expect((await api.orgs.resendInvitation("o1", "i")).url).toBe("u");
    expect((await api.orgs.usageReport("o1")).totalUsd).toBe(1);
    expect(calls[5]?.init.body).toBe('{"emails":["a@x.com"],"role":"member"}');
  });

  test("credentials rotate/purge/platform, agent detail, channels, runs, roster, channel update", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${org}/credentials/k/rotate`]: { status: 200, body: { id: "k", keyHint: "9999" } },
      [`DELETE ${org}/credentials/k?purge=true`]: { status: 204 },
      [`${org}/credentials/platform`]: { status: 200, body: { available: false } },
      [`${org}/agents/a1`]: { status: 200, body: { id: "a1", spentThisMonthUsd: 12.3 } },
      [`PUT ${org}/agents/a1/channels`]: {
        status: 200,
        body: { channels: [{ id: "c1", name: "eng", autoReply: false }] },
      },
      [`${org}/runs?agentId=a1&limit=200`]: { status: 200, body: { runs: [{ id: "r1" }] } },
      [`${org}/runs/r1`]: { status: 200, body: { run: { id: "r1" }, steps: [] } },
      [`${org}/channels/c1/roster`]: { status: 200, body: { members: [{ type: "agent", id: "a1", autoReply: true }] } },
      [`PATCH ${org}/channels/c1`]: { status: 200, body: { id: "c1", topic: "novo" } },
    });
    const api = createHttpApi(fetch);
    expect((await api.agents.rotateCredential("o1", "k", { apiKey: "sk-ant-9999" })).keyHint).toBe("9999");
    await api.agents.removeCredential("o1", "k", true);
    expect(await api.agents.platformKeyAvailable("o1")).toBe(false);
    expect((await api.agents.detail("o1", "a1")).spentThisMonthUsd).toBe(12.3);
    expect(await api.agents.setChannels("o1", "a1", [{ channelId: "c1" }])).toHaveLength(1);
    expect(await api.agents.runs("o1", { agentId: "a1", limit: 200 })).toEqual([{ id: "r1" }] as never);
    expect((await api.agents.run("o1", "r1")).steps).toEqual([]);
    expect((await api.chat.roster("o1", "c1"))[0]?.autoReply).toBe(true);
    expect((await api.chat.update("o1", "c1", { topic: "novo" })).topic).toBe("novo");
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[4]?.init.body).toBe('{"channels":[{"channelId":"c1"}]}');
  });
});

describe("HTTP client: drive, storage, issues, routines, calendar, custom MCP, invites (no mocks left)", () => {
  const org = "/api/app/organizations/o1";
  const artifact = { id: "a1", kind: "document", title: "Relatório", version: 2, untrusted: false };

  test("artifacts: list with filters, get by version, versions, save a version, download, file URL, delete", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/artifacts?q=rel&kind=document&channelId=c1&authorType=agent&authorId=ag`]: {
        status: 200,
        body: { artifacts: [artifact] },
      },
      [`${org}/artifacts/a1?version=1`]: { status: 200, body: { ...artifact, shownVersion: 1 } },
      [`${org}/artifacts/a1/versions`]: { status: 200, body: { versions: [{ version: 2 }, { version: 1 }] } },
      [`POST ${org}/artifacts/a1/versions`]: { status: 409, body: { error: { code: "conflict", message: "Stale" } } },
      [`${org}/artifacts/a1/download`]: { status: 200, body: { url: "https://bucket/x?sig", expiresAt: "t" } },
      [`DELETE ${org}/artifacts/a1`]: { status: 204 },
    });
    const api = createHttpApi(fetch);
    expect(
      await api.artifacts.list("o1", {
        q: "rel",
        kind: "document",
        channelId: "c1",
        author: { type: "agent", id: "ag" },
      }),
    ).toEqual([artifact] as never);
    expect((await api.artifacts.get("o1", "a1", 1)).shownVersion).toBe(1);
    expect((await api.artifacts.versions("o1", "a1")).map((v) => v.version)).toEqual([2, 1]);
    const stale = await api.artifacts
      .update("o1", "a1", { content: { kind: "document", markdown: "x" }, baseVersion: 1, note: "n" })
      .catch((e) => e);
    expect(stale).toMatchObject({ status: 409 });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      content: { kind: "document", markdown: "x" },
      baseVersion: 1,
      note: "n",
    });
    expect((await api.artifacts.download("o1", "a1")).url).toBe("https://bucket/x?sig");
    expect(api.artifacts.fileUrl("o1", "a1", { version: 2, format: "pdf" })).toBe(
      `${org}/artifacts/a1/file?version=2&format=pdf`,
    );
    expect(api.artifacts.fileUrl("o1", "a1")).toBe(`${org}/artifacts/a1/file`);
    await api.artifacts.remove("o1", "a1");
    expect(calls.at(-1)?.init.method).toBe("DELETE");
  });

  test("storage: get, test, save, migrate and migration status", async () => {
    const config = { kind: "agentes", s3: null, migration: null };
    const s3 = { endpoint: "https://r2", region: "auto", bucket: "b", prefix: null, pathStyle: true };
    const { fetch, calls } = fakeFetch({
      [`${org}/storage`]: { status: 200, body: config },
      [`POST ${org}/storage/test`]: { status: 200, body: { ok: true, steps: [] } },
      [`PUT ${org}/storage`]: { status: 200, body: { ...config, kind: "s3" } },
      [`POST ${org}/storage/migrate`]: { status: 200, body: { status: "running", copied: 0, total: 3, error: null } },
      [`${org}/storage/migration`]: { status: 200, body: null },
    });
    const api = createHttpApi(fetch);
    expect(await api.storage.get("o1")).toEqual(config as never);
    expect((await api.storage.test("o1", s3)).ok).toBe(true);
    expect((await api.storage.save("o1", { kind: "s3", s3 })).kind).toBe("s3");
    expect((await api.storage.migrate("o1")).status).toBe("running");
    expect(await api.storage.migration("o1")).toBeNull();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${org}/storage`,
      `POST ${org}/storage/test`,
      `PUT ${org}/storage`,
      `POST ${org}/storage/migrate`,
      `GET ${org}/storage/migration`,
    ]);
  });

  test("issues and routines", async () => {
    const issue = { id: "i1", number: 131 };
    const { fetch, calls } = fakeFetch({
      [`${org}/issues?q=wa`]: { status: 200, body: { issues: [issue] } },
      [`${org}/issues/by-number/131`]: { status: 200, body: issue },
      [`PATCH ${org}/issues/i1`]: { status: 200, body: issue },
      [`PUT ${org}/issues/i1/criteria/c1`]: { status: 200, body: issue },
      [`${org}/issues/i1/activity`]: { status: 200, body: { activity: [] } },
      [`POST ${org}/issues/i1/comments`]: { status: 201, body: { id: "x" } },
      [`POST ${org}/issues/i1/ask-agent`]: { status: 200, body: issue },
      [`${org}/routines`]: { status: 200, body: { routines: [] } },
      [`POST ${org}/routines/parse-schedule`]: { status: 200, body: { ok: false, error: "?" } },
      [`PATCH ${org}/routines/r1`]: { status: 200, body: { id: "r1" } },
      [`POST ${org}/routines/r1/run`]: { status: 200, body: { id: "r1" } },
      [`${org}/routines/r1/runs`]: { status: 200, body: { runs: [{ id: "run" }] } },
    });
    const api = createHttpApi(fetch);
    expect(await api.issues.list("o1", { q: "wa" })).toEqual([issue] as never);
    expect((await api.issues.get("o1", 131)).id).toBe("i1");
    await api.issues.update("o1", "i1", { status: "done" });
    await api.issues.setCriterion("o1", "i1", "c1", true);
    expect(await api.issues.activity("o1", "i1")).toEqual([]);
    await api.issues.comment("o1", "i1", "oi");
    await api.issues.askAgent("o1", "i1", "ag");
    expect(await api.routines.list("o1")).toEqual([]);
    expect(await api.routines.parseSchedule("o1", "quando der")).toEqual({ ok: false, error: "?" });
    await api.routines.setActive("o1", "r1", false);
    await api.routines.runNow("o1", "r1");
    expect((await api.routines.runs("o1", "r1"))[0]?.id).toBe("run");
    const bodies = calls.filter((c) => c.init.method !== "GET").map((c) => c.init.body);
    expect(bodies).toEqual([
      '{"status":"done"}',
      '{"done":true}',
      '{"text":"oi"}',
      '{"agentId":"ag"}',
      '{"phrase":"quando der"}',
      '{"active":false}',
      "{}",
    ]);
  });

  test("calendar, custom MCP and invites", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/calendar?from=2026-10-12&to=2026-10-19`]: {
        status: 200,
        body: { events: [], routines: [], deadlines: [], proposals: [] },
      },
      [`POST ${org}/calendar/events`]: { status: 201, body: { id: "e1" } },
      [`POST ${org}/calendar/proposals/p1/confirm`]: { status: 200, body: { id: "e2" } },
      [`POST ${org}/calendar/proposals/p1/dismiss`]: { status: 204 },
      [`${org}/connectors/custom`]: { status: 200, body: { servers: [] } },
      [`POST ${org}/connectors/custom`]: { status: 200, body: { status: "needs_key" } },
      [`PUT ${org}/connectors/custom/s1/tools`]: { status: 200, body: { id: "s1" } },
      [`POST ${org}/invite-links`]: { status: 201, body: { url: "https://x/invite/t", expiresAt: "t" } },
      "POST /api/app/invitations/tok/request-new": { status: 204 },
    });
    const api = createHttpApi(fetch);
    expect((await api.calendar.range("o1", "2026-10-12", "2026-10-19")).events).toEqual([]);
    await api.calendar.create("o1", { title: "x", start: "a", end: "b", recurrence: "none", participants: [] });
    expect((await api.calendar.confirmProposal("o1", "p1")).id).toBe("e2");
    await api.calendar.dismissProposal("o1", "p1");
    expect(await api.customConnectors.list("o1")).toEqual([]);
    expect(await api.customConnectors.connect("o1", { serverUrl: "https://mcp", returnTo: "/" })).toEqual({
      status: "needs_key",
    });
    await api.customConnectors.saveTools("o1", "s1", { label: "x", tools: [] });
    expect((await api.invites.createLink("o1")).url).toBe("https://x/invite/t");
    await api.invites.requestNew("tok");
    expect(calls.every((c) => c.init.method === "GET" || c.init.body !== undefined)).toBe(true);
  });
});
