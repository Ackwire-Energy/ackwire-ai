import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { decideApproval, drainOutbox, listApprovals, missingPermissions, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** Asks for the browser for "open the site"; says what came back. */
const reply = (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: [last.includes("Turned on") ? "Ligado." : "Sem navegador."] };
  if (last.includes("open the site"))
    return {
      chunks: [],
      toolUses: [
        { name: "request_permission", input: { permission: "browser:use", reason: "Open the landing page." } },
      ],
    };
  return { chunks: ["Feito."] };
};

const scopes = async () =>
  (
    await f.db
      .select({ scope: schema.agentScopes.scope })
      .from(schema.agentScopes)
      .where(eq(schema.agentScopes.agentId, f.agent.id))
  ).map((s) => s.scope);

test("a missing permission becomes an approval card; approving turns it on and the run goes on", async () => {
  f = await setup({ permissionTools: true, reply });
  expect((await missingPermissions({ db: f.db, orgId: f.org.id, agentId: f.agent.id })).map((m) => m.id)).toContain(
    "browser:use",
  );
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(approval).toMatchObject({ tool: "request_permission", title: "Turn on: Use a browser" });
  expect(approval?.detail).toBe("Open the landing page.");
  expect(await scopes()).not.toContain("browser:use");

  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, f.handlers);

  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(await scopes()).toContain("browser:use");
  expect((await missingPermissions({ db: f.db, orgId: f.org.id, agentId: f.agent.id })).map((m) => m.id)).not.toContain(
    "browser:use",
  );
});

test("refused: nothing is turned on", async () => {
  f = await setup({ permissionTools: true, reply });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "refuse",
  });
  await drainOutbox(f.db, f.handlers);
  expect(await scopes()).not.toContain("browser:use");
});
