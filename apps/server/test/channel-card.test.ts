import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Ok."] }) });
});
afterEach(() => t.close());

test("a #channel link's card: a public one for everyone, a private one only for its members", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = async (name: string, visibility: "public" | "private") =>
    ((await (await api("/channels", { json: { name, visibility } })).json()) as { id: string }).id;
  const vendas = await created("vendas", "public");
  const diretoria = await created("diretoria", "private");

  // A message in #vendas names both: the server stores the public one; the private one only inside itself.
  const posted = await api(`/channels/${vendas}/messages`, { json: { body: "de #vendas para #Diretoria" } });
  const message = (await posted.json()) as { meta: { channelRefs?: unknown } };
  expect(message.meta.channelRefs).toEqual({ vendas });
  const inside = await api(`/channels/${diretoria}/messages`, { json: { body: "aqui em #diretoria" } });
  expect(((await inside.json()) as { meta: { channelRefs?: unknown } }).meta.channelRefs).toEqual({ diretoria });

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string) => member(`/api/app/organizations/${orgId}${path}`);
  const card = await asMember(`/channels/${vendas}/card`);
  expect(card.status).toBe(200);
  expect(await card.json()).toEqual({
    id: vendas,
    name: "vendas",
    topic: "",
    visibility: "public",
    audienceRoleIds: [],
    isMember: false,
    archived: false,
    people: 1,
    agents: 0,
  });
  expect((await asMember(`/channels/${diretoria}/card`)).status).toBe(404);
  expect((await api(`/channels/${diretoria}/card`)).status).toBe(200);
});

test("a channel for a department: its people see it, join it and lose it with the role (ADR 0125)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const role = (await (await api("/roles", { json: { name: "Vendas" } })).json()) as { id: string };
  const created = await api("/channels", {
    json: { name: "vendas", visibility: "private", audienceRoleIds: [role.id] },
  });
  expect(created.status).toBe(201);
  const channel = (await created.json()) as { id: string; audienceRoleIds: string[] };
  expect(channel.audienceRoleIds).toEqual([role.id]);

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${orgId}${path}`, init);
  const userId = ((await (await member("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const listed = async () =>
    ((await (await asMember("/channels")).json()) as { channels: { id: string; isMember: boolean }[] }).channels
      .filter((c) => c.id === channel.id)
      .map((c) => c.isMember);

  expect(await listed()).toEqual([]);
  expect((await asMember(`/channels/${channel.id}/join`, { json: {} })).status).toBe(403);

  await api(`/members/${userId}/roles`, { method: "PUT", json: { roleIds: [role.id] } });
  expect(await listed()).toEqual([false]);
  expect((await asMember(`/channels/${channel.id}/card`)).status).toBe(200);
  expect((await asMember(`/channels/${channel.id}/join`, { json: {} })).status).toBe(204);
  expect(await listed()).toEqual([true]);

  await api(`/members/${userId}/roles`, { method: "PUT", json: { roleIds: [] } });
  expect(await listed()).toEqual([]);
  expect((await asMember(`/channels/${channel.id}/messages`)).status).toBe(403);

  // Changed later by its creator: back to invite only.
  const patched = await api(`/channels/${channel.id}`, { method: "PATCH", json: { audienceRoleIds: [] } });
  expect(((await patched.json()) as { audienceRoleIds: string[] }).audienceRoleIds).toEqual([]);
});
