import { afterEach, describe, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TEAM = '{"format":"openmaus.package","version":2,"package":{}}';
const AGENTS = "agents:\n  - id: knowledge\n    name: Knowledge\n";

interface Entry {
  path: string;
  size?: number;
  type?: string;
  mode?: string;
}

/** A tenant package next to an OpenClaw-style workspace, with what must never be read. */
const PACKAGE: Entry[] = [
  { path: "tenant", type: "tree", mode: "040000" },
  { path: "tenant/.env.json" },
  { path: "tenant/CLAW.md" },
  { path: "tenant/agents.yaml", size: AGENTS.length },
  { path: "tenant/agents", type: "tree", mode: "040000" },
  { path: "tenant/agents/README.md" },
  { path: "tenant/agents/expense-review.yaml" },
  { path: "tenant/agents/scout/AGENTS.md" },
  { path: "tenant/agents/scout/deep/notes.md" },
  { path: "tenant/auth-profiles.json" },
  { path: "tenant/catalog/items.md" },
  { path: "tenant/cron/jobs.json" },
  { path: "tenant/link.md", mode: "120000" },
  { path: "tenant/logo.png", size: 2000 },
  { path: "tenant/memory/2026-10-19.md" },
  { path: "tenant/memory/2026-10-20.md" },
  { path: "tenant/model.yaml" },
  { path: "tenant/skills/triage/SKILL.md" },
  { path: "tenant/skills/triage/references/labels.md" },
  { path: "tenant/skills/triage/run.sh" },
  { path: "other/agents.yaml" },
];

/** Fake GitHub: a team file, and one repository (`acme/pacote`) listed with the recursive trees API. */
function fakeGithub(tree: Entry[] = PACKAGE, options: { truncated?: boolean } = {}) {
  const fetched: string[] = [];
  const raw = "https://raw.githubusercontent.com/acme/pacote/main/";
  const http = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (init?.redirect !== "error") return new Response("redirects must be refused", { status: 500 });
    if (url === "https://raw.githubusercontent.com/acme/time/main/sales.openmaus.json") return new Response(TEAM);
    if (url === "https://raw.githubusercontent.com/acme/time/feat%231/sales.openmaus.json") return new Response(TEAM);
    if (url === "https://api.github.com/repos/acme/pacote/git/trees/main?recursive=1") {
      const entries = tree.map((e) => ({ type: "blob", mode: "100644", size: 10, sha: "0", ...e }));
      return Response.json({ sha: "1", tree: entries, truncated: options.truncated ?? false });
    }
    if (url.startsWith(raw)) {
      const path = url.slice(raw.length).split("/").map(decodeURIComponent).join("/");
      if (!tree.some((e) => e.path === path)) return new Response("not found", { status: 404 });
      return new Response(path === "tenant/agents.yaml" ? AGENTS : `# ${path}`);
    }
    if (url.includes("/huge/")) return new Response("x".repeat(4 * 1024 * 1024 + 1));
    return new Response("not found", { status: 404 });
  };
  return { http: http as typeof fetch, fetched };
}

async function owner(options: Parameters<typeof createTestServer>[0]) {
  t = await createTestServer(options);
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId } = await seedOrg(b);
  const read = (url: string) => b(`/api/app/organizations/${orgId}/agent-imports/github`, { json: { url } });
  return { b, orgId, read };
}

type Files = { files: { path: string; text: string }[]; skipped?: string[] };

