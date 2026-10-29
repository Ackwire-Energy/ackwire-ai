import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createFakeSandboxProvider } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  agentCommitEmail,
  type ConnectorDeps,
  connectorGrantValidator,
  createApiKeyConnection,
  createGitToolSource,
  drainOutbox,
  type GitProxyDeps,
  gitSetupScript,
  grantScopes,
  handleGitProxy,
  inflateZlib,
  issueGitToken,
  parseReceivePackRequest,
  pkt,
  postPersonMessage,
  readPack,
  refRule,
  revokeComputerGitCredentials,
  setAgentHold,
  setAgentRepositories,
  setAgentScopes,
  setOrgStanding,
  type ToolContext,
  verifyGitToken,
  withSandbox,
  ZERO_OID,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const GH_TOKEN = "ghp_secret_123456";
const PUBLIC_URL = "https://agentes.test";

// ── Building packs like git does ─────────────────────────────────────────────

const sha1 = (type: string, data: Uint8Array) =>
  createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

function commitObject(parents: string[], message: string) {
  const data = enc(
    [
      `tree ${"4b825dc642cb6eb9a060e54bf8d69288fbee4904"}`,
      ...parents.map((p) => `parent ${p}`),
      "author Dev (agentes) <dev@agents.agentes.chat> 1760000000 +0000",
      "committer Dev (agentes) <dev@agents.agentes.chat> 1760000000 +0000",
      "",
      message,
      "",
    ].join("\n"),
  );
  return { type: 1, data, oid: sha1("commit", data) };
}

function blobObject(text: string) {
  const data = enc(text);
  return { type: 3, data, oid: sha1("blob", data) };
}

