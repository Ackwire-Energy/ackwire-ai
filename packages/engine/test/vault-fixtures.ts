import {
  orgTopic,
  type RealtimeEvent,
  type VaultConnection as SourceConnection,
  type VaultSource,
  VaultSourceError,
  type VaultSourceItem,
} from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  createAgentRuns,
  insertMessage,
  type RoutineBrief,
  type VaultDeps,
  type VaultRun,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * The Vault's tests (ADR 0135): one workspace (Acme) with its owner Ana, Bruno (a member in "Support"), Carla (an
 * admin, so she manages credentials) and Dora (a member in no role); agents Dev and Infra; a fake password manager.
 */

/** What the fake source's token and items' values look like: tests search every output for them. */
export const SOURCE_TOKEN = "fake-token-SHOULD-NEVER-LEAK-1234";
export const SOURCE_PASSWORD = "src-password-NEVER-SHOWN-9876";

export interface FakeSource extends VaultSource {
  items: VaultSourceItem[];
  values: Map<string, string>;
  /** Thrown by the next `list` calls while set. */
  listError: VaultSourceError | Error | null;
  /** The secrets `list` and `reveal` were handed (to prove they were unsealed). */
  seenTokens: string[];
}

export function fakeSource(): FakeSource {
  const source: FakeSource = {
    kind: "fakepass",
    items: [],
    values: new Map(),
    listError: null,
    seenTokens: [],
    describe: () => ({
      kind: "fakepass",
      name: "FakePass",
      kinds: ["login", "key"],
      steps: ["Create a vault for your agents", "Paste the token here"],
      fields: [{ id: "token", kind: "secret", label: "Token", required: true }],
    }),
    connect: async (input) => {
      if (input.token !== SOURCE_TOKEN) throw new VaultSourceError("auth_failed", "The token was refused.");
      return { label: "Agents", config: { vaultId: "v1", vaultName: "Agents" }, secret: { token: input.token } };
    },
    list: async (connection: SourceConnection) => {
      source.seenTokens.push(connection.secret.token ?? "");
      if (source.listError) throw source.listError;
      return source.items.map((item) => ({ ...item }));
    },
    reveal: async (connection: SourceConnection, ref) => {
      source.seenTokens.push(connection.secret.token ?? "");
      const value = source.values.get(ref);
      if (value === undefined) throw new VaultSourceError("not_found", "It isn't there any more.");
      return value;
    },
  };
  return source;
}

export interface VaultFixture {
  f: Fixture;
  deps: VaultDeps;
  source: FakeSource;
  ana: { id: string };
  bruno: { id: string };
  carla: { id: string };
  dora: { id: string };
  supportRoleId: string;
  dev: { id: string };
  infra: { id: string };
  /** Every org event published, as sent. */
  events: RealtimeEvent[];
}

export async function vaultSetup(): Promise<VaultFixture> {
  const f = await setup();
  const bruno = await addMember(f.db, f.org.id, "member", "bruno");
  const carla = await addMember(f.db, f.org.id, "admin", "carla");
  const dora = await addMember(f.db, f.org.id, "member", "dora");
  const [support] = await f.db
    .insert(schema.orgRoles)
    .values({ orgId: f.org.id, name: "Support", position: 5 })
    .returning();
  if (!support) throw new Error("no role");
  await f.db.insert(schema.organizationMemberRoles).values({ orgId: f.org.id, userId: bruno.id, roleId: support.id });
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Ops", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: infra.id });
  const source = fakeSource();
  const deps: VaultDeps = {
    db: f.db,
    keyWrapper: f.keyWrapper,
    keyWrappers: [f.keyWrapper],
    sources: { fakepass: source },
    pubsub: f.pubsub,
  };
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
  return {
    f,
    deps,
    source,
    ana: f.owner,
    bruno,
    carla,
    dora,
    supportRoleId: support.id,
    dev: f.agent,
    infra,
    events,
  };
}

/** A run of `agentId` that `userId` asked for in #general. */
export async function runAskedBy(v: VaultFixture, agentId: string, userId: string): Promise<VaultRun> {
  const message = await insertMessage(v.f.db, {
    orgId: v.f.org.id,
    channelId: v.f.general.id,
    author: { type: "person", userId },
    body: "faz login pra mim",
  });
  const [run] = await v.f.db.transaction((tx) => createAgentRuns(tx, message, [agentId], "mention"));
  if (!run) throw new Error("no run");
  return { orgId: v.f.org.id, agentId, runId: run.id };
}

/** A routine's background run of `agentId`, set up by `creatorUserId`: nobody behind it, its creator's reach. */
export async function routineRun(v: VaultFixture, agentId: string, creatorUserId: string | null): Promise<VaultRun> {
  const brief: RoutineBrief = {
    routineId: crypto.randomUUID(),
    routineRunId: crypto.randomUUID(),
    name: "Daily check",
    creatorUserId,
    deliverTo: { channelId: v.f.general.id, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  };
  const message = await insertMessage(v.f.db, {
    orgId: v.f.org.id,
    channelId: v.f.general.id,
    author: { type: "person", userId: creatorUserId ?? v.ana.id },
    body: "Check the dashboard",
    meta: { routineBrief: brief, background: true },
  });
  const [run] = await v.f.db.transaction((tx) =>
    createAgentRuns(tx, message, [agentId], "mention", { background: true }),
  );
  if (!run) throw new Error("no run");
  return { orgId: v.f.org.id, agentId, runId: run.id };
}

/** A run nobody is behind: an agent's own message woke it. */
export async function unattendedRun(v: VaultFixture, agentId: string): Promise<VaultRun> {
  const message = await insertMessage(v.f.db, {
    orgId: v.f.org.id,
    channelId: v.f.general.id,
    author: { type: "agent", agentId: v.dev.id, runId: null, hop: 1, stretchId: null },
    body: "Checking the deploy",
  });
  const [run] = await v.f.db.transaction((tx) => createAgentRuns(tx, message, [agentId], "mention"));
  if (!run) throw new Error("no run");
  return { orgId: v.f.org.id, agentId, runId: run.id };
}

/** Everything a test can read back, as one string to search for values that must never be there. */
export async function everythingStored(v: VaultFixture): Promise<string> {
  const audit = await v.f.db.select().from(schema.auditLog);
  const uses = await v.f.db.select().from(schema.vaultUses);
  const outbox = await v.f.db.select().from(schema.outbox);
  const items = await v.f.db
    .select({
      title: schema.vaultItems.title,
      description: schema.vaultItems.description,
      username: schema.vaultItems.username,
      keyHint: schema.vaultItems.keyHint,
    })
    .from(schema.vaultItems);
  const connections = await v.f.db
    .select({ label: schema.vaultConnections.label, config: schema.vaultConnections.config })
    .from(schema.vaultConnections);
  return JSON.stringify({ audit, uses, outbox, items, connections, events: v.events });
}
