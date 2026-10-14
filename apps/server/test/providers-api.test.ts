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
