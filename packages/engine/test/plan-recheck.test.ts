import { afterEach, expect, test } from "bun:test";
import {
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  OWN_USAGE_ID,
  PLAN_RECHECK_PROTOCOL,
  type PlanUsage,
  TOKEN_RECHECK_MS,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { planCheckedAt } from "@agenteschat/ui/plan-state";
import { recheckStuckPlans } from "../src/machine-accounts";
import type { MachineCaller, MachineStatus } from "../src/machine-hub";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * A plan stuck at its limit is read again on its computer without anyone asking: a free probe for a CLI login or a
 * key every 5 minutes, a setup token's one check on the cheapest model every 10 (protocol 62), a plan at the pause
 * line only while work waits on it. A reading with room then wakes the waits (`wakeOnRoom`, tested with it).
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const reading = (used: number, at: string, limited = false): PlanUsage => ({
  windows: [{ kind: "seven_day", usedPercent: used, resetsAt: "2030-01-04T00:00:00.000Z" }],
  ...(limited ? { limited: true } : {}),
  source: "turn",
  at,
});

async function world(protocol = MACHINE_PROTOCOL_VERSION) {
  f = await setup();
  const fx = f;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, { name: "Box" });
  const calls: { machineId: string; req: MachineRequest }[] = [];
  const hub = {
    status: async (id: string) => ({ id, online: true, protocol }) as MachineStatus,
    call: async (id: string, req: MachineRequest) => {
      calls.push({ machineId: id, req });
      return {};
    },
  } as unknown as Pick<MachineCaller, "call" | "status">;
  const account = async (usage: PlanUsage, authMethod: "cli_login" | "setup_token" = "cli_login") => {
    const id = crypto.randomUUID();
    await fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: "Claude",
      status: "active",
      authMethod,
      createdBy: fx.owner.id,
      usage,
    });
    return id;
  };
  const usageOf = async (id: string) =>
    (await fx.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, id)))[0]?.usage;
  return { fx, machineId, hub, calls, account, usageOf };
}

test("a CLI login at its limit is probed every 5 minutes, a token checked every 10, one with room never", async () => {
  const { hub, calls, account, usageOf } = await world();
  const login = await account(reading(100, ago(6 * 60_000)));
  const fresh = await account(reading(100, ago(60_000)));
  const token = await account(reading(100, ago(6 * 60_000), true), "setup_token");
  const tokenLater = await account(reading(100, ago(11 * 60_000), true), "setup_token");
  await account(reading(40, ago(60 * 60_000)));
  const asked = await recheckStuckPlans({ db: f?.db as Fixture["db"], hub }, NOW);
  expect(asked.sort()).toEqual([login, tokenLater].sort());
  expect(calls).toHaveLength(1);
  expect(calls[0]?.req).toEqual({
    op: "account",
    action: "list",
    fresh: expect.arrayContaining([login, tokenLater]),
    recheck: [tokenLater],
  });
  expect(asked).not.toContain(fresh);
  expect(asked).not.toContain(token);
  // When it was asked counts as checked: the next minute asks nothing.
  expect(planCheckedAt(await usageOf(login))).toBe(new Date(NOW).toISOString());
  expect(await recheckStuckPlans({ db: f?.db as Fixture["db"], hub }, NOW + 60_000)).toEqual([]);
  expect(await recheckStuckPlans({ db: f?.db as Fixture["db"], hub }, NOW + TOKEN_RECHECK_MS)).toContain(tokenLater);
});

test("an older runner gets the free probes only: a token there isn't asked, nor counted as checked", async () => {
  const { hub, calls, account, usageOf } = await world(PLAN_RECHECK_PROTOCOL - 1);
  const login = await account(reading(100, ago(6 * 60_000)));
  const token = await account(reading(100, ago(11 * 60_000), true), "setup_token");
  expect(await recheckStuckPlans({ db: f?.db as Fixture["db"], hub }, NOW)).toEqual([login]);
  expect(calls[0]?.req).toEqual({ op: "account", action: "list", fresh: [login] });
  expect((await usageOf(token))?.checkedAt).toBeUndefined();
});

test("at the pause line, only while work waits on that plan", async () => {
  const { fx, machineId, hub, account } = await world();
  const paused = await account(reading(96, ago(6 * 60_000)));
  expect(await recheckStuckPlans({ db: fx.db, hub }, NOW)).toEqual([]);
  await fx.db.insert(schema.agentRuns).values({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    channelId: fx.general.id,
    threadRootId: Bun.randomUUIDv7(),
    triggerMessageId: Bun.randomUUIDv7(),
    trigger: "mention",
    hop: 0,
    status: "waiting_input",
    transcript: {
      system: "",
      messages: [],
      waitingForBrain: { code: "usage_pause", waitKey: `plan:${machineId}:claude_code:${paused}` },
    },
  } as typeof schema.agentRuns.$inferInsert);
  expect(await recheckStuckPlans({ db: fx.db, hub }, NOW)).toEqual([paused]);
});

test("an offline computer is asked nothing", async () => {
  const { fx, hub, calls, account } = await world();
  await account(reading(100, ago(6 * 60_000)));
  const offline = {
    ...hub,
    status: async (id: string) => ({ id, online: false, protocol: 62 }) as MachineStatus,
  } as Pick<MachineCaller, "call" | "status">;
  expect(await recheckStuckPlans({ db: fx.db, hub: offline }, NOW)).toEqual([]);
  expect(calls).toEqual([]);
});

test("a computer's own sign-in at its limit is probed too, and stamped as checked on that computer", async () => {
  const { fx, machineId, hub, calls } = await world();
  const executors = (await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId)))[0]?.executors;
  await fx.db
    .update(schema.machines)
    .set({
      executors: {
        ...executors,
        ownUsage: { claude_code: reading(100, ago(6 * 60_000), true), codex: reading(30, ago(60 * 60_000)) },
      },
    } as Partial<typeof schema.machines.$inferInsert>)
    .where(eq(schema.machines.id, machineId));
  expect(await recheckStuckPlans({ db: fx.db, hub }, NOW)).toEqual([OWN_USAGE_ID.claude_code]);
  expect(calls[0]?.req).toEqual({ op: "account", action: "list", fresh: [OWN_USAGE_ID.claude_code] });
  const own = (await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId)))[0]?.executors
    .ownUsage;
  expect(planCheckedAt(own?.claude_code)).toBe(new Date(NOW).toISOString());
  expect(own?.codex?.checkedAt).toBeUndefined();
  expect(await recheckStuckPlans({ db: fx.db, hub }, NOW + 60_000)).toEqual([]);
});
