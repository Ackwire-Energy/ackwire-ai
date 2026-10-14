import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeS3 } from "@agenteschat/adapters";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

const SECRET = "secret-test-key-123456";
let t: TestServer;
let s3: ReturnType<typeof createFakeS3>;
beforeEach(async () => {
  s3 = createFakeS3({
    host: "s3.example.com",
    region: "auto",
    accessKeyId: "AKIATEST",
    secretAccessKey: SECRET,
    buckets: ["acme"],
  });
  t = await createTestServer({ s3Fetch: s3.fetch, resolveHost: async () => ["93.184.216.34"] });
});
afterEach(() => t.close());

const settings = {
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "acme",
  prefix: null,
  pathStyle: true,
  accessKeyId: "AKIATEST",
  secretAccessKey: SECRET,
};

test("storage API: masked settings, test before switching, migrate", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  expect(await (await api("/storage")).json()).toEqual({ kind: "agentes", s3: null, migration: null });
  const refused = await api("/storage", { method: "PUT", json: { kind: "s3", s3: settings } });
  expect(refused.status).toBe(400);
  const tested = (await (await api("/storage/test", { json: settings })).json()) as { ok: boolean };
  expect(tested.ok).toBe(true);
  const saved = await api("/storage", { method: "PUT", json: { kind: "s3", s3: settings } });
  expect(saved.status).toBe(200);
  const body = await saved.text();
  expect(body).not.toContain(SECRET);
  expect(JSON.parse(body)).toMatchObject({ kind: "s3", s3: { bucket: "acme", secretHint: "••••3456" } });

  const migration = await api("/storage/migrate", { json: {} });
  expect(await migration.json()).toMatchObject({ status: "running", total: 0 });
  await t.drain();
  expect(await (await api("/storage/migration")).json()).toMatchObject({ status: "done" });

  const ssrf = (await (
    await api("/storage/test", { json: { ...settings, endpoint: "https://169.254.169.254" } })
  ).json()) as { ok: boolean; steps: { error: string | null }[] };
  expect(ssrf.ok).toBe(false);
  expect(ssrf.steps[0]?.error).toContain("rede interna");
});

test("Drive API: create, new version, versions, download link, file, delete", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/artifacts", {
    json: { title: "Metas", content: { kind: "table", columns: ["mês", "meta"], rows: [["jan", "10"]] } },
  });
  expect(created.status).toBe(201);
  const a = (await created.json()) as { id: string; version: number; canEdit: boolean };
  expect(a).toMatchObject({ version: 1, canEdit: true });

  const v2 = await api(`/artifacts/${a.id}/versions`, {
    json: { content: { kind: "table", columns: ["mês", "meta"], rows: [["fev", "12"]] }, baseVersion: 1, note: "fev" },
  });
  expect(v2.status).toBe(200);
  const stale = await api(`/artifacts/${a.id}/versions`, {
    json: { content: { kind: "table", columns: ["mês"], rows: [] }, baseVersion: 1 },
  });
  expect(stale.status).toBe(409);
  const versions = (await (await api(`/artifacts/${a.id}/versions`)).json()) as { versions: { note: string | null }[] };
  expect(versions.versions.map((v) => v.note)).toEqual(["fev", null]);
  const old = (await (await api(`/artifacts/${a.id}?version=1`)).json()) as { content: { rows: string[][] } };
  expect(old.content.rows).toEqual([["jan", "10"]]);

  const list = (await (await api("/artifacts?kind=table")).json()) as { artifacts: { id: string }[] };
  expect(list.artifacts.map((x) => x.id)).toEqual([a.id]);
  const link = (await (await api(`/artifacts/${a.id}/download`)).json()) as { url: string; expiresAt: string };
  expect(link.url).toContain("memory://");
  const csv = await api(`/artifacts/${a.id}/file?format=csv`);
  expect(csv.headers.get("content-disposition")).toContain("attachment");
  expect(await csv.text()).toBe("mês,meta\r\nfev,12");

  const html = (await (
    await api("/artifacts", { json: { title: "Página", content: { kind: "html", html: "<script>x</script>" } } })
  ).json()) as { id: string; untrusted: boolean; canEdit: boolean };
  expect(html).toMatchObject({ untrusted: true, canEdit: false });
  const page = await api(`/artifacts/${html.id}/file`);
  expect(page.headers.get("content-disposition")).toContain("attachment");
  expect(page.headers.get("content-security-policy")).toBe("sandbox");

  expect((await api(`/artifacts/${a.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await api(`/artifacts/${a.id}`)).status).toBe(404);
});
