import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ARTIFACT_LIMITS, createUpload } from "@agenteschat/engine";
import { browser, createTestServer, listen, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

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
const pairCall = (body: unknown, ip = "203.0.113.7") =>
  runnerCall("/api/machines/pair", {
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
  const pair = async (name = "Build box") => {
    const res = await api("/machines/pairings", { json: { name } });
    expect(res.status).toBe(201);
    const pairing = (await res.json()) as { code: string; expiresAt: string; installCommand: string };
    const paired = await pairCall({ code: pairing.code, ...RUNNER, exec: true });
    expect(paired.status).toBe(200);
    return { pairing, ...((await paired.json()) as { machineId: string; name: string; token: string }) };
  };
  return { owner, api, pair, ...seeded };
}

test("pairing over HTTP: code and install command, single use, same error for any bad code, rate limited", async () => {
  const { api, pair } = await start();
  const { pairing, machineId, name, token } = await pair();
  expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(pairing.installCommand).toBe(`curl -fsSL ${ORIGIN}/api/machines/install.sh | sh -s -- --code ${pairing.code}`);
  expect(name).toBe("Build box");
  expect(token).toStartWith("agm_");

  const again = await pairCall({ code: pairing.code, ...RUNNER, exec: true });
  expect(again.status).toBe(400);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("machine.pairing_invalid");

  const list = (await (await api("/machines")).json()) as { machines: { id: string; name: string; online: boolean }[] };
  expect(list.machines).toEqual([expect.objectContaining({ id: machineId, name: "Build box", online: false })]);

  // 10 a minute per address.
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++)
    statuses.push((await pairCall({ code: "AAAA-BBBB", ...RUNNER, exec: true }, "198.51.100.1")).status);
  expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
  expect(statuses[10]).toBe(429);
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
