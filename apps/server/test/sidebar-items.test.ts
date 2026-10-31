import { afterEach, expect, test } from "bun:test";
import { SIDEBAR_COUNTED, SIDEBAR_ITEMS, type SidebarItem, sidebarPlaceAllowed } from "@agenteschat/engine";
import {
  SIDEBAR_COUNTED as APP_COUNTED,
  SIDEBAR_ITEMS as APP_ITEMS,
  SIDEBAR_DEFAULTS,
} from "../../../packages/client/src/lib/sidebar-items";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("the sidebar's tools: the engine and the apps know the same ones, and the apps' defaults are places it takes", () => {
  expect([...APP_ITEMS]).toEqual([...SIDEBAR_ITEMS]);
  expect([...APP_COUNTED]).toEqual([...SIDEBAR_COUNTED]);
  for (const [item, place] of Object.entries(SIDEBAR_DEFAULTS))
    expect(sidebarPlaceAllowed(item as SidebarItem, place)).toBe(true);
});

/** A new workspace, set up (one still in its onboarding would come back instead of another). */
async function workspace(b: ReturnType<typeof browser>, name: string) {
  const created = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
  };
  const orgId = created.organization.id;
  await b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json: { finished: true } });
  return orgId;
}

test("the sidebar's tools: each person's own, per workspace, known tools and places only", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const sidebar = `/api/app/organizations/${orgId}/me/sidebar`;
  const items = async (b = owner, path = sidebar) => ((await (await b(path)).json()) as { items: unknown }).items;

  // Nothing moved yet: every tool on the app's default.
  expect(await items()).toEqual({});

  const saved = await owner(sidebar, { method: "PUT", json: { items: { wiki: "always", approvals: "more" } } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ items: { wiki: "always", approvals: "more" } });
  expect(await items()).toEqual({ wiki: "always", approvals: "more" });

  // A tool or a place the app doesn't know, or "when there's something" for a tool with no count: refused, kept.
  for (const bad of [{ settings: "always" }, { wiki: "hidden" }, { wiki: "auto" }, { approvals: null }])
    expect((await owner(sidebar, { method: "PUT", json: { items: bad } })).status).toBe(400);
  expect(await items()).toEqual({ wiki: "always", approvals: "more" });
  expect((await owner(sidebar, { method: "PUT", json: { items: { threads: "auto" } } })).status).toBe(200);

  // Someone else in the workspace keeps their own; so does the owner in another workspace.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await items(member)).toEqual({});
  await member(sidebar, { method: "PUT", json: { items: { forum: "always" } } });
  expect(await items()).toEqual({ threads: "auto" });
  const other = await workspace(owner, "Beta");
  expect(await items(owner, `/api/app/organizations/${other}/me/sidebar`)).toEqual({});

  // "Restaurar o padrão".
  expect(await (await owner(sidebar, { method: "PUT", json: { items: {} } })).json()).toEqual({ items: {} });
  expect(await items(member)).toEqual({ forum: "always" });

  // Not a member (invited, not in yet): refused.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "stranger@example.com" } });
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(sidebar)).status).toBe(403);
  expect((await stranger(sidebar, { method: "PUT", json: { items: {} } })).status).toBe(403);
});
