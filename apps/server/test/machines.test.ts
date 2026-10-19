import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ARTIFACT_LIMITS, createUpload } from "@agenteschat/engine";
import { browser, createTestServer, listen, ORIGIN, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
let server: ReturnType<typeof listen> | null = null;
afterEach(async () => {
  if (server) await Promise.race([server.stop(true), Bun.sleep(500)]);
  server = null;
  await t.close();
});

const RUNNER = { hostname: "box", os: "linux", arch: "x64", version: "0.1.0", protocol: 1, workspace: "/srv/agentes" };

/** The runner's own calls: no cookie, no Origin. */
const runnerCall = (path: string, init: RequestInit = {}) => t.app.request(path, init);
const runnerPost = (path: string, body: unknown, ip = "203.0.113.7") =>
  runnerCall(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const pair = (name = "Build box") => pairComputer(t, api, { ...RUNNER, exec: true }, { name });
  return { owner, api, pair, ...seeded };
}

test("connecting over HTTP: code, confirm page, confirm, the token once; errors in the device-flow shape", async () => {
  const { owner, api, orgId } = await start();
  const started = await runnerPost("/api/machines/device", { name: "Build box", ...RUNNER });
  expect(started.status).toBe(200);
  const code = (await started.json()) as { deviceCode: string; userCode: string; verificationUrl: string };
  expect(code).toMatchObject({ expiresIn: 600, interval: 3 });
  expect(code.verificationUrl).toBe(`${ORIGIN}/conectar?code=${code.userCode}`);

  const poll = () => runnerPost("/api/machines/device/token", { deviceCode: code.deviceCode });
  const pending = await poll();
  expect(pending.status).toBe(400);
  expect(await pending.json()).toEqual({ error: "authorization_pending" });
  expect(await (await poll()).json()).toEqual({ error: "slow_down" });

  // The confirm page needs a session; it shows what asked.
  expect((await runnerCall(`/api/app/machines/device/${code.userCode}`)).status).toBe(401);
  const view = await owner(`/api/app/machines/device/${code.userCode}`);
  expect(view.status).toBe(200);
  expect(await view.json()).toMatchObject({ name: "Build box", hostname: "box", os: "linux", approxLocation: null });
  expect((await owner("/api/app/machines/device/AAAAAA")).status).toBe(404);

  // CSRF: another origin can't confirm.
  const cross = await api(`/machines/device/${code.userCode}/confirm`, { json: {}, origin: "https://evil.example" });
  expect(cross.status).toBe(403);
  const confirmed = await api(`/machines/device/${code.userCode}/confirm`, { json: { name: "Servidor" } });
  expect(confirmed.status).toBe(201);
  const machine = (await confirmed.json()) as { id: string; name: string; paused: unknown; access: unknown };
  expect(machine).toMatchObject({ name: "Servidor", paused: null, access: null, agents: [] });

  const token = await poll();
  expect(token.status).toBe(200);
  const body = (await token.json()) as { token: string; machineId: string; org: { id: string } };
  expect(body).toMatchObject({ machineId: machine.id, name: "Servidor", org: { id: orgId, name: "Acme" } });
  expect(body.token).toStartWith("agm_");
  expect(await (await poll()).json()).toEqual({ error: "expired_token" });

  const list = (await (await api("/machines")).json()) as { machines: { id: string; online: boolean }[] };
  expect(list.machines).toEqual([expect.objectContaining({ id: machine.id, name: "Servidor", online: false })]);
  // The old pairing is gone.
  expect((await api("/machines/pairings", { json: { name: "x" } })).status).toBe(404);
  expect((await runnerPost("/api/machines/pair", { code: "AAAA-BBBB" })).status).toBe(404);
});

test("\"it wasn't me\", outsiders can't confirm, and new codes are rate limited per address", async () => {
  const { api, orgId } = await start();
  const denied = (await (await runnerPost("/api/machines/device", { name: "x", ...RUNNER })).json()) as {
    deviceCode: string;
    userCode: string;
  };
  const stranger = browser(t);
  await signUp(stranger, "zed@example.com");
  // Signed in but not a member: can deny a code shown to them, never connect it to someone else's org.
  const outsider = await stranger(`/api/app/organizations/${orgId}/machines/device/${denied.userCode}/confirm`, {
    json: {},
  });
  expect(outsider.status).toBe(403);
  const deny = await stranger(`/api/app/machines/device/${denied.userCode}/deny`, { method: "POST", json: {} });
  expect(deny.status).toBe(204);
  expect(await (await runnerPost("/api/machines/device/token", { deviceCode: denied.deviceCode })).json()).toEqual({
    error: "access_denied",
  });
  expect((await api(`/machines/device/${denied.userCode}/confirm`, { json: {} })).status).toBe(404);

  // 10 new codes a minute per address (and at most 10 pending).
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await runnerPost("/api/machines/device", RUNNER, "198.51.100.1")).status);
  expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
  expect(statuses[10]).toBe(429);
  expect((await runnerPost("/api/machines/device", RUNNER, "198.51.100.2")).status).toBe(200);
});

test("install.sh is served without a session, never cached", async () => {
  t = await createTestServer();
  const res = await runnerCall("/api/machines/install.sh");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/x-shellscript");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const script = await res.text();
  expect(script).toStartWith("#!/bin/sh");
  expect(script).toContain(ORIGIN);
});

