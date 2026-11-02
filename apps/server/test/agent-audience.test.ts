import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

type Created = { id: string; audience: { mode: string; userIds: string[] } };

test("Criar agente restricted to nobody yet: only its creator, never the whole workspace", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;

  const res = await owner(`${org}/agents`, {
    json: { name: "Rex", handle: "rex", audience: { mode: "people", userIds: [] } },
  });
  expect(res.status).toBe(201);
  const rex = (await res.json()) as Created;
  expect(rex.audience).toEqual({ mode: "people", userIds: [] });

  // Its people refused (not members): the agent exists, answering only its owner.
  const refused = await owner(`${org}/agents`, {
    json: { name: "Max", handle: "max", audience: { mode: "people", userIds: ["not-a-member"] } },
  });
  expect(refused.status).toBe(400);
  const { agents } = (await (await owner(`${org}/agents`)).json()) as {
    agents: { handle: string; audienceMode: string }[];
  };
  expect(agents.find((a) => a.handle === "max")?.audienceMode).toBe("owner");
});
