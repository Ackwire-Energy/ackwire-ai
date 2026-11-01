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

  // A message names both: the server stores which channel each name meant.
  const posted = await api(`/channels/${vendas}/messages`, { json: { body: "de #vendas para #Diretoria" } });
  const message = (await posted.json()) as { meta: { channelRefs?: unknown } };
  expect(message.meta.channelRefs).toEqual({ vendas, diretoria });

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string) => member(`/api/app/organizations/${orgId}${path}`);
  const card = await asMember(`/channels/${vendas}/card`);
  expect(card.status).toBe(200);
  expect(await card.json()).toEqual({
    id: vendas,
    name: "vendas",
    topic: "",
    visibility: "public",
    isMember: false,
    archived: false,
    people: 1,
    agents: 0,
  });
  expect((await asMember(`/channels/${diretoria}/card`)).status).toBe(404);
  expect((await api(`/channels/${diretoria}/card`)).status).toBe(200);
});
