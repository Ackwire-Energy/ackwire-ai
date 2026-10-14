import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createTestServer } from "./harness";

test("health reports database state", async () => {
  const ok = createApp({
    edition: "selfhost",
    version: "1.2.3",
    modules: [{ name: "x" }],
    pingDatabase: async () => {},
  });
  const res = await ok.request("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    version: "1.2.3",
    edition: "selfhost",
    database: "ok",
    modules: ["x"],
  });
  const down = createApp({
    edition: "selfhost",
    version: "1",
    modules: [],
    pingDatabase: async () => Promise.reject(new Error("x")),
  });
  expect((await down.request("/api/health")).status).toBe(503);
});

test("unknown API routes return the JSON error shape", async () => {
  const app = createApp({ edition: "selfhost", version: "1", modules: [], pingDatabase: async () => {} });
  const res = await app.request("/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
});

test("modules can register routes", async () => {
  const t = await createTestServer();
  const app = createApp({
    edition: "cloud",
    version: "1",
    pingDatabase: async () => {},
    modules: [
      { name: "cloud-billing", registerRoutes: (api) => api.get("/billing/ping", (c) => c.json({ pong: true })) },
    ],
    moduleContext: { config: t.config, db: t.db, edition: "cloud", version: "1", adapters: t.adapters },
  });
  expect(await (await app.request("/api/billing/ping")).json()).toEqual({ pong: true });
  await t.close();
});

test("the OpenAPI document lists the app API", async () => {
  const t = await createTestServer();
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  for (const path of [
    "/app/me",
    "/app/organizations/{orgId}/agents",
    "/app/organizations/{orgId}/channels/{channelId}/messages",
  ]) {
    expect(Object.keys(doc.paths)).toContain(path);
  }
  await t.close();
});
