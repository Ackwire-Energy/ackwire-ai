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
