import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, MACHINE_STATS_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  buildTelemetryReport,
  createMachineHub,
  isAgentesCloud,
  type MachineHub,
  markServerStarted,
  saveHostLoad,
  setTelemetryEnabled,
  type TelemetryFacts,
  telemetrySends,
  telemetryState,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
let hub: MachineHub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
  await f?.close();
});

const HOUR = 3600_000;
const FACTS: TelemetryFacts = {
  version: "1.2.3",
  edition: "selfhost",
  install: "docker",
  os: "linux",
  arch: "x64",
  host: { size: { cpus: 2, memoryGb: 4, diskGb: 80 }, container: true },
};
const LOAD = { loadAvg: 0.42, loadPeak: 1.75, memoryAvg: 0.61, memoryPeak: 0.88, hours: 24 };
/** Words that must never leave the server, seeded below. */
const SECRET = {
  org: "Quokka Logistics",
  agent: "Wombat Helper",
  message: "the vault code is 4417-QUOKKA",
  hostname: "quokka-laptop.local",
  workspace: "/home/quokka/agentes",
  ip: "203.0.113.77",
  userAgent: "QuokkaBrowser/9.1",
  instructions: "Answer like a quokka would.",
};

/** A runner over an in-memory socket: its hello, then its pongs. */
function runner(token: string, hello: Record<string, unknown>) {
  if (!hub) throw new Error("no hub");
  const h = hub;
  const conn = h.open({ send() {}, close() {} });
  return {
    hello: () =>
      h.message(
        conn,
        JSON.stringify({
          type: "hello",
          token,
          hostname: SECRET.hostname,
          os: "linux",
          arch: "x64",
          version: "0.9.0",
          workspace: SECRET.workspace,
          exec: true,
          ...hello,
        }),
      ),
    pong: (load?: unknown) => h.message(conn, JSON.stringify({ type: "pong", at: Date.now(), load })),
  };
}

