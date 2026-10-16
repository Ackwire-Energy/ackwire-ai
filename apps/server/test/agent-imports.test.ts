import { afterEach, describe, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TEAM = '{"format":"openmaus.package","version":2,"package":{}}';
const AGENTS = "agents:\n  - id: knowledge\n    name: Knowledge\n";

/** Fake GitHub: a team file, and a tenant package folder with an agents/ folder. */
function fakeGithub() {
  const fetched: string[] = [];
  const http = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (init?.redirect !== "error") return new Response("redirects must be refused", { status: 500 });
    if (url === "https://raw.githubusercontent.com/acme/time/main/sales.openmaus.json") return new Response(TEAM);
    if (url.startsWith("https://api.github.com/repos/acme/pacote/contents/tenant/agents?")) {
      return Response.json([
        { type: "file", path: "tenant/agents/expense-review.yaml", size: 30 },
        { type: "file", path: "tenant/agents/README.md", size: 10 },
      ]);
    }
    if (url.startsWith("https://api.github.com/repos/acme/pacote/contents/tenant?")) {
      return Response.json([
        { type: "file", path: "tenant/agents.yaml", size: AGENTS.length },
        { type: "file", path: "tenant/model.yaml", size: 20 },
        { type: "file", path: "tenant/logo.png", size: 2000 },
        { type: "dir", path: "tenant/agents", size: 0 },
        { type: "dir", path: "tenant/catalog", size: 0 },
      ]);
    }
    if (url.endsWith("/tenant/agents.yaml")) return new Response(AGENTS);
    if (url.endsWith("/tenant/model.yaml")) return new Response("model:\n  provider: openai\n");
    if (url.endsWith("/tenant/agents/expense-review.yaml")) return new Response("id: expense-review\n");
    if (url.endsWith("/tenant/agents/README.md")) return new Response("# One coworker per file");
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

describe("reading a GitHub link for the agent import", () => {
  test("one file (a blob link) comes back as text; nothing is saved", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/time/blob/main/sales.openmaus.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ path: "sales.openmaus.json", text: TEAM }] });
    expect(gh.fetched).toEqual(["https://raw.githubusercontent.com/acme/time/main/sales.openmaus.json"]);
  });

  test("a folder: its Markdown/JSON/YAML files and its agents/ folder (not other folders or images)", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/pacote/tree/main/tenant");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { path: string; text: string }[] };
    expect(body.files.map((f) => f.path)).toEqual([
      "agents.yaml",
      "model.yaml",
      "agents/expense-review.yaml",
      "agents/README.md",
    ]);
    expect(body.files[0]?.text).toBe(AGENTS);
    expect(gh.fetched.some((u) => u.endsWith("logo.png") || u.includes("catalog"))).toBe(false);
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
    // A file type that isn't a team file or an agent definition.
    expect((await read("https://github.com/acme/time/blob/main/run.sh")).status).toBe(400);
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
