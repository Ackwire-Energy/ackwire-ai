import { afterEach, expect, test } from "bun:test";
import { listZip, zip } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Fake GitHub: acme/brain's archive through codeload's redirect; acme/code holds no notes; anything else is hidden. */
const http = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const archives: Record<string, Uint8Array> = {
    brain: zip([
      ["brain-main/README.md", "# Brain"],
      ["brain-main/clients/acme.md", "![logo](../img/logo.png)"],
      ["brain-main/img/logo.png", new Uint8Array([1, 2, 3])],
      // No note names these: they stay on the server, as where keys are kept does even when named.
      ["brain-main/img/unused.png", new Uint8Array([4])],
      ["brain-main/finance/report.csv", "a,b"],
      ["brain-main/secrets.txt", "KEY=1"],
      ["brain-main/notes/keys.md", "See secrets.txt and credentials.md"],
      ["brain-main/credentials.md", "KEY=1"],
      ["brain-main/.github/workflows/ci.md", "ci"],
      ["brain-main/.env", "KEY=1"],
      ["brain-main/src/run.sh", "echo"],
      ["brain-main/node_modules/pkg/README.md", "pkg"],
    ]),
    code: zip([["code-main/src/run.sh", "echo"]]),
  };
  for (const [repo, archive] of Object.entries(archives)) {
    if (url.startsWith(`https://github.com/acme/${repo}/archive/`)) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://codeload.github.com/acme/${repo}/zip/abc` },
      });
    }
    if (url === `https://codeload.github.com/acme/${repo}/zip/abc`) return new Response(archive);
  }
  return new Response("404: Not Found", { status: 404 });
}) as typeof fetch;

test("the notes behind a GitHub link come as a zip: Markdown and what it may embed, relative to the link", async () => {
  t = await createTestServer({ http, resolveHost: async () => ["140.82.112.3"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const read = (url: string) =>
    owner(`/api/app/organizations/${orgId}/wiki/import/github?url=${encodeURIComponent(url)}`);
  const paths = async (res: Response) => listZip(new Uint8Array(await res.arrayBuffer())).map((f) => f.path);

  const repository = await read("https://github.com/acme/brain");
  expect(repository.status).toBe(200);
  expect(repository.headers.get("content-type")).toBe("application/zip");
  expect(await paths(repository)).toEqual(["README.md", "clients/acme.md", "notes/keys.md", "img/logo.png"]);

  expect(await paths(await read("https://github.com/acme/brain/tree/main/clients"))).toEqual(["acme.md"]);
  expect(await paths(await read("https://github.com/acme/brain/blob/main/clients/acme.md"))).toEqual(["acme.md"]);
  expect((await read("https://github.com/acme/brain/blob/main/src/run.sh")).status).toBe(400);

  const none = await read("https://github.com/acme/code");
  expect(none.status).toBe(400);
  expect(await none.json()).toMatchObject({ error: { code: "wiki.github_no_notes" } });

  // A repository github.com hides, with no GitHub connected.
  const hidden = await read("https://github.com/acme/private");
  expect(hidden.status).toBe(400);
  expect(await hidden.json()).toMatchObject({
    error: { code: "github.repo_missing", params: { repo: "acme/private", connection: "none" } },
  });
  expect((await read("https://example.com/acme/brain")).status).toBe(400);
});