async function seed() {
  f = await setup();
  hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  const { db, org, owner, agent, general } = f;
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  await db.update(schema.organizations).set({ name: SECRET.org }).where(eq(schema.organizations.id, org.id));
  await db
    .update(schema.agents)
    .set({ name: SECRET.agent, instructions: SECRET.instructions })
    .where(eq(schema.agents.id, agent.id));
  // People: the owner was here an hour ago, Bia five days ago (her session), Caio a month and a half ago.
  const bia = await addMember(db, org.id, "member", "bia");
  const caio = await addMember(db, org.id, "member", "caio");
  await db
    .update(schema.organizationMembers)
    .set({ lastSeenAt: ago(HOUR) })
    .where(eq(schema.organizationMembers.userId, owner.id));
  await db
    .update(schema.organizationMembers)
    .set({ lastSeenAt: ago(45 * 24 * HOUR) })
    .where(eq(schema.organizationMembers.userId, caio.id));
  await db.insert(schema.sessions).values({
    id: "s-bia",
    token: "tok-bia",
    userId: bia.id,
    expiresAt: new Date(now + 24 * HOUR),
    ipAddress: SECRET.ip,
    userAgent: SECRET.userAgent,
    updatedAt: ago(5 * 24 * HOUR),
  });

  const [message] = await db
    .insert(schema.messages)
    .values({
      orgId: org.id,
      channelId: general.id,
      authorType: "person",
      authorUserId: owner.id,
      body: SECRET.message,
    })
    .returning();
  if (!message) throw new Error("no message");
  const run = async (createdAt: Date, toolCalls: number) => {
    const [r] = await db
      .insert(schema.agentRuns)
      .values({
        orgId: org.id,
        agentId: agent.id,
        channelId: general.id,
        threadRootId: message.id,
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
        status: "done",
        createdAt,
      })
      .returning();
    if (!r) throw new Error("no run");
    for (let seq = 0; seq < toolCalls; seq++) {
      await db.insert(schema.agentRunSteps).values({
        orgId: org.id,
        runId: r.id,
        seq,
        kind: "tool_call",
        data: { name: "read_file", input: { path: SECRET.workspace } },
        createdAt,
      });
    }
    await db.insert(schema.agentRunSteps).values({
      orgId: org.id,
      runId: r.id,
      seq: toolCalls,
      kind: "message",
      data: { text: SECRET.message },
      createdAt,
    });
  };
  await run(ago(HOUR), 3);
  await run(ago(2 * HOUR), 2);
  await run(ago(3 * 24 * HOUR), 7);

  const usage = (provider: string, model: string, input: number, output: number, createdAt = ago(HOUR)) => ({
    orgId: org.id,
    agentId: agent.id,
    provider,
    model,
    requestedModel: model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 100,
    cacheWriteTokens: 10,
    costNanoUsd: 1,
    createdAt,
  });
  await db
    .insert(schema.usageRecords)
    .values([
      usage("anthropic", "claude-sonnet-5-5", 1000, 200),
      usage("anthropic", "claude-sonnet-5-5", 500, 50),
      usage("claude_code", "claude-opus-5-5", 3000, 900),
      usage("moonshot", `${SECRET.agent} custom!`, 10, 1),
      usage("anthropic", "claude-sonnet-5-5", 99_999, 99_999, ago(2 * 24 * HOUR)),
    ]);
  await db.insert(schema.usageRecords).values({ ...usage("", "", 0, 0), kind: "sandbox", agentId: agent.id });

  const audit = (action: string, seconds: number, createdAt = ago(HOUR)) => ({
    orgId: org.id,
    actorType: "person",
    actorId: owner.id,
    action,
    targetType: "agent",
    targetId: agent.id,
    details: { seconds, bytesIn: 1, bytesOut: 1 },
    createdAt,
  });
  await db
    .insert(schema.auditLog)
    .values([
      audit("desktop.watched", 300),
      audit("desktop.controlled", 150),
      audit("terminal.session", 125),
      audit("desktop.watched", 9000, ago(2 * 24 * HOUR)),
    ]);

  // Computers: one with a new runner, one with an older runner, the workspace's managed one, a removed one.
  const fresh = await pairMachine({ db, pubsub: f.pubsub }, owner.id, org.id, { name: "Quokka box" });
  const old = await pairMachine({ db, pubsub: f.pubsub }, owner.id, org.id, { name: "Old box" });
  const gone = await pairMachine({ db, pubsub: f.pubsub }, owner.id, org.id, { name: "Gone box" });
  const a = runner(fresh.token, {
    protocol: MACHINE_PROTOCOL_VERSION,
    size: { cpus: 4, memoryGb: 7.5, diskGb: 150 },
  });
  await a.hello();
  await a.pong(LOAD);
  const b = runner(old.token, { protocol: MACHINE_STATS_PROTOCOL - 1, arch: "weird-arch-quokka" });
  await b.hello();
  await b.pong();
  await runner(gone.token, {
    protocol: MACHINE_PROTOCOL_VERSION,
    size: { cpus: 64, memoryGb: 256, diskGb: 4000 },
  }).hello();
  await db.update(schema.machines).set({ deletedAt: new Date() }).where(eq(schema.machines.id, gone.machineId));
  const [managed] = await db
    .insert(schema.machines)
    .values({
      orgId: org.id,
      name: "Quokka's computer",
      kind: "managed",
      os: "linux",
      arch: "x64",
      lastSeenAt: ago(HOUR),
    })
    .returning();
  if (!managed) throw new Error("no managed machine");
  await db
    .insert(schema.machineProvisioning)
    .values({ orgId: org.id, state: "ready", specs: { cpus: 4, memoryGb: 8, diskGb: 75 } });
  await db.update(schema.agents).set({ machineId: fresh.machineId }).where(eq(schema.agents.id, agent.id));

  await markServerStarted(db, ago(26.5 * HOUR));
  await saveHostLoad(db, { loadAvg: 0.3, loadPeak: 0.9, memoryAvg: 0.5, memoryPeak: 0.7, hours: 12 });
  return { now: new Date(now), fresh, old, managed, bia, caio };
}

