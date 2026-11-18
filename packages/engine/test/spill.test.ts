import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  COMPUTER_BUSY_RETRY_MS,
  clearPlanLimits,
  createAgent,
  createJobHandlers,
  drainOutbox,
  getAgent,
  type MachineStatus,
  postPersonMessage,
  resolveBrain,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * Spill-over: while the agent's own computer is full, a person's first turn thinks on another online computer of the
 * workspace that allows it, in a fresh session there, and later turns at home never resume that session.
 */

let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  return f?.close();
});

const RUNNER = { os: "darwin" as const, arch: "arm64", version: "0.8.0", protocol: MACHINE_PROTOCOL_VERSION };

const statusOf = (id: string): MachineStatus => ({
  id,
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

async function pair(userId: string, name: string) {
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, {
    name,
    hostname: name,
    ...RUNNER,
    exec: true,
  });
  await f.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machineId));
  return machineId;
}

/** The agent thinks with Claude Code on `home`, where a person's turn already waits for room. */
async function fullHome() {
  const home = await pair(f.owner.id, "home");
  await f.db
    .update(schema.agents)
    .set({ machineId: home, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  // Another agent's: a person's message for ours would join a run of its own in the conversation.
  const rio = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Rio", handle: "rio", role: "Dev", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.update(schema.agents).set({ machineId: home, brain: "claude_code" }).where(eq(schema.agents.id, rio.id));
  // No key the API could answer with: nothing stands in.
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const id = Bun.randomUUIDv7();
  await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: rio.id,
    channelId: f.general.id,
    threadRootId: id,
    triggerMessageId: id,
    trigger: "mention",
    hop: 1,
    status: "waiting_input",
    waitingMachineId: home,
    transcript: {
      waitingForBrain: { kind: "claude_code", machineId: home, code: "busy", waitId: Bun.randomUUIDv7() },
      roomPeople: true,
      roomWaitSince: Date.now() - 60_000,
    },
  });
  return home;
}

function brainSeeing() {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push(turn);
      yield { type: "usage", input: 10, output: 2, source: "plan" } as BrainEvent;
      yield { type: "done", text: "Pronto." } as BrainEvent;
    },
  };
  return { brain, seen };
}

const ask = async () => {
  const { brain, seen } = brainSeeing();
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, handlers);
  const all = await f.db.select().from(schema.agentRuns);
  const run = all.find((r) => r.triggerMessageId === asked.id);
  return { run, seen, handlers };
};

test("a full computer: the person's turn thinks on their own laptop, fresh there; home never resumes that session", async () => {
  f = await setup();
  const home = await fullHome();
  const laptop = await pair(f.owner.id, "laptop");
  const { run, seen } = await ask();
  expect(run?.status).toBe("done");
  expect(seen.map((t) => t.session?.machineId)).toEqual([laptop]);
  expect(seen[0]?.session?.resume).toBe(false);
  expect(run?.transcript).toMatchObject({ spill: { from: home, to: laptop } });

  // Another run in that conversation, at home: a session of its own, not the one on the laptop.
  const [next] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: run?.threadRootId as string,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "mention",
      hop: 1,
    })
    .returning();
  const agent = await getAgent(f.db, f.org.id, f.agent.id);
  if (!agent || !next) throw new Error("no agent");
  const plan = await resolveBrain(
    { db: f.db, machines: { status: async (id) => statusOf(id) } },
    agent,
    next,
    run?.threadRootId as string,
  );
  expect(plan.session?.machineId).toBe(home);
  expect(plan.session?.id).not.toBe(run?.brainSessionId);
});

test("no spill-over where its owner turned it off, nor to someone else's computer unless they let others in", async () => {
  f = await setup();
  const home = await fullHome();
  const laptop = await pair(f.owner.id, "laptop");
  await f.db.update(schema.machines).set({ spillOwn: false }).where(eq(schema.machines.id, laptop));
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const theirs = await pair(rui.id, "theirs");
  // The agent's owner has a sign-in on it: only the switch keeps the turn off it.
  await f.db.insert(schema.machineAccounts).values({
    orgId: f.org.id,
    machineId: theirs,
    id: Bun.randomUUIDv7(),
    kind: "claude_code",
    label: "Ana's Claude",
    createdBy: f.owner.id,
  });
  const first = await ask();
  expect(first.run?.status).toBe("waiting_input");
  expect(first.run?.waitingMachineId).toBe(home);
  expect(first.seen).toEqual([]);

  // Let in, the turn waiting behind the other agent's looks again and thinks there, on the owner's sign-in.
  await f.db
    .update(schema.machines)
    .set({ spillOthers: true, audienceMode: "everyone" })
    .where(eq(schema.machines.id, theirs));
  await drainOutbox(f.db, first.handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, first.run?.id ?? ""));
  expect(run?.status).toBe("done");
  expect(first.seen.map((t) => t.session?.machineId)).toEqual([theirs]);
  expect(first.seen[0]?.account?.label).toBe("Ana's Claude");
});
