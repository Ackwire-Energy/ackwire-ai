import { afterEach, expect, test } from "bun:test";
import { zip } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const skill = (name: string) => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n# ${name}`;

/**
 * Fake GitHub: acme/skills' archive (two skills, deflated as codeload sends them) through codeload's redirect.
 * `limited`: every answer is GitHub limiting us.
 */
function fakeGithub() {
  const archive = zip([
    ["skills-main/skills/deploy/SKILL.md", skill("deploy")],
    ["skills-main/skills/review/SKILL.md", skill("review")],
  ]);
  const gh = { fetched: [] as string[], limited: false };
  const http = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    gh.fetched.push(url);
    if (gh.limited) return new Response("", { status: 429, headers: { "retry-after": "90" } });
    if (url.startsWith("https://github.com/acme/skills/archive/")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/skills/zip/abc" },
      });
    }
    if (url === "https://codeload.github.com/acme/skills/zip/abc") return new Response(archive);
    return new Response("404: Not Found", { status: 404 });
  }) as typeof fetch;
  return Object.assign(gh, { http });
}

test("a link holding several skills answers with them, the picked ones install, a skill's folder installs at once", async () => {
  const gh = fakeGithub();
  t = await createTestServer({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId } = await seedOrg(b);
  const importing = (json: unknown) => b(`/api/app/organizations/${orgId}/skills/import`, { json });

  const listed = await importing({ url: "https://github.com/acme/skills" });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    choices: [
      { path: "skills/deploy", name: "deploy", description: "Use for deploy." },
      { path: "skills/review", name: "review", description: "Use for review." },
    ],
  });
  const picked = await importing({ url: "https://github.com/acme/skills", paths: ["skills/review"] });
  expect(picked.status).toBe(201);
  expect(((await picked.json()) as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual(["review"]);
  const one = await importing({ url: "https://github.com/acme/skills/tree/main/skills/deploy" });
  expect(one.status).toBe(201);
  expect(await one.json()).toMatchObject({ name: "deploy", version: 1, source: "url" });
  expect(gh.fetched.filter((u) => !/^https:\/\/(github|codeload\.github)\.com\//.test(u))).toEqual([]);

  // GitHub limiting this server: a 429 that says in how many minutes to try again.
  gh.limited = true;
  const limited = await importing({ url: "https://github.com/acme/skills" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: { code: "github.limited", params: { count: 2 } } });
});
