import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { parseReleaseBody, parseSha256 } from "../src/routes/desktop";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | null = null;
afterEach(() => {
  t?.close();
  t = null;
});
/** The current test's server (set by the test). */
const server = () => {
  if (!t) throw new Error("no server");
  return t;
};

const SUM = "a".repeat(64);
const ASSETS = "https://api.github.com/repos/wescld/agents.chat/releases/assets";
const asset = (name: string) => ({ name, url: `${ASSETS}/${name}` });
const release = (version: string, extra: Record<string, unknown> = {}) => ({
  tag_name: `desktop-v${version}`,
  body: "Melhorias.\nmin-version: 0.1.0\n",
  published_at: "2026-10-17T12:00:00Z",
  assets: [asset(`agentes_${version}_universal.dmg`), asset(`agentes_${version}_universal.dmg.sha256`)],
  ...extra,
});

/** A fake GitHub: releases newest first; assets redirect to a "signed" URL that must not get our token. */
function fakeGithub(releases: Record<string, unknown>[]) {
  const calls: { url: string; auth: string | null }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth });
    if (url.startsWith("https://signed.example/")) {
      if (auth) return new Response("two auth mechanisms", { status: 400 });
      const name = url.slice("https://signed.example/".length);
      if (name.endsWith(".sha256")) return new Response(`${SUM}  agentes.dmg\n`);
      const headers = { "content-type": "application/x-apple-diskimage", "content-length": "9" };
      return new Response("DMG-BYTES", { headers });
    }
    if (auth !== "Bearer ghp_test") return new Response("no", { status: 401 });
    if (url.endsWith("/releases?per_page=30")) return Response.json(releases);
    const tag = url.match(/\/releases\/tags\/(.+)$/)?.[1];
    if (tag) {
      const found = releases.find((r) => r.tag_name === decodeURIComponent(tag));
      return found ? Response.json(found) : new Response("not found", { status: 404 });
    }
    const name = url.match(/\/releases\/assets\/(.+)$/)?.[1];
    if (name) return new Response(null, { status: 302, headers: { location: `https://signed.example/${name}` } });
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls };
}

test("release body and checksum parsing", () => {
  expect(parseReleaseBody("Novidades\n\nmin-version: v0.2.0\n- item")).toEqual({
    notes: "Novidades\n\n- item",
    minVersion: "0.2.0",
  });
  expect(parseReleaseBody(null)).toEqual({ notes: "" });
  expect(parseSha256(`${SUM.toUpperCase()}  file.dmg`)).toBe(SUM);
  expect(parseSha256("nope")).toBeNull();
});

test("without a token the desktop endpoints answer 404", async () => {
  const github = fakeGithub([release("0.2.0")]);
  t = await createTestServer({ desktopFetch: github.fetch });
  expect((await server().app.request("/api/desktop/latest?target=darwin&arch=arm64")).status).toBe(404);
  expect((await server().app.request("/api/desktop/download/0.2.0/agentes_0.2.0_universal.dmg")).status).toBe(404);
  expect(github.calls).toEqual([]);
});

test("latest: the newest desktop-v* release with its dmg and checksum, cached, open to the web view", async () => {
  const github = fakeGithub([
    { tag_name: "v9.9.9", assets: [] },
    release("0.3.0", { draft: true }),
    release("0.2.0"),
    release("0.1.0"),
  ]);
  t = await createTestServer({ env: { DESKTOP_RELEASES_TOKEN: "ghp_test" }, desktopFetch: github.fetch });
  const res = await server().app.request("/api/desktop/latest?target=darwin&arch=arm64", {
    headers: { origin: "tauri://localhost" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(await res.json()).toEqual({
    version: "0.2.0",
    url: "http://localhost:3000/api/desktop/download/0.2.0/agentes_0.2.0_universal.dmg",
    sha256: SUM,
    notes: "Melhorias.",
    publishedAt: "2026-10-17T12:00:00Z",
    minVersion: "0.1.0",
  });
  // Both architecture spellings; one universal build.
  for (const arch of ["aarch64", "x64", "x86_64"]) {
    expect((await server().app.request(`/api/desktop/latest?target=darwin&arch=${arch}`)).status).toBe(200);
  }
  expect((await server().app.request("/api/desktop/latest?target=windows&arch=x64")).status).toBe(404);
  // Cached: GitHub's release list was read once.
  expect(github.calls.filter((c) => c.url.endsWith("/releases?per_page=30"))).toHaveLength(1);
  // The signed asset URL never gets our token.
  expect(github.calls.filter((c) => c.url.startsWith("https://signed.example/")).every((c) => c.auth === null)).toBe(
    true,
  );
  const preflight = await server().app.request("/api/desktop/latest", { method: "OPTIONS" });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
});

test("download streams an asset of a desktop-v* release, as an attachment; nothing else", async () => {
  const github = fakeGithub([release("0.2.0"), { tag_name: "v1.0.0", assets: [asset("secret.txt")] }]);
  t = await createTestServer({ env: { DESKTOP_RELEASES_TOKEN: "ghp_test" }, desktopFetch: github.fetch });
  const res = await server().app.request("/api/desktop/download/0.2.0/agentes_0.2.0_universal.dmg");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="agentes_0.2.0_universal.dmg"');
  expect(res.headers.get("content-type")).toBe("application/x-apple-diskimage");
  expect(await res.text()).toBe("DMG-BYTES");
  expect((await server().app.request("/api/desktop/download/0.2.0/other.dmg")).status).toBe(404);
  expect((await server().app.request("/api/desktop/download/1.0.0/secret.txt")).status).toBe(404);
  expect((await server().app.request("/api/desktop/download/..%2F..%2Fx/a.dmg")).status).toBe(404);
});

test("reduce over HTTP: admins or the pairer, only removing or turning off", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(server());
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const RUNNER = {
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.9.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/a/agentes",
  };
  const paired = await pairComputer(server(), api, { ...RUNNER, exec: true });
  let access = {
    folders: [{ path: "/Users/a/Projects", agents: [] as string[] }],
    tools: { claude: true, codex: false, commands: true },
  };
  const hub = server().engine.machineHub;
  const sent: ServerFrame[] = [];
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type !== "request" || frame.op !== "access.reduce") return;
      if (frame.disableTool) access = { ...access, tools: { ...access.tools, [frame.disableTool]: false } };
      if (frame.removeFolder) access = { ...access, folders: [] };
      const result = JSON.stringify({ type: "result", id: frame.id, ok: true, data: { access } });
      setTimeout(() => void hub.message(conn, result), 1);
    },
    close() {},
  });
  await hub.message(conn, JSON.stringify({ type: "hello", token: paired.token, ...RUNNER, exec: true, access }));

  const list = (await (await api("/machines")).json()) as { machines: { access: unknown; protocol: number }[] };
  expect(list.machines[0]).toMatchObject({ access, protocol: MACHINE_PROTOCOL_VERSION });
  // Never widens: nothing but removing a folder or turning a tool off is accepted.
  const widen = await api(`/machines/${paired.machineId}/access/reduce`, { json: { addFolder: { path: "/" } } });
  expect(widen.status).toBe(400);
  const res = await api(`/machines/${paired.machineId}/access/reduce`, { json: { disableTool: "commands" } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { access: typeof access }).access.tools.commands).toBe(false);
  expect(sent.some((s) => s.type === "request" && s.op === "access.reduce" && s.disableTool === "commands")).toBe(true);
});
