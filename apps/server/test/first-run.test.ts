import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/* The right hand's first run over HTTP (ADR 0153 §6): the checklist it starts with, a stored skip, a template's team in one call. */

let t: TestServer;
afterEach(() => t.close());

interface AgentRow {
  id: string;
  handle: string;
  builtin: string | null;
  setup: { role: string | null; done: string[] } | null;
}

test("a new workspace's right hand starts the checklist; only Agora não is stored; Criar o time makes the team at once", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const created = (await (await owner("/api/app/organizations", { json: { name: "Acme" } })).json()) as {
    organization: { id: string };
  };
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${created.organization.id}${path}`, init);
  const list = async () => ((await (await api("/agents")).json()) as { agents: AgentRow[] }).agents;

  const [lodi] = await list();
  expect(lodi).toMatchObject({ builtin: "right_hand", setup: { role: null, done: [] } });

  const skipped = await api(`/agents/${lodi?.id}/setup/apps`, { json: {} });
  expect(skipped.status).toBe(200);
  expect(((await skipped.json()) as AgentRow).setup?.done).toEqual(["apps"]);
  // The other rows read done from the data: nothing to store.
  expect((await api(`/agents/${lodi?.id}/setup/about`, { json: {} })).status).toBe(404);

  const used = await api("/team-templates/clinic/use", { json: { locale: "pt-BR" } });
  expect(used.status).toBe(200);
  const card = (await used.json()) as { channelId: string; state: string; error: unknown };
  expect(card).toMatchObject({ state: "created", error: null });
  expect((await list()).filter((a) => !a.builtin).length).toBeGreaterThan(1);

  // One message in the DM, the created card: no question after it.
  const messages = (await (await api(`/channels/${card.channelId}/messages`)).json()) as {
    messages: { meta: Record<string, unknown> | null }[];
  };
  expect(messages.messages.length).toBe(1);
  expect(messages.messages.some((m) => m.meta?.replyChips)).toBe(false);
});