describe("reading a GitHub link for an import", () => {
  test("one file (a blob link) comes back as text; nothing is saved", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/time/blob/main/sales.openmaus.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ path: "sales.openmaus.json", text: TEAM }] });
    expect(gh.fetched).toEqual(["https://raw.githubusercontent.com/acme/time/main/sales.openmaus.json"]);
  });

  test("a branch whose name has # or % is read from that branch, its name still encoded", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/time/blob/feat%231/sales.openmaus.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ path: "sales.openmaus.json", text: TEAM }] });
    expect(gh.fetched).toEqual(["https://raw.githubusercontent.com/acme/time/feat%231/sales.openmaus.json"]);
  });

  test("a folder: one tree request, then only the allowlisted files, relative to the folder, memory newest first", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/pacote/tree/main/tenant");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Files;
    expect(body.files.map((f) => f.path)).toEqual([
      "CLAW.md",
      "agents.yaml",
      "model.yaml",
      "agents/README.md",
      "agents/expense-review.yaml",
      "agents/scout/AGENTS.md",
      "skills/triage/SKILL.md",
      "skills/triage/references/labels.md",
      "cron/jobs.json",
      "memory/2026-10-20.md",
      "memory/2026-10-19.md",
    ]);
    expect(body.files[1]?.text).toBe(AGENTS);
    expect(body.skipped).toBeUndefined();
    const never = [".env", "auth-profiles", "catalog", "deep", "link.md", "logo.png", "run.sh", "/other/"];
    expect(gh.fetched.filter((u) => never.some((n) => u.includes(n)))).toEqual([]);
    expect(gh.fetched.filter((u) => u.startsWith("https://api.github.com/"))).toHaveLength(1);
  });

  test("caps: 4 MB a file, 8 MB and 200 files in all; what doesn't fit is listed, not read", async () => {
    const mb = 1024 * 1024;
    const days = Array.from({ length: 205 }, (_, i) => ({ path: `memory/day-${String(i).padStart(3, "0")}.md` }));
    const tree = [
      { path: "a.md", size: 3.5 * mb },
      { path: "b.md", size: 3.5 * mb },
      { path: "big.json", size: 5 * mb },
      { path: "c.md", size: 3.5 * mb },
      ...days,
    ];
    const gh = fakeGithub(tree);
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const body = (await (await read("https://github.com/acme/pacote/tree/main")).json()) as Files;
    expect(body.files).toHaveLength(200);
    expect(body.files.slice(0, 3).map((f) => f.path)).toEqual(["a.md", "b.md", "memory/day-204.md"]);
    expect(body.skipped).toEqual([
      "big.json",
      "c.md",
      ...days
        .slice(0, 7)
        .map((d) => d.path)
        .reverse(),
    ]);
    expect(gh.fetched.some((u) => u.endsWith("/big.json") || u.endsWith("/c.md") || u.endsWith("day-006.md"))).toBe(
      false,
    );

    const truncated = fakeGithub(PACKAGE, { truncated: true });
    await t?.close();
    const again = await owner({ http: truncated.http, resolveHost: async () => ["140.82.112.3"] });
    expect((await again.read("https://github.com/acme/pacote/tree/main/tenant")).status).toBe(400);
  });

  test("only GitHub over HTTPS, public addresses, within 4 MB; signed in", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    for (const url of [
      "https://example.com/team.json",
      "http://github.com/acme/time/blob/main/sales.openmaus.json",
      "https://api.github.com/repos/acme/time/contents",
      "https://github.com.evil.example/acme/time",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect((await read(url)).status).toBe(400);
    }
    // A file type that isn't a team file or an agent definition, or where keys are kept.
    expect((await read("https://github.com/acme/time/blob/main/run.sh")).status).toBe(400);
    expect((await read("https://github.com/acme/time/blob/main/.env.json")).status).toBe(400);
    expect((await read("https://raw.githubusercontent.com/acme/huge/main/team.json")).status).toBe(400);
    expect(gh.fetched.every((u) => /^https:\/\/(raw\.githubusercontent\.com|api\.github\.com)\//.test(u))).toBe(true);

    await t?.close();
    const privateDns = await owner({ http: gh.http, resolveHost: async () => ["10.0.0.7"] });
    expect((await privateDns.read("https://github.com/acme/time/blob/main/sales.openmaus.json")).status).toBe(400);

    const anon = browser(t as TestServer);
    const res = await anon(`/api/app/organizations/${privateDns.orgId}/agent-imports/github`, {
      json: { url: "https://github.com/acme/time/blob/main/sales.openmaus.json" },
    });
    expect(res.status).toBe(401);
  });
});

/** What another app's files became in the browser: an agent, a skill, a room, a routine, a note. */
const BUNDLE = {
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "openmausbot", ref: "pkg-sales", name: "Vendas", files: ["sales.openmaus.json"] },
  agents: [
    {
      key: "scout",
      name: "Scout",
      handle: "scout",
      role: "Prospecção",
      instructions: "Ache leads.",
      model: null,
      appearance: { color: "rose" },
      skills: ["weekly"],
    },
  ],
  skills: [{ key: "weekly", markdown: "---\nname: relatorio-semanal\ndescription: Relatório semanal.\n---\nCorpo." }],
  channels: [{ key: "room", name: "vendas", topic: "Pipeline", agents: [{ key: "scout", autoReply: true }] }],
  routines: [
    {
      key: "daily",
      name: "Resumo",
      agent: "scout",
      prompt: "Resuma o pipeline.",
      channel: "room",
      trigger: { rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"], timezone: null } },
    },
  ],
  notes: [{ key: "cycle", agent: "scout", kind: "fact", content: "O ciclo de venda leva 30 dias." }],
  todo: [{ kind: "connection", label: "CRM (mcp.example.com)", agents: ["scout"] }],
  leftOut: [{ kind: "picture", label: "Scout" }],
};

