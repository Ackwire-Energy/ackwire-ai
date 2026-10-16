import { afterEach, expect, test } from "bun:test";
import { createFakeSandboxProvider } from "@agenteschat/adapters";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("computer API: settings, the agent's computer, and the access tree shows 'Run code'", async () => {
  t = await createTestServer({ sandbox: createFakeSandboxProvider() });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  expect(await (await api("/sandbox-settings")).json()).toMatchObject({
    available: true,
    enabled: true,
    allowDomains: [],
    execTimeoutSeconds: 60,
    maxTimeoutSeconds: 600,
    requireApproval: false,
  });
  const put = await api("/sandbox-settings", {
    method: "PUT",
    json: { allowDomains: ["pypi.org", "files.pythonhosted.org"], requireApproval: true },
  });
  expect(await put.json()).toMatchObject({
    allowDomains: ["pypi.org", "files.pythonhosted.org"],
    requireApproval: true,
  });
  expect((await api("/sandbox-settings", { method: "PUT", json: { allowDomains: ["not a domain"] } })).status).toBe(
    400,
  );
  // The agent's computer: none yet, then on, off, deleted.
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({ status: "none", diskUsedGib: 0 });
  const on = await api(`/agents/${agentId}/computer/start`, { json: {} });
  expect(on.status).toBe(202);
  expect(await on.json()).toEqual({ status: "starting" });
  await t.drain();
  // The org allowlist was set above, so the computer is created with it.
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({
    status: "running",
    network: "allowlist",
  });
  expect(await (await api(`/agents/${agentId}/computer`)).json()).not.toHaveProperty("costMonthUsd");
  const off = await api(`/agents/${agentId}/computer/stop`, { json: {} });
  expect(off.status).toBe(202);
  expect(await off.json()).toEqual({ status: "stopping" });
  await t.drain();
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({ status: "stopped" });
  expect((await api(`/agents/${agentId}/computer`, { method: "DELETE" })).status).toBe(204);
  expect((await api(`/agents/${agentId}/computer/stop`, { json: {} })).status).toBe(404);

  const tree = (await (await api(`/agents/${agentId}/access`)).json()) as {
    builtins: { scope: string; label: string; state: string; tools: { name: string }[] }[];
  };
  const sandbox = tree.builtins.find((b) => b.scope === "sandbox:run");
  expect(sandbox).toMatchObject({ label: "Run code", state: "off" });
  expect(sandbox?.tools.map((x) => x.name)).toContain("run_code");
});

test("without a provider the sandbox is reported as unavailable", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  expect(await (await owner(`/api/app/organizations/${orgId}/sandbox-settings`)).json()).toMatchObject({
    available: false,
  });
  // Connected machines may still give agents a computer: the status answers, cloud start is refused.
  expect(await (await owner(`/api/app/organizations/${orgId}/agents/${agentId}/computer`)).json()).toMatchObject({
    status: "none",
    target: { kind: "cloud" },
  });
  const start = await owner(`/api/app/organizations/${orgId}/agents/${agentId}/computer/start`, { json: {} });
  expect(start.status).toBe(404);
});