test("the report is exactly its fields, from the seeded data, with no content in it", async () => {
  const s = await seed();
  const report = await buildTelemetryReport(f.db, FACTS, s.now);
  expect(report).toEqual({
    report: 1,
    instance: (await telemetryState(f.db)).instanceId,
    version: "1.2.3",
    edition: "selfhost",
    install: "docker",
    os: "linux",
    arch: "x64",
    uptimeHours: 26.5,
    host: {
      size: { cpus: 2, memoryGb: 4, diskGb: 80 },
      container: true,
      load: { loadAvg: 0.3, loadPeak: 0.9, memoryAvg: 0.5, memoryPeak: 0.7, hours: 12 },
    },
    organizations: 1,
    people: { total: 3, active1d: 1, active7d: 2, active30d: 2 },
    agents: 1,
    computers: [
      {
        kind: "connected",
        os: "linux",
        arch: "x64",
        size: { cpus: 4, memoryGb: 7.5, diskGb: 150 },
        agents: 1,
        load: LOAD,
      },
      { kind: "connected", os: "linux", arch: "other", size: null, agents: 0, load: null },
      { kind: "managed", os: "linux", arch: "x64", size: { cpus: 4, memoryGb: 8, diskGb: 75 }, agents: 0, load: null },
    ],
    lastDay: {
      runs: 2,
      toolCalls: 5,
      desktopMinutes: 8,
      terminalMinutes: 2,
      models: [
        { provider: "anthropic", model: "claude-sonnet-5-5", calls: 2, inputTokens: 1720, outputTokens: 250 },
        { provider: "claude_code", model: "claude-opus-5-5", calls: 1, inputTokens: 3110, outputTokens: 900 },
        { provider: "moonshot", model: "other", calls: 1, inputTokens: 120, outputTokens: 1 },
      ],
    },
  });

  const text = JSON.stringify(report);
  const ids = [f.org.id, f.owner.id, f.agent.id, f.general.id, f.credential.id, s.fresh.machineId, s.old.machineId];
  for (const leak of [
    ...Object.values(SECRET),
    ...ids,
    s.managed.id,
    s.bia.id,
    s.caio.id,
    f.owner.email,
    s.bia.email,
  ]) {
    expect(text).not.toContain(leak);
  }
  expect(text).not.toContain("@");
  expect(text.toLowerCase()).not.toContain("quokka");
});

test("an older runner's computer stays size unknown; a load older than a day says nothing", async () => {
  const s = await seed();
  await f.db
    .update(schema.machines)
    .set({ load: { ...LOAD, at: new Date(s.now.getTime() - 25 * HOUR).toISOString() } })
    .where(eq(schema.machines.id, s.fresh.machineId));
  // The older runner reconnects: nothing it says makes up a size.
  const b = runner(s.old.token, { protocol: MACHINE_STATS_PROTOCOL - 1 });
  await b.hello();
  const { computers } = await buildTelemetryReport(f.db, FACTS, s.now);
  expect(computers.map((c) => [c.size, c.load])).toEqual([
    [{ cpus: 4, memoryGb: 7.5, diskGb: 150 }, null],
    [null, null],
    [{ cpus: 4, memoryGb: 8, diskGb: 75 }, null],
  ]);
});

test("the instance id is made once and kept; the switch and the Cloud decide what goes out", async () => {
  f = await setup();
  const first = await telemetryState(f.db);
  expect(first.enabled).toBe(true);
  await markServerStarted(f.db);
  await setTelemetryEnabled(f.db, false);
  const later = await telemetryState(f.db);
  expect(later.instanceId).toBe(first.instanceId);
  expect(later.enabled).toBe(false);

  const self = { TELEMETRY: "on" as const, PUBLIC_URL: "https://chat.example.com" };
  expect(telemetrySends(self, true)).toBe(true);
  expect(telemetrySends(self, false)).toBe(false);
  expect(telemetrySends({ ...self, TELEMETRY: "off" }, true)).toBe(false);
  const cloud = { TELEMETRY: "off" as const, PUBLIC_URL: "https://agentes.chat" };
  expect(telemetrySends(cloud, false)).toBe(true);
  expect(isAgentesCloud("https://www.agentes.chat")).toBe(true);
  expect(isAgentesCloud("https://agentes.chat.example.com")).toBe(false);
  expect(isAgentesCloud("https://notagentes.chat")).toBe(false);
});