function packOf(objects: { type: number; data: Uint8Array }[]) {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set(enc("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  parts.push(header);
  for (const o of objects) {
    let size = o.data.length;
    const bytes = [(o.type << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size > 0) {
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) | 0x80;
      bytes.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(new Uint8Array(bytes), new Uint8Array(deflateSync(o.data)));
  }
  const body = Buffer.concat(parts);
  return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
}

function pushBody(commands: { old: string; new: string; ref: string }[], pack?: Uint8Array) {
  const lines = commands
    .map((c, i) => pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? "\0report-status side-band-64k" : ""}\n`))
    .join("");
  return new Uint8Array(Buffer.concat([Buffer.from(`${lines}0000`), Buffer.from(pack ?? new Uint8Array())]));
}

describe("pack reading", () => {
  test("inflate matches zlib and reports where each stream ends", () => {
    const inputs = [
      new Uint8Array(),
      enc("hello"),
      enc("abc".repeat(10_000)),
      new Uint8Array(randomBytes(70_000)),
      enc(Array.from({ length: 3000 }, (_, i) => `line ${i % 37} ${"x".repeat(i % 50)}`).join("\n")),
    ];
    for (const input of inputs) {
      for (const level of [0, 1, 6, 9]) {
        const z = new Uint8Array(deflateSync(input, { level }));
        const glued = new Uint8Array(Buffer.concat([z, Buffer.from("TRAILING")]));
        const out = inflateZlib(glued, 0);
        expect(Buffer.from(out.data ?? []).equals(Buffer.from(input))).toBe(true);
        expect(out.end).toBe(z.length);
        expect(inflateZlib(glued, 0, { keep: false }).end).toBe(z.length);
      }
    }
  });

  test("commits and parents from a pack, and the push commands before it", () => {
    const a = commitObject([], "first");
    const b = commitObject([a.oid], "second");
    const blob = blobObject("console.log(1)\n".repeat(500));
    const pack = packOf([a, blob, b]);
    const read = readPack(pack);
    expect(read.objects).toBe(3);
    expect(read.commits).toEqual([
      { oid: a.oid, parents: [] },
      { oid: b.oid, parents: [a.oid] },
    ]);
    const body = pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/heads/agentes/dev/x" }], pack);
    const parsed = parseReceivePackRequest(body);
    expect(parsed.commands).toEqual([{ oldOid: ZERO_OID, newOid: b.oid, ref: "refs/heads/agentes/dev/x" }]);
    expect(parsed.capabilities).toEqual(["report-status", "side-band-64k"]);
    expect(readPack(body, parsed.packStart).commits).toHaveLength(2);
  });

  test("ref rules: only agentes/{handle}/…, no tags, no deletes", () => {
    const c = (ref: string, newOid = "a".repeat(40)) => ({ oldOid: ZERO_OID, newOid, ref });
    expect(refRule(c("refs/heads/agentes/dev/fix-login"), "dev")).toBeNull();
    expect(refRule(c("refs/heads/main"), "dev")).toContain("agentes/dev/");
    expect(refRule(c("refs/heads/agentes/qa/x"), "dev")).toContain("agentes/dev/");
    expect(refRule(c("refs/heads/agentes/dev/"), "dev")).toContain("agentes/dev/");
    expect(refRule(c("refs/tags/v1"), "dev")).toContain("tags");
    expect(refRule(c("refs/heads/agentes/dev/x", ZERO_OID), "dev")).toContain("deleted");
  });

  test("the computer credential: valid, tampered, expired", () => {
    const claims = { orgId: "o", agentId: "a", sandboxId: "s", gen: 0, exp: Math.floor(Date.now() / 1000) + 60 };
    const token = issueGitToken(SECRET, claims);
    expect(verifyGitToken(SECRET, token)).toEqual(claims);
    expect(verifyGitToken(SECRET, `${token}x`)).toBeNull();
    expect(verifyGitToken("another-secret".padEnd(48, "y"), token)).toBeNull();
    expect(verifyGitToken(SECRET, token, new Date(Date.now() + 120_000))).toBeNull();
  });
});

// ── The proxy against a fake GitHub ──────────────────────────────────────────

function fakeGitHub(options: { compare?: Record<string, string> } = {}) {
  const calls: { url: string; method: string; auth: string | null; body: number }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? ((init.body as Uint8Array).byteLength ?? 0) : 0;
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body });
    if (url.includes("/info/refs")) {
      return new Response("001e# service=git-upload-pack\n0000", {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    if (url.endsWith("/git-upload-pack"))
      return new Response("0008NAK\n", { headers: { "content-type": "application/x-git-upload-pack-result" } });
    if (url.endsWith("/git-receive-pack"))
      return new Response("000eunpack ok\n0000", {
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    const compare = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url);
    if (compare) return Response.json({ status: options.compare?.[`${compare[1]}...${compare[2]}`] ?? "diverged" });
    if (url.endsWith("/repos/acme/app")) return Response.json({ default_branch: "main" });
    if (url.endsWith("/repos/acme/app/pulls") && init?.method === "POST") {
      return Response.json({ number: 7, html_url: "https://github.com/acme/app/pull/7" }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, gitUrl: "https://github.test", apiUrl: "https://api.github.test" };
}

async function world(scopes: string[] = ["github:git.read", "github:git.write"]) {
  f = await setup();
  const connectors: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: PUBLIC_URL };
  const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: GH_TOKEN,
  });
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    scopes.map((scope) => ({ connectionId: connection.id, scope })),
    connectorGrantValidator,
  );
  const [computer] = await f.db
    .insert(schema.sandboxes)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      key: `agent:${f.agent.id}`,
      provider: "fake",
      providerId: "sbx_1",
      status: "running",
      cpu: 1,
      memoryGib: 1,
      diskGib: 3,
    })
    .returning();
  if (!computer) throw new Error("no computer");
  const github = fakeGitHub();
  const deps: GitProxyDeps = { db: f.db, secret: SECRET, connectors, upstream: github };
  const token = issueGitToken(SECRET, {
    orgId: f.org.id,
    agentId: f.agent.id,
    sandboxId: computer.id,
    gen: 0,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const auth = `Basic ${Buffer.from(`agentes:${token}`).toString("base64")}`;
  const call = (
    path: string,
    init: { method?: string; body?: Uint8Array; auth?: string | null; query?: string } = {},
  ) =>
    handleGitProxy(
      deps,
      new Request(`${PUBLIC_URL}/api/git/${f.org.id}/${connection.id}/${path}${init.query ?? ""}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.auth === null ? {} : { authorization: init.auth ?? auth }),
          ...(init.body ? { "content-type": "application/x-git-receive-pack-request" } : {}),
        },
        body: init.body,
      }),
      { orgId: f.org.id, connectionId: connection.id, path },
    );
  return { connection, computer, github, deps, call, token };
}

