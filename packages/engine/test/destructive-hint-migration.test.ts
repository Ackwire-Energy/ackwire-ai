import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import { COMPOSIO_EXECUTOR, composioToolkitUrl } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

test("tools locked only by a server's warning are unlocked at the level they had; our verbs and Composio stay locked", async () => {
  f = await setup();
  const orgId = f.org.id;
  const connection = async (toolPrefix: string, serverUrl: string) => {
    const [c] = await f.db
      .insert(schema.connectorConnections)
      .values({ orgId, connector: `custom:${toolPrefix}`, label: toolPrefix, serverUrl, authType: "none", toolPrefix })
      .returning();
    if (!c) throw new Error("no connection");
    return c.id;
  };
  const tasks = await connection("tasks", "https://tasks.example.com/mcp");
  const drive = await connection("google_drive", composioToolkitUrl("googledrive"));
  const hinted = { suggestionReason: "destructive_hint", sensitive: true, access: "approval" };
  await f.db.insert(schema.customTools).values([
    { orgId, connectionId: tasks, name: "move_task", ...hinted },
    { orgId, connectionId: tasks, name: "task_archive", ...hinted, access: "off" },
    { orgId, connectionId: tasks, name: "task_delete", ...hinted },
    { orgId, connectionId: tasks, name: "bulkSendReminders", ...hinted },
    { orgId, connectionId: tasks, name: COMPOSIO_EXECUTOR, ...hinted },
    { orgId, connectionId: tasks, name: "remove_member", suggestionReason: "verb_sensitive", sensitive: true },
    { orgId, connectionId: drive, name: "create_permission", ...hinted },
  ]);

  await runMigration(f.db, "destructive_hint_suggests");

  const rows = await f.db.select().from(schema.customTools);
  expect(Object.fromEntries(rows.map((t) => [t.name, [t.sensitive, t.access]]))).toEqual({
    move_task: [false, "approval"],
    task_archive: [false, "off"],
    task_delete: [true, "approval"],
    bulkSendReminders: [true, "approval"],
    [COMPOSIO_EXECUTOR]: [true, "approval"],
    remove_member: [true, null],
    create_permission: [true, "approval"],
  });
});
