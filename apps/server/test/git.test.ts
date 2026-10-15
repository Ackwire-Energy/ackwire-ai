import { afterEach, expect, test } from "bun:test";
import { createFakeSandboxProvider } from "@agenteschat/adapters";
import { createTestServer, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("the git proxy is mounted at /api/git and asks for the computer's credential", async () => {
  t = await createTestServer({ sandbox: createFakeSandboxProvider() });
  const org = crypto.randomUUID();
  const conn = crypto.randomUUID();
  const res = await t.app.request(`/api/git/${org}/${conn}/acme/app.git/info/refs?service=git-upload-pack`);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain("Basic");
  const bad = await t.app.request(`/api/git/${org}/${conn}/acme/app.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from("agentes:not-a-token").toString("base64")}` },
  });
  expect(bad.status).toBe(401);
  expect((await t.app.request(`/api/git/${org}/${conn}/not-a-repo`)).status).toBe(404);
});

test("without a sandbox the git proxy is off", async () => {
  t = await createTestServer();
  const res = await t.app.request(`/api/git/${crypto.randomUUID()}/${crypto.randomUUID()}/acme/app.git/info/refs`);
  expect(res.status).toBe(404);
});