const audits = async (action: string) =>
  f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, action)));

describe("git proxy", () => {
  test("clone: our credential in, GitHub's token added only upstream, audited", async () => {
    const w = await world(["github:git.read"]);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack", auth: null })).status).toBe(
      401,
    );
    const refs = await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" });
    expect(refs.status).toBe(200);
    expect(await refs.text()).toContain("service=git-upload-pack");
    const fetched = await w.call("acme/app.git/git-upload-pack", {
      method: "POST",
      body: enc("0032want abc\n00000009done\n"),
    });
    expect(await fetched.text()).toBe("0008NAK\n");
    expect(w.github.calls.map((c) => [c.method, c.url.replace(w.github.gitUrl, "")])).toEqual([
      ["GET", "/acme/app.git/info/refs?service=git-upload-pack"],
      ["POST", "/acme/app.git/git-upload-pack"],
    ]);
    const basic = `Basic ${Buffer.from(`x-access-token:${GH_TOKEN}`).toString("base64")}`;
    expect(w.github.calls.every((c) => c.auth === basic)).toBe(true);
    expect(await audits("git.fetch")).toHaveLength(1);
    // Read-only: no push, not even the advertisement.
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-receive-pack" })).status).toBe(403);
  });

  test("push: only agentes/{handle}/*, fast-forward, no tags; refused pushes never reach GitHub", async () => {
    const w = await world();
    const a = commitObject([], "base");
    const b = commitObject([a.oid], "work");

    const toMain = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/heads/main" }], packOf([a, b])),
    });
    expect(toMain.status).toBe(200);
    const report = await toMain.text();
    expect(report).toContain("ng refs/heads/main");
    expect(report).toContain("agentes/dev/");
    const tag = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/tags/v1" }], packOf([a, b])),
    });
    expect(await tag.text()).toContain("ng refs/tags/v1");
    expect(w.github.calls.filter((c) => c.url.endsWith("git-receive-pack"))).toHaveLength(0);
    expect(await audits("git.push_refused")).toHaveLength(2);

    // A new branch of its own: goes through, audited with the commit count.
    const created = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/heads/agentes/dev/fix" }], packOf([a, b])),
    });
    expect(await created.text()).toContain("unpack ok");
    const [pushed] = await audits("git.push");
    expect(pushed?.details).toMatchObject({ commits: 2, refs: [{ ref: "refs/heads/agentes/dev/fix", to: b.oid }] });

    // Fast-forward on top of it: fine.
    const c = commitObject([b.oid], "more");
    const ff = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: b.oid, new: c.oid, ref: "refs/heads/agentes/dev/fix" }], packOf([c])),
    });
    expect(await ff.text()).toContain("unpack ok");

    // A rewritten history (force push): its new commits don't lead to the old tip, and GitHub says diverged.
    const rewritten = commitObject([a.oid], "rewritten");
    const force = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: c.oid, new: rewritten.oid, ref: "refs/heads/agentes/dev/fix" }], packOf([rewritten])),
    });
    expect(await force.text()).toContain("not a fast-forward");
    expect(w.github.calls.filter((x) => x.url.endsWith("git-receive-pack"))).toHaveLength(2);
  });

  test("policy: scope, repository list, revoked or foreign credentials, size limit", async () => {
    const w = await world(["github:git.read"]);
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(200);
    const outside = await w.call("acme/other.git/info/refs", { query: "?service=git-upload-pack" });
    expect(outside.status).toBe(403);
    expect(await outside.text()).toContain("acme/other isn't one of");
    // A whole account: every repository of it.
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/*"]);
    expect((await w.call("acme/other.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(200);
    expect((await w.call("beta/other.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(403);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-receive-pack" })).status).toBe(403);

    const big = await handleGitProxy(
      { ...w.deps, limits: { fetchRequestBytes: 10 } },
      new Request(`${PUBLIC_URL}/x`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`agentes:${w.token}`).toString("base64")}` },
        body: enc("0032want abc\n0000"),
      }),
      { orgId: f.org.id, connectionId: w.connection.id, path: "acme/app.git/git-upload-pack" },
    );
    expect(big.status).toBe(413);

    // Another org's path with this credential: refused.
    const other = await handleGitProxy(
      w.deps,
      new Request(`${PUBLIC_URL}/x?service=git-upload-pack`, {
        headers: { authorization: `Basic ${Buffer.from(`agentes:${w.token}`).toString("base64")}` },
      }),
      { orgId: crypto.randomUUID(), connectionId: w.connection.id, path: "acme/app.git/info/refs" },
    );
    expect(other.status).toBe(401);

    await revokeComputerGitCredentials(f.db, f.org.id, f.agent.id);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(401);

    // Without any git scope: refused.
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, []);
    const w2token = issueGitToken(SECRET, {
      orgId: f.org.id,
      agentId: f.agent.id,
      sandboxId: w.computer.id,
      gen: 1,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const noScope = await w.call("acme/app.git/info/refs", {
      query: "?service=git-upload-pack",
      auth: `Basic ${Buffer.from(`agentes:${w2token}`).toString("base64")}`,
    });
    expect(noScope.status).toBe(403);
  });

  test("standing: a workspace on hold or suspended, or a held agent, gets no git through us", async () => {
    const w = await world();
    const refs = () => w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" });
    const standing = (state: "active" | "hold" | "suspended") =>
      setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, { state, reason: "Review", notice: "silent" });
    expect((await refs()).status).toBe(200);
    for (const state of ["hold", "suspended"] as const) {
      await standing(state);
      const refused = await refs();
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain("Review");
      await standing("active");
    }
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "Spam" });
    const held = await refs();
    expect(held.status).toBe(403);
    expect(await held.text()).toBe("agentes: This agent is paused for now.\n");
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: false, reason: null });
    expect((await refs()).status).toBe(200);
    // Refused before anything reached GitHub.
    expect(w.github.calls).toHaveLength(2);
  });
});

describe("the computer", () => {
  test("on start it gets our credential, the helper and insteadOf; never a GitHub token; our host is allowed", async () => {
    const sandbox = createFakeSandboxProvider();
    f = await setup({ sandbox, reply: () => ({ chunks: ["ok"] }) });
    const connectors: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: PUBLIC_URL };
    const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: GH_TOKEN,
    });
    await grantScopes(f.db, f.org.id, f.agent.id, [
      { connectionId: connection.id, scope: "github:git.write" },
      { connectionId: null, scope: "sandbox:run" },
    ]);
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev oi",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: run?.threadRootId ?? msg.id,
      triggerMessageId: msg.id,
    };
    const deps = { ...(f.sandboxDeps ?? ({} as never)), git: { publicUrl: PUBLIC_URL, secret: SECRET } };
    await withSandbox(deps, ctx, 10, async () => undefined);

    const created = sandbox.calls.find((c) => c.op === "create");
    expect(created?.spec).toMatchObject({ network: "allowlist", allowDomains: ["agentes.test"] });
    const setupCall = sandbox.calls.find((c) => c.op === "exec" && c.request?.command.includes("insteadOf"));
    const script = setupCall?.request?.command ?? "";
    expect(script).toContain(`url.${PUBLIC_URL}/api/git/${f.org.id}/${connection.id}/.insteadOf`);
    expect(script).toContain("https://github.com/");
    expect(script).toContain("Dev (agentes)");
    expect(script).toContain("dev@agents.agentes.test");
    const token = /printf %s '([^']+)' > "\$HOME\/\.config\/agentes\/git-token"/.exec(script)?.[1] ?? "";
    expect(verifyGitToken(SECRET, token)).toMatchObject({ orgId: f.org.id, agentId: f.agent.id });
    // The GitHub token is nowhere in the computer: not in commands, files or the spec.
    expect(JSON.stringify(sandbox.calls)).not.toContain(GH_TOKEN);
    expect(script).not.toContain("GITHUB_TOKEN");
    // The row still says the org's mode, and the token's time is recorded.
    const [row] = await f.db.select().from(schema.sandboxes);
    expect(row).toMatchObject({ network: "blocked" });
    expect(row?.gitTokenIssuedAt).not.toBeNull();

    // Used again while running and fresh: no new setup.
    const before = sandbox.calls.filter((c) => c.op === "exec").length;
    await withSandbox(deps, ctx, 10, async () => undefined);
    expect(sandbox.calls.filter((c) => c.op === "exec").length).toBe(before);
  });

  test("the setup script is plain sh and keeps the token out of the environment", () => {
    const script = gitSetupScript({
      base: `${PUBLIC_URL}/api/git/o/c/`,
      token: "agtgit1.x.y",
      agentName: "Theo",
      agentHandle: "theo",
    });
    expect(script).not.toMatch(/\bexport\b|\benv\b/);
    expect(script).toContain('chmod 600 "$HOME/.config/agentes/git-token"');
    expect(script).toContain("credential.https://agentes.test.helper");
  });

  test("agents commit as handle@agents.<our host>: theo@agents.agentes.chat on agentes.chat", () => {
    expect(agentCommitEmail("https://agentes.chat", "theo")).toBe("theo@agents.agentes.chat");
    expect(agentCommitEmail("https://agentes.chat/api/git/o/c/", "theo")).toBe("theo@agents.agentes.chat");
    expect(agentCommitEmail("http://localhost:3000", "theo")).toBe("theo@agents.localhost");
  });

  test("git_clone runs real git in the computer; open_pull_request goes through the org's GitHub", async () => {
    const sandbox = createFakeSandboxProvider();
    f = await setup({ sandbox });
    const connectors: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: PUBLIC_URL };
    const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: GH_TOKEN,
    });
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
    const github = fakeGitHub();
    const source = createGitToolSource({
      sandbox: { ...(f.sandboxDeps ?? ({} as never)), git: { publicUrl: PUBLIC_URL, secret: SECRET } },
      connectors,
      github: { apiUrl: github.apiUrl, fetch: github.fetch },
    });
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev oi",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: run?.threadRootId ?? msg.id,
      triggerMessageId: msg.id,
    };
    const tools = await source.tools(ctx);
    expect(tools.map((t) => [t.name, t.scope, t.connectionId])).toEqual([
      ["git_clone", "github:git.read", connection.id],
      ["open_pull_request", "github:pr.write", connection.id],
    ]);
    const clone = tools.find((t) => t.name === "git_clone");
    const result = await clone?.execute({ repo: "https://github.com/acme/app.git" }, ctx);
    expect(result?.isError).toBeFalsy();
    expect(
      sandbox.calls.some((c) => c.request?.command.startsWith("git clone --quiet https://github.com/acme/app 'app'")),
    ).toBe(true);
    const pr = await tools
      .find((t) => t.name === "open_pull_request")
      ?.execute({ repo: "acme/app", branch: "agentes/dev/fix", title: "Fix login" }, ctx);
    expect(pr?.content).toContain("https://github.com/acme/app/pull/7");
    const post = github.calls.find((c) => c.method === "POST");
    expect(post?.auth).toBe(`Bearer ${GH_TOKEN}`);
    expect(JSON.stringify(sandbox.calls)).not.toContain(GH_TOKEN);
  });
});
