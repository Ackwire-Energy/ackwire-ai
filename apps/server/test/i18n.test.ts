import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

test("errors carry a stable code and params (English message as fallback); rule descriptions in the asked language", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const taken = await api("/me", { method: "PATCH", json: { handle: "dev" } });
  expect(taken.status).toBe(409);
  expect(await taken.json()).toEqual({
    error: { code: "handle.taken_by_agent", message: "@dev belongs to an agent", params: { handle: "dev" } },
  });

  const big = await api("/me/avatar", {
    method: "PUT",
    json: { imageBase64: "!!!", contentType: "image/png" },
  });
  expect(((await big.json()) as { error: { code: string } }).error.code).toBe("avatar.not_base64");

  const rule = { freq: "weekly", interval: 2, byWeekday: ["MO", "WE"], times: ["09:00"], timezone: "UTC" };
  const en = (await (await api("/routines/describe-rule", { json: { rule, locale: "en" } })).json()) as {
    description: string;
  };
  expect(en.description).toBe("Every 2 weeks, Mon and Wed, at 09:00 (UTC)");
  const pt = (await (await api("/routines/describe-rule", { json: { rule } })).json()) as { description: string };
  expect(pt.description).toBe("A cada 2 semanas, seg e qua, às 09:00 (UTC)");
  const bad = (await (
    await api("/routines/describe-rule", { json: { rule: { ...rule, byWeekday: ["2MO"] } } })
  ).json()) as { ok: boolean; code: string };
  expect(bad).toMatchObject({ ok: false, code: "schedule.position_needs_month" });
});

test("run failures, approvals and memory updates carry codes", async () => {
  const { runErrorDetail, scalarParams } = await import("@agenteschat/engine");
  expect(runErrorDetail("budget_exceeded")).toEqual({ errorCode: "run.budget_exceeded" });
  expect(runErrorDetail("provider_error: rate limited")).toEqual({
    errorCode: "run.provider_error",
    errorParams: { detail: "rate limited" },
  });
  expect(runErrorDetail("canceled_by:u1")).toEqual({ errorCode: "run.canceled", errorParams: { byUserId: "u1" } });
  expect(runErrorDetail("Configure uma chave da API da Anthropic nas configurações do workspace")).toEqual({
    errorCode: "run.missing_credential",
    errorParams: { provider: "Anthropic" },
  });
  expect(runErrorDetail("Interrompida por uma atualização do servidor")).toMatchObject({
    errorCode: "run.interrupted",
  });
  expect(runErrorDetail(null)).toBeNull();
  expect(scalarParams({ owner: "acme", repo: "app", pullNumber: 42, body: { x: 1 } })).toEqual({
    owner: "acme",
    repo: "app",
    pullNumber: 42,
  });
});
