import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("keys per provider: create as default in one call, Tornar padrão, models available per org, channel creator", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  let models = (await (await api("/models")).json()) as {
    models: { id: string; available: boolean; recommended: boolean }[];
  };
  expect(models.models.find((m) => m.id === "claude-sonnet-5-5")).toMatchObject({ available: true, recommended: true });
  expect(models.models.find((m) => m.id === "gpt-6-sol")).toMatchObject({ available: false, recommended: false });

  const created = await api("/credentials", {
    json: { provider: "openai", label: "OpenAI", apiKey: "sk-proj-abcdefgh", project: "proj_1", makeDefault: true },
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as { id: string; isDefault: boolean };
  expect(key.isDefault).toBe(true);
  const settings = (await (await api("/settings")).json()) as { defaultCredentialIds: Record<string, string> };
  expect(settings.defaultCredentialIds.openai).toBe(key.id);
  models = (await (await api("/models")).json()) as typeof models;
  expect(models.models.find((m) => m.id === "gpt-6-sol")?.available).toBe(true);

  expect((await api(`/credentials/${key.id}`, { method: "DELETE" })).status).toBe(409);
  const second = (await (
    await api("/credentials", { json: { provider: "openai", label: "b", apiKey: "sk-proj-zzzzzzzz" } })
  ).json()) as {
    id: string;
  };
  expect((await (await api(`/credentials/${second.id}/make-default`, { json: {} })).json()) as object).toMatchObject({
    isDefault: true,
  });
  expect((await api(`/credentials/${key.id}`, { method: "DELETE" })).status).toBe(204);

  const channels = (await (await api("/channels")).json()) as {
    channels: { id: string; createdByUserId: string | null }[];
  };
  expect(channels.channels.find((c) => c.id === channelId)?.createdByUserId).toBeTruthy();
});

test("an Anthropic-compatible provider's key: its models become available, and its default is set on its own", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/credentials", {
    json: { provider: "deepseek", label: "DeepSeek", apiKey: "sk-deepseek-abcdefgh" },
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as { id: string; provider: string };
  expect(key.provider).toBe("deepseek");
  const models = (await (await api("/models")).json()) as {
    models: { id: string; available: boolean; recommended: boolean }[];
    providers: { id: string; label: string; hasKey: boolean }[];
  };
  expect(models.models.find((m) => m.id === "deepseek-flash")).toMatchObject({ available: true, recommended: true });
  expect(models.models.find((m) => m.id === "glm-5.3")).toMatchObject({ available: false, recommended: false });
  expect(models.providers.find((p) => p.id === "deepseek")).toMatchObject({ label: "DeepSeek", hasKey: true });
  expect(models.providers.find((p) => p.id === "anthropic")?.label).toBe("Claude");
  const patched = await api("/settings", { method: "PATCH", json: { defaultCredentialIds: { deepseek: key.id } } });
  expect(patched.status).toBe(200);
  expect(
    ((await patched.json()) as { defaultCredentialIds: Record<string, string> }).defaultCredentialIds,
  ).toMatchObject({ deepseek: key.id });
  expect(
    (await api("/credentials", { json: { provider: "mistral", label: "x", apiKey: "abcdefgh1234" } })).status,
  ).toBe(400);
});

test("a Gemini key: Gemini third among the providers, its three models available, 3.8 Flash suggested", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/credentials", {
    json: { provider: "gemini", label: "Gemini", apiKey: "AQ.Ab8RN6Ltest-key-0123456789" },
  });
  expect(created.status).toBe(201);
  const models = (await (await api("/models")).json()) as {
    models: { id: string; provider: string; available: boolean; recommended: boolean }[];
    providers: { id: string; label: string; hasKey: boolean }[];
  };
  expect(models.providers.map((p) => p.id).slice(0, 3)).toEqual(["anthropic", "openai", "gemini"]);
  expect(models.providers.find((p) => p.id === "gemini")).toMatchObject({ label: "Gemini", hasKey: true });
  expect(models.models.filter((m) => m.provider === "gemini")).toMatchObject([
    { id: "gemini-4-argon", available: true, recommended: false },
    { id: "gemini-3.8-flash", available: true, recommended: true },
    { id: "gemini-3.5-flash-lite", available: true, recommended: false },
  ]);
});
