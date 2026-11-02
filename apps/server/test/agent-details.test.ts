import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

type ListedAgent = { id: string; handle: string; instructions: string; seesDetails: boolean; canTalk: boolean };

const DETAIL_READS = [
  "access",
  "approval-rules",
  "databases",
  "learned-skills",
  "mail",
  "memories",
  "repositories",
  "scopes",
  "skills",
  "usage",
];

test("someone an agent doesn't answer sees only its public card, on every route that says how it works", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;

  const made = await owner(`${org}/agents`, {
    json: {
      name: "Rex",
      handle: "rex",
      instructions: "The pricing table lives in sheet 4.",
      audience: { mode: "owner", userIds: [] },
    },
  });
  expect(made.status).toBe(201);
  const rex = (await made.json()) as { id: string };
  const open = await owner(`${org}/agents`, {
    json: { name: "Ana", handle: "ana", instructions: "Answer support questions." },
  });
  const ana = (await open.json()) as { id: string };

  // The list: Rex's card without its instructions; Ana, who answers everyone, as before.
  const listed = ((await (await bia(`${org}/agents`)).json()) as { agents: ListedAgent[] }).agents;
  const rexListed = listed.find((a) => a.id === rex.id);
  expect(rexListed?.seesDetails).toBe(false);
  expect(rexListed?.instructions).toBe("");
  expect(listed.find((a) => a.id === ana.id)?.instructions).toBe("Answer support questions.");
  expect(listed.find((a) => a.id === ana.id)?.seesDetails).toBe(true);

  // Its page: the public card, no instructions or month.
  const detail = (await (await bia(`${org}/agents/${rex.id}`)).json()) as {
    instructions: string;
    seesDetails: boolean;
    channels: unknown[];
  };
  expect(detail.seesDetails).toBe(false);
  expect(detail.instructions).toBe("");
  expect(Array.isArray(detail.channels)).toBe(true);

  // The Team page's card: no capabilities.
  const team = (await (await bia(`${org}/team`)).json()) as {
    agents: { id: string; capabilities: string[]; seesDetails: boolean }[];
  };
  expect(team.agents.find((a) => a.id === rex.id)?.seesDetails).toBe(false);
  expect(team.agents.find((a) => a.id === rex.id)?.capabilities).toEqual([]);

  for (const part of DETAIL_READS) {
    const res = await bia(`${org}/agents/${rex.id}/${part}`);
    expect({ part, status: res.status }).toEqual({ part, status: 403 });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent.details_hidden");
  }
  // What it learned from her is still hers to see.
  expect((await bia(`${org}/agents/${rex.id}/memories?about=me`)).status).toBe(200);
  // Ana answers her: her tools and memory are open to her.
  expect((await bia(`${org}/agents/${ana.id}/access`)).status).toBe(200);
  expect((await bia(`${org}/agents/${ana.id}/memories`)).status).toBe(200);
  // Its owner sees everything.
  expect((await owner(`${org}/agents/${rex.id}/access`)).status).toBe(200);
  const own = (await (await owner(`${org}/agents/${rex.id}`)).json()) as { instructions: string; seesDetails: boolean };
  expect(own).toMatchObject({ instructions: "The pricing table lives in sheet 4.", seesDetails: true });

  // Let into its audience, she reads how it works.
  const me = (await (await bia("/api/app/me")).json()) as { user: { id: string } };
  const widened = await owner(`${org}/agents/${rex.id}`, {
    method: "PATCH",
    json: { audience: { mode: "people", userIds: [me.user.id] } },
  });
  expect(widened.status).toBe(200);
  expect((await bia(`${org}/agents/${rex.id}/access`)).status).toBe(200);
  const now = (await (await bia(`${org}/agents/${rex.id}`)).json()) as { instructions: string };
  expect(now.instructions).toBe("The pricing table lives in sheet 4.");
});

test("an admin who isn't in the audience still sees every detail", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const admin = await joinByInvitation(t, owner, orgId, "admin@example.com", { role: "admin" });
  const org = `/api/app/organizations/${orgId}`;
  const rex = (await (
    await owner(`${org}/agents`, {
      json: { name: "Rex", handle: "rex", instructions: "Private notes.", audience: { mode: "owner", userIds: [] } },
    })
  ).json()) as { id: string };
  const listed = ((await (await admin(`${org}/agents`)).json()) as { agents: ListedAgent[] }).agents;
  expect(listed.find((a) => a.id === rex.id)).toMatchObject({ seesDetails: true, instructions: "Private notes." });
  expect((await admin(`${org}/agents/${rex.id}/access`)).status).toBe(200);
});

test("what the agents know of the workspace is only for who configures it", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;

  const mine = (await (await owner(`${org}/settings`)).json()) as { context: string };
  expect(mine.context).toBe("Acme builds rockets.");
  const hers = (await (await bia(`${org}/settings`)).json()) as { context: string; timezone: string };
  expect(hers.context).toBe("");
  expect(typeof hers.timezone).toBe("string");
  const summary = (await (await bia(org)).json()) as { context: string };
  expect(summary.context).toBe("");
  expect(((await (await owner(org)).json()) as { context: string }).context).toBe("Acme builds rockets.");
  // Changing it stays admins'.
  expect((await bia(`${org}/settings`, { method: "PATCH", json: { context: "x" } })).status).toBe(403);
});
