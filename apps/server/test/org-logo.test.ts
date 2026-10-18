import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

/** Smallest JPEG-shaped bytes (SOI, EXIF, scan, EOI). */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9,
]);
const image = { imageBase64: Buffer.from(JPEG).toString("base64"), contentType: "image/jpeg" };

/** Someone who joins the organization through an invite link (a plain member). */
async function member(owner: ReturnType<typeof browser>, orgId: string, email: string) {
  const res = await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} });
  const token = ((await res.json()) as { url: string }).url.split("/invite/")[1] ?? "";
  const b = browser(t);
  await signUp(b, email, { inviteToken: token });
  expect((await b(`/api/app/invitations/${token}/accept`, { json: {} })).status).toBe(200);
  return b;
}

test("workspace logo: admins upload and remove it; members see it; strangers don't", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const logoApi = `/api/app/organizations/${orgId}/logo`;

  // Only real JPEG/PNG/WebP bytes.
  const bad = await owner(logoApi, {
    method: "PUT",
    json: { imageBase64: Buffer.from("<svg/>").toString("base64"), contentType: "image/jpeg" },
  });
  expect(bad.status).toBe(400);

  const put = await owner(logoApi, { method: "PUT", json: image });
  expect(put.status).toBe(200);
  const { logo } = (await put.json()) as { logo: string };
  expect(logo).toStartWith(`/api/app/org-logos/${orgId}/`);

  // On the organization and in /me; served without metadata.
  const org = (await (await owner(`/api/app/organizations/${orgId}`)).json()) as { logo: string | null };
  expect(org.logo).toBe(logo);
  const me = (await (await owner("/api/app/me")).json()) as { organizations: { id: string; logo: string | null }[] };
  expect(me.organizations.find((o) => o.id === orgId)?.logo).toBe(logo);
  const served = await owner(logo);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
  expect(Buffer.from(new Uint8Array(await served.arrayBuffer())).includes(Buffer.from("Exif"))).toBe(false);

  // A member sees it but can't change it.
  const ana = await member(owner, orgId, "ana@example.com");
  expect((await ana(logo)).status).toBe(200);
  expect((await ana(logoApi, { method: "PUT", json: image })).status).toBe(403);
  expect((await ana(logoApi, { method: "DELETE" })).status).toBe(403);

  // Signed-out people and people outside the organization can't fetch it.
  expect((await t.app.request(logo)).status).toBe(401);
  const res = await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} });
  const token = ((await res.json()) as { url: string }).url.split("/invite/")[1] ?? "";
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com", { inviteToken: token });
  expect((await stranger(logo)).status).toBe(404);

  // Removed: back to the agent mark.
  expect((await owner(logoApi, { method: "DELETE" })).status).toBe(204);
  const after = (await (await owner(`/api/app/organizations/${orgId}`)).json()) as { logo: string | null };
  expect(after.logo).toBeNull();
});

test("the logo for a connected computer: machine token, ETag/304, 404 without one, 401 once removed", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const computer = { hostname: "mac", os: "darwin", arch: "arm64", version: "0.1.0", protocol: 10, exec: false };
  const { machineId, token } = await pairComputer(t, api, computer);
  const fetchLogo = (headers: Record<string, string> = {}) =>
    t.app.request("/api/machines/org-logo", { headers: { authorization: `Bearer ${token}`, ...headers } });

  expect((await t.app.request("/api/machines/org-logo")).status).toBe(401);
  const forged = await t.app.request("/api/machines/org-logo", { headers: { authorization: "Bearer agm_nope" } });
  expect(forged.status).toBe(401);
  expect((await fetchLogo()).status).toBe(404);

  const put = await owner(`/api/app/organizations/${orgId}/logo`, { method: "PUT", json: image });
  const { logo } = (await put.json()) as { logo: string };
  const res = await fetchLogo();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/jpeg");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("private, max-age=300");
  const etag = res.headers.get("etag") ?? "";
  expect(etag).toBe(`"${logo.split("/").pop()}"`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  const same = await fetchLogo({ "if-none-match": etag });
  expect(same.status).toBe(304);
  expect(same.headers.get("etag")).toBe(etag);
  expect((await fetchLogo({ "if-none-match": '"0000000000000000.jpg"' })).status).toBe(200);

  // Removed logo → 404; removed computer → 401.
  expect((await owner(`/api/app/organizations/${orgId}/logo`, { method: "DELETE" })).status).toBe(204);
  expect((await fetchLogo()).status).toBe(404);
  expect((await api(`/machines/${machineId}`, { method: "DELETE" })).status).toBe(204);
  expect((await fetchLogo()).status).toBe(401);
});