type Plan = { items: { kind: string; key: string; action: string; reason?: string; targetId?: string }[] };

describe("imports and the export", () => {
  test("plan, apply, apply again; admins only; the bundle is checked", async () => {
    const { b, orgId } = await owner({});
    const imports = `/api/app/organizations/${orgId}/imports`;
    const dry = await b(imports, { json: { bundle: BUNDLE, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as Plan).items.map((i) => `${i.kind}:${i.action}`)).toEqual([
      "skill:create",
      "agent:create",
      "channel:create",
      "routine:create",
      "note:create",
    ]);
    const agents = async () =>
      (
        (await (await b(`/api/app/organizations/${orgId}/agents`)).json()) as { agents: { handle: string }[] }
      ).agents.map((a) => a.handle);
    expect(await agents()).toEqual(["dev"]);

    const applied = (await (await b(imports, { json: { bundle: BUNDLE, dryRun: false } })).json()) as Plan;
    expect(applied.items.every((i) => i.action === "create" && i.targetId)).toBe(true);
    expect(await agents()).toEqual(["dev", "scout"]);
    const routines = (await (await b(`/api/app/organizations/${orgId}/routines`)).json()) as {
      routines: { name: string; active: boolean }[];
    };
    expect(routines.routines.map((r) => [r.name, r.active])).toEqual([["Resumo", false]]);
    const again = (await (await b(imports, { json: { bundle: BUNDLE, dryRun: false } })).json()) as Plan;
    expect(again.items.map((i) => i.action)).toEqual(Array(5).fill("unchanged"));

    expect((await b(imports, { json: { bundle: { ...BUNDLE, format: "other" }, dryRun: true } })).status).toBe(400);
    expect((await b(imports, { json: { bundle: { ...BUNDLE, version: 2 }, dryRun: true } })).status).toBe(400);

    // A member: refused, the import and the export.
    const member = await joinByInvitation(t as TestServer, b, orgId, "member@example.com");
    expect((await member(imports, { json: { bundle: BUNDLE, dryRun: true } })).status).toBe(403);
    expect((await member(`/api/app/organizations/${orgId}/export`)).status).toBe(403);

    const anon = browser(t as TestServer);
    expect((await anon(imports, { json: { bundle: BUNDLE, dryRun: true } })).status).toBe(401);
    expect((await anon(`/api/app/organizations/${orgId}/export`)).status).toBe(401);
  });

  test("the export downloads as a file and imports into another workspace", async () => {
    // Two people with a workspace each (self-host and Cloud).
    const { b, orgId } = await owner({ env: { ALLOW_SIGNUP: "true" } });
    await b(`/api/app/organizations/${orgId}/imports`, {
      json: { bundle: BUNDLE, dryRun: false, enableSkills: ["skill:weekly"] },
    });
    const res = await b(`/api/app/organizations/${orgId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="agentes-chat-\d{4}-\d{2}-\d{2}\.json"/,
    );
    const exported = (await res.json()) as typeof BUNDLE & { agents: { key: string; handle: string }[] };
    expect(exported.source).toMatchObject({ app: "agenteschat", ref: orgId, name: "Acme" });
    expect(exported.agents.map((a) => a.handle)).toEqual(["dev", "scout"]);
    expect(JSON.stringify(exported).includes("sk-ant-api-secret-9876")).toBe(false);

    const other = browser(t as TestServer);
    await signUp(other, "cloud@example.com");
    const created = (await (await other("/api/app/organizations", { json: { name: "Acme Cloud" } })).json()) as {
      organization: { id: string };
    };
    const into = `/api/app/organizations/${created.organization.id}/imports`;
    const plan = (await (await other(into, { json: { bundle: exported, dryRun: false } })).json()) as Plan;
    expect(plan.items.filter((i) => i.action !== "create").map((i) => [i.kind, i.action, i.reason])).toEqual([
      ["channel", "update", "exists"],
    ]);
    const copy = (await (
      await other(`/api/app/organizations/${created.organization.id}/export`)
    ).json()) as typeof exported;
    const names = (x: typeof exported) => ({
      agents: x.agents.map((a) => a.handle),
      skills: x.skills.length,
      channels: x.channels.map((c) => c.name),
      routines: x.routines.map((r) => r.name),
      notes: x.notes.map((n) => n.content),
    });
    expect(names(copy)).toEqual(names(exported));
  });
});