test("uploads PUT: machine token, its own upload only, size refused before reading", async () => {
  const { pair, orgId, agentId, channelId } = await start();
  const a = await pair("A");
  const b = await pair("B");
  const upload = await createUpload(t.db, {
    orgId,
    agentId,
    channelId,
    computer: `machine:${a.machineId}`,
    machineId: a.machineId,
    path: "out/report.pdf",
    title: "Report",
  });
  const body = new TextEncoder().encode("%PDF-1.4 hello");
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/pdf",
    "x-agentes-file-name": encodeURIComponent("relatório.pdf"),
    "x-agentes-sha256": createHash("sha256").update(body).digest("hex"),
    "x-agentes-upload-id": upload.id,
  });
  const put = (token: string, data: Uint8Array = body) =>
    runnerCall(`/api/machines/uploads/${upload.id}`, { method: "PUT", headers: headers(token), body: data });

  expect((await put("agm_nope")).status).toBe(401);
  expect((await runnerCall(`/api/machines/uploads/${upload.id}`, { method: "PUT", body })).status).toBe(401);
  const wrong = await put(b.token);
  expect(wrong.status).toBe(403);
  expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("upload.wrong_machine");

  const big = new Uint8Array(ARTIFACT_LIMITS.fileBytes + 128 * 1024);
  const tooBig = await put(a.token, big);
  expect(tooBig.status).toBe(413);

  const ok = await put(a.token);
  expect(ok.status).toBe(200);
  const done = (await ok.json()) as { ok: boolean; artifactId: string; version: number };
  expect(done).toMatchObject({ ok: true, version: 1 });
  expect(done.artifactId).toMatch(/^[0-9a-f-]{36}$/);
  // Once only.
  expect((await put(a.token)).status).toBe(409);
});

test("rename, delete, target and the computer view; deleting revokes the token", async () => {
  const { api, pair, agentId } = await start();
  const { machineId, token } = await pair();
  const renamed = await api(`/machines/${machineId}`, { method: "PATCH", json: { name: "Laptop" } });
  expect(await renamed.json()).toEqual({ id: machineId, name: "Laptop" });

  const target = await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId } });
  expect(await target.json()).toEqual({ kind: "machine", machineId, name: "Laptop", online: false });
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({
    target: { kind: "machine", machineId, name: "Laptop" },
  });
  const list = (await (await api("/machines")).json()) as { machines: { agents: { id: string }[] }[] };
  expect(list.machines[0]?.agents.map((a) => a.id)).toEqual([agentId]);

  // CSRF: another origin can't change anything.
  const cross = await api(`/machines/${machineId}`, { method: "DELETE", origin: "https://evil.example" });
  expect(cross.status).toBe(403);

  expect((await api(`/machines/${machineId}`, { method: "DELETE" })).status).toBe(204);
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({ target: { kind: "cloud" } });
  const upload = await runnerCall(`/api/machines/uploads/${crypto.randomUUID()}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: "x",
  });
  expect(upload.status).toBe(401);
  expect(
    (await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: crypto.randomUUID() } }))
      .status,
  ).toBe(404);
});

test("reconnecting over HTTP: the removed computer comes back with its agent; a junk id is a new computer", async () => {
  const { owner, api, pair, agentId } = await start();
  const { machineId } = await pair("Laptop");
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId } });
  expect((await api(`/machines/${machineId}`, { method: "DELETE" })).status).toBe(204);

  const started = await runnerPost("/api/machines/device", { name: "x", ...RUNNER, previousMachineId: machineId });
  const code = (await started.json()) as { deviceCode: string; userCode: string };
  const view = await owner(`/api/app/machines/device/${code.userCode}`);
  expect(await view.json()).toMatchObject({ reconnect: { machineId, name: "Laptop", orgName: "Acme" } });
  const confirmed = await api(`/machines/device/${code.userCode}/confirm`, { json: {} });
  expect(await confirmed.json()).toMatchObject({ id: machineId, name: "Laptop" });
  const token = await runnerPost("/api/machines/device/token", { deviceCode: code.deviceCode });
  expect(await token.json()).toMatchObject({ machineId, name: "Laptop" });
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toMatchObject({
    target: { kind: "machine", machineId },
  });

  const junk = await runnerPost(
    "/api/machines/device",
    { name: "y", ...RUNNER, previousMachineId: "nope" },
    "203.0.113.8",
  );
  expect(junk.status).toBe(200);
  const junkCode = (await junk.json()) as { userCode: string };
  const junkView = (await (await owner(`/api/app/machines/device/${junkCode.userCode}`)).json()) as {
    reconnect?: unknown;
  };
  expect(junkView.reconnect).toBeUndefined();
});

test("the runner's WebSocket: no Origin, hello → welcome, online in the list", async () => {
  const { api, pair } = await start();
  const { machineId, token } = await pair();
  server = listen(t);
  const url = `ws://127.0.0.1:${server.port}/api/machines/connect`;

  // A browser (Origin present) is refused.
  const refused = await fetch(url.replace("ws://", "http://"), {
    headers: {
      origin: ORIGIN,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
  expect(refused.status).toBe(403);

  const ws = new WebSocket(url);
  const frames: { type: string }[] = [];
  const welcome = new Promise<{ type: string; machineId?: string }>((resolve, reject) => {
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data)) as { type: string };
      frames.push(frame);
      if (frame.type === "welcome") resolve(frame);
    };
    ws.onclose = () => reject(new Error(`closed; frames: ${JSON.stringify(frames)}`));
    setTimeout(() => reject(new Error("timeout")), 5000);
  });
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  ws.send(JSON.stringify({ type: "hello", token, ...RUNNER, exec: true }));
  expect(await welcome).toMatchObject({ type: "welcome", machineId });
  const list = (await (await api("/machines")).json()) as { machines: { online: boolean }[] };
  expect(list.machines[0]?.online).toBe(true);
  ws.onclose = null;
  ws.close();
});
