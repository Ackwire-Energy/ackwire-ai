import { afterEach, expect, test } from "bun:test";
import { envPlatformCredentials, noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  agentAiState,
  createAgent,
  createCredential,
  createModelGateway,
  type MachineStatus,
  orgAiStatus,
  orgHasAi,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0057 §1: whether an agent has an AI to think with — a key for its model brain (`auto` checked for
 * the provider its runs would pick), or its computer brain (signed out, missing or no computer: `no_ai`
 * unless it may fall back; away: `waiting`) — and whether the organization has any. No key is decrypted.
 */

let f: Fixture;
afterEach(() => f?.close());

const statusOf = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: "m1",
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

const revokeKeys = () => f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });

test("a model brain: ready with a key of its provider, no_ai without; no key is decrypted", async () => {
  f = await setup();
  const deps = { db: f.db, gateway: f.gateway };
  expect(await agentAiState(deps, f.agent)).toEqual({ state: "ready" });
  // A gateway that can't decrypt anything (no key wrapper) still sees the key: it only checks the row exists.
  const sealed = createModelGateway({
    db: f.db,
    keyWrappers: [],
    providers: { anthropic: f.provider },
    platformCredentials: noPlatformCredentials,
  });
  expect(await agentAiState({ db: f.db, gateway: sealed }, f.agent)).toEqual({ state: "ready" });
  // The agent's own key is from another provider than its model: nothing resolves (like the gateway).
  const openai = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "openai",
    label: "oa",
    apiKey: "sk-proj-test-key-12345678",
  });
  expect(await agentAiState(deps, { ...f.agent, credentialId: openai.id })).toEqual({
    state: "no_ai",
    reason: "no_key",
  });
  await revokeKeys();
  expect(await agentAiState(deps, f.agent)).toEqual({ state: "no_ai", reason: "no_key" });
  // The platform's key (the Cloud) counts, without being fetched.
  const platform = createModelGateway({
    db: f.db,
    keyWrappers: [],
    providers: { anthropic: f.provider },
    platformCredentials: envPlatformCredentials({ anthropic: { apiKey: "sk-ant-platform-1234" } }),
  });
  expect(await agentAiState({ db: f.db, gateway: platform }, { ...f.agent, credentialId: null })).toEqual({
    state: "ready",
  });
});

test("auto: the provider its runs would pick decides, with or without a key", async () => {
  f = await setup();
  const deps = { db: f.db, gateway: f.gateway };
  // `auto` isn't in the catalog: before, every new agent read as "no AI".
  expect(await agentAiState(deps, { ...f.agent, model: "auto" })).toEqual({ state: "ready" });
  expect(await agentAiState(deps, { ...f.agent, model: "auto", credentialId: null })).toEqual({ state: "ready" });
  await revokeKeys();
  expect(await agentAiState(deps, { ...f.agent, model: "auto", credentialId: null })).toEqual({
    state: "no_ai",
    reason: "no_key",
  });
  // Only an OpenAI key: an auto agent thinks with OpenAI's line.
  await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "openai",
    label: "oa",
    apiKey: "sk-proj-test-key-12345678",
  });
  expect(await agentAiState(deps, { ...f.agent, model: "auto", credentialId: null })).toEqual({ state: "ready" });
});

test("a computer brain: signed out, missing or no computer is no_ai unless it may fall back; away is waiting", async () => {
  f = await setup();
  let status: MachineStatus | null = statusOf();
  const deps = { db: f.db, gateway: f.gateway, machines: { status: async () => status } };
  const computer = { ...f.agent, brain: "claude_code", machineId: "m1" };
  expect(await agentAiState(deps, computer)).toEqual({ state: "ready" });

  status = statusOf({ executors: { claude: { version: "2.1.300", loggedIn: false } } });
  // The model brain stands in (ADR 0032 §5)…
  expect(await agentAiState(deps, computer)).toEqual({ state: "ready" });
  // …unless the owner turned the fallback off, or it's background work.
  expect(await agentAiState(deps, { ...computer, brainFallback: false })).toEqual({
    state: "no_ai",
    reason: "not_signed_in",
  });
  const routine = {
    id: crypto.randomUUID(),
    orgId: f.org.id,
    agentId: f.agent.id,
    threadRootId: "0193dddd-0000-4000-8000-0000000000aa",
    triggerMessageId: "0193dddd-0000-4000-8000-0000000000aa",
    background: true,
  };
  expect(await agentAiState(deps, computer, routine)).toEqual({ state: "no_ai", reason: "not_signed_in" });

  await revokeKeys();
  expect(await agentAiState(deps, computer)).toEqual({ state: "no_ai", reason: "not_signed_in" });
  status = statusOf({ executors: { detectedAt: new Date().toISOString() } });
  expect(await agentAiState(deps, computer)).toEqual({ state: "no_ai", reason: "cli_missing" });
  expect(await agentAiState(deps, { ...computer, brain: "codex" })).toEqual({ state: "no_ai", reason: "cli_missing" });
  expect(await agentAiState(deps, { ...computer, machineId: null })).toEqual({ state: "no_ai", reason: "no_computer" });
  // Offline or paused is "not now": the existing waiting card, not "no AI".
  status = statusOf({ online: false });
  expect(await agentAiState(deps, computer)).toEqual({ state: "waiting" });
});

test("the organization: any agent ready or waiting; archived ones don't count", async () => {
  f = await setup();
  let status: MachineStatus | null = statusOf({ online: false });
  const deps = { db: f.db, gateway: f.gateway, machines: { status: async () => status } };
  expect(await orgAiStatus(deps, f.org.id)).toEqual({ any: true, agents: [{ agentId: f.agent.id, state: "ready" }] });

  await revokeKeys();
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Ops", instructions: "" },
    { model: "auto" },
  );
  expect(await orgAiStatus(deps, f.org.id)).toEqual({
    any: false,
    agents: [
      { agentId: f.agent.id, state: "no_ai", reason: "no_key" },
      { agentId: other.id, state: "no_ai", reason: "no_key" },
    ],
  });
  expect(await orgHasAi(deps, f.org.id)).toBe(false);

  // A computer that's asleep is not "no AI".
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: paired.machineId })
    .where(eq(schema.agents.id, other.id));
  expect((await orgAiStatus(deps, f.org.id)).agents[1]).toEqual({ agentId: other.id, state: "waiting" });
  expect(await orgHasAi(deps, f.org.id)).toBe(true);

  status = statusOf({ executors: { claude: { version: "2.1.300", loggedIn: false } } });
  expect(await orgHasAi(deps, f.org.id)).toBe(false);
  await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, other.id));
  expect(await orgAiStatus(deps, f.org.id)).toEqual({
    any: false,
    agents: [{ agentId: f.agent.id, state: "no_ai", reason: "no_key" }],
  });
});
