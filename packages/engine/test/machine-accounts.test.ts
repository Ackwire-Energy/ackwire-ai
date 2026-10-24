import { afterEach, expect, test } from "bun:test";
import {
  ACCOUNT_LOGIN_TTL_MS,
  ACCOUNTS_PROTOCOL,
  accountCodeAad,
  BRAIN_PROTOCOL,
  generateSecretKeyPair,
  type MachineRequest,
  openSecret,
  type RunnerAccountInfo,
  sealSecret,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  accountLoginStatus,
  beginAccountLogin,
  ConflictError,
  cancelAccountLogin,
  createMachineHub,
  ForbiddenError,
  getAgentBrain,
  getMachineAccounts,
  listMachineAccounts,
  type MachineHub,
  MachineOfflineError,
  type MachineStatus,
  NotFoundError,
  removeMachineAccount,
  renameMachineAccount,
  sendAccountLoginCode,
  setAgentBrain,
  setAgentComputerTarget,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0041: accounts of the computer brains on a connected computer. The
 * runner's hello keeps the rows in sync; only the person who connected the
 * computer signs accounts in, renames and removes them, and picks one for an
 * agent; the account must be on the agent's computer and of its brain's kind.
 */

let f: Fixture;
const hubs: MachineHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const CLAUDE_ID = "0193dddd-0000-4000-8000-000000000001";
const CODEX_ID = "0193dddd-0000-4000-8000-000000000002";
const RUNNER = { hostname: "mac", os: "darwin", arch: "arm64", version: "0.9.0", workspace: "/Users/a/agentes" };

/** A computer the fixture's owner connected, on a runner that knows accounts (Claude Code and Codex on it). */
async function ownedMachine(protocol = ACCOUNTS_PROTOCOL) {
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "mac",
    ...RUNNER,
    protocol,
    exec: true,
  });
  await f.db
    .update(schema.machines)
    .set({
      protocol,
      executors: {
        claude: { version: "2.1.304", loggedIn: true },
        codex: { version: "codex-cli 0.170.0" },
        detectedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.machines.id, paired.machineId));
  return paired;
}

async function addAccount(machineId: string, id: string, kind: "claude_code" | "codex", over = {}) {
  await f.db.insert(schema.machineAccounts).values({
    id,
    orgId: f.org.id,
    machineId,
    kind,
    label: kind === "codex" ? "Codex" : "Trabalho",
    email: kind === "codex" ? null : "ana@example.com",
    status: "active",
    ...over,
  });
}

const agentRow = async () => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!row) throw new Error("no agent");
  return row;
};

const accountRows = (machineId: string) =>
  f.db
    .select()
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, f.org.id), eq(schema.machineAccounts.machineId, machineId)))
    .orderBy(schema.machineAccounts.createdAt, schema.machineAccounts.id);

/** A hub stand-in: the machine's status and the runner's answers to `op: "account"`. */
function fakeHub(
  machineId: string,
  answer: (req: Extract<MachineRequest, { op: "account" }>) => unknown | Promise<unknown>,
  over: Partial<MachineStatus> = {},
) {
  const calls: Extract<MachineRequest, { op: "account" }>[] = [];
  const hub = {
    status: async (): Promise<MachineStatus> => ({
      id: machineId,
      orgId: f.org.id,
      name: "mac",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: ACCOUNTS_PROTOCOL,
      executors: {},
      ...over,
    }),
    call: async (_id: string, req: MachineRequest) => {
      if (req.op !== "account") throw new Error(`unexpected ${req.op}`);
      calls.push(req);
      return (await answer(req)) as never;
    },
  };
  return { deps: { db: f.db, pubsub: f.pubsub, hub }, calls };
}

test("hello.accounts: new accounts are added, known ones refreshed, missing ones removed (their agents released)", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine();
  const hello = async (accounts: RunnerAccountInfo[], protocol = ACCOUNTS_PROTOCOL) => {
    const conn = hub.open({ send() {}, close() {} });
    await hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, protocol, exec: true, accounts }));
  };

  await hello([
    { id: CLAUDE_ID, kind: "claude_code", loggedIn: true, email: "ana@example.com", plan: "max" },
    { id: CODEX_ID, kind: "codex", loggedIn: false },
  ]);
  let rows = await accountRows(machineId);
  expect(rows.map((r) => [r.id, r.kind, r.label, r.email, r.plan, r.status, r.createdBy])).toEqual([
    [CLAUDE_ID, "claude_code", "Claude Max", "ana@example.com", "max", "active", null],
    [CODEX_ID, "codex", "Codex", null, null, "signed_out", null],
  ]);

  // An agent thinks with the Claude account; the computer no longer has it.
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  expect((await listMachineAccounts({ db: f.db }, f.org.id, machineId))[0]?.usedBy).toEqual(["Dev"]);
  await renameMachineAccount({ db: f.db }, f.owner.id, f.org.id, machineId, CODEX_ID, "Pessoal");
  await hello([{ id: CODEX_ID, kind: "codex", loggedIn: true, email: "ana@example.com", plan: "plus" }]);
  rows = await accountRows(machineId);
  // The name people gave it stays; what the CLI says is refreshed.
  expect(rows.map((r) => [r.id, r.label, r.email, r.plan, r.status])).toEqual([
    [CODEX_ID, "Pessoal", "ana@example.com", "plus", "active"],
  ]);
  expect((await agentRow()).brainAccountId).toBeNull();

  // A runner that says nothing about accounts (an older one) changes nothing.
  await hello([], ACCOUNTS_PROTOCOL - 1);
  expect((await accountRows(machineId)).length).toBe(1);
});

test("signing in: only the person who connected the computer; the code is sealed to it; done stores the account once", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const keys = new Map<string, string>();
  let opened: string | null = null;
  let state: "waiting" | "done" = "waiting";
  const { deps, calls } = fakeHub(machineId, async (req) => {
    if (req.action === "begin") {
      const pair = await generateSecretKeyPair();
      keys.set(req.loginId, pair.privateKey);
      return { url: "https://claude.ai/oauth/authorize?code=true", publicKey: pair.publicKey };
    }
    if (req.action === "code") {
      opened = await openSecret(keys.get(req.loginId) ?? "", req.box, req.aad);
      state = "done";
      return {};
    }
    if (req.action === "status") {
      return state === "done"
        ? {
            state,
            account: { id: req.loginId, kind: "claude_code", loggedIn: true, email: "ana@example.com", plan: "max" },
          }
        : { state };
    }
    return {};
  });

  // Not the owner (an admin either): refused before anything reaches the computer.
  const notOwner = await beginAccountLogin(deps, admin.id, f.org.id, machineId, "claude_code").catch((e) => e);
  expect(notOwner).toBeInstanceOf(ForbiddenError);
  expect(notOwner.code).toBe("account.not_owner");
  expect(calls).toEqual([]);
  expect(await beginAccountLogin(deps, f.owner.id, f.org.id, machineId, "gemini").catch((e) => e)).toBeInstanceOf(
    ValidationError,
  );

  const before = Date.now();
  const login = await beginAccountLogin(deps, f.owner.id, f.org.id, machineId, "claude_code");
  expect(login).toMatchObject({ kind: "claude_code", url: "https://claude.ai/oauth/authorize?code=true" });
  expect(login.publicKey).toBeString();
  expect(Date.parse(login.expiresAt)).toBeGreaterThanOrEqual(before + ACCOUNT_LOGIN_TTL_MS - 1000);
  expect(calls[0]).toEqual({ op: "account", action: "begin", kind: "claude_code", loginId: login.loginId });
  expect(await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId)).toEqual({ state: "waiting" });

  // The browser seals the code to the computer's key, bound to this sign-in and organization.
  const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
  expect(
    await sendAccountLoginCode(deps, f.owner.id, f.org.id, machineId, login.loginId, { v: 9 }).catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  await sendAccountLoginCode(deps, f.owner.id, f.org.id, machineId, login.loginId, box);
  expect(opened as string | null).toBe("abc#123");

  const done = await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId);
  expect(done).toEqual({
    state: "done",
    account: {
      id: login.loginId,
      kind: "claude_code",
      label: "Claude Max",
      email: "ana@example.com",
      plan: "max",
      status: "active",
      usedBy: [],
    },
  });
  // Polled again: the same account, added once.
  await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId);
  const rows = await accountRows(machineId);
  expect(rows.map((r) => [r.id, r.createdBy])).toEqual([[login.loginId, f.owner.id]]);
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.added"));
  expect(audit.length).toBe(1);
  expect(JSON.stringify(audit[0]?.details)).not.toContain("abc#123");

  await cancelAccountLogin(deps, f.owner.id, f.org.id, machineId, login.loginId);
  expect(calls.at(-1)).toEqual({ op: "account", action: "cancel", loginId: login.loginId });

  // The admin sees the accounts but can't manage them.
  expect(await getMachineAccounts({ db: f.db }, admin.id, f.org.id, machineId)).toMatchObject({
    canManage: false,
    supported: true,
  });
  expect((await getMachineAccounts({ db: f.db }, f.owner.id, f.org.id, machineId)).canManage).toBe(true);
  const member = await addMember(f.db, f.org.id, "member", "caio");
  expect(await getMachineAccounts({ db: f.db }, member.id, f.org.id, machineId).catch((e) => e)).toBeInstanceOf(
    ForbiddenError,
  );
});

test("a sign-in needs the computer online, a runner that knows accounts and a provider page on https", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const offline = fakeHub(machineId, () => ({}), { online: false });
  expect(
    await beginAccountLogin(offline.deps, f.owner.id, f.org.id, machineId, "codex").catch((e) => e),
  ).toBeInstanceOf(MachineOfflineError);

  const bad = fakeHub(machineId, (req) => (req.action === "begin" ? { url: "javascript:alert(1)" } : {}));
  const refused = await beginAccountLogin(bad.deps, f.owner.id, f.org.id, machineId, "codex").catch((e) => e);
  expect(refused).toBeInstanceOf(ConflictError);
  expect(refused.code).toBe("account.begin_failed");
  // The half-started sign-in is stopped on the computer.
  expect(bad.calls.map((c) => c.action)).toEqual(["begin", "cancel"]);

  const codex = fakeHub(machineId, () => ({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }));
  expect(await beginAccountLogin(codex.deps, f.owner.id, f.org.id, machineId, "codex")).toMatchObject({
    kind: "codex",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });

  await f.db
    .update(schema.machines)
    .set({ protocol: ACCOUNTS_PROTOCOL - 1 })
    .where(eq(schema.machines.id, machineId));
  const old = await beginAccountLogin(codex.deps, f.owner.id, f.org.id, machineId, "codex").catch((e) => e);
  expect(old).toBeInstanceOf(ConflictError);
  expect(old.code).toBe("account.runner_old");
});

test("rename and remove: the owner only; removing signs it out there and releases the agents that used it", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  await addAccount(machineId, CLAUDE_ID, "claude_code");
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const { deps, calls } = fakeHub(machineId, () => ({}));

  expect(
    await renameMachineAccount(deps, admin.id, f.org.id, machineId, CLAUDE_ID, "Meu").catch((e) => e),
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await renameMachineAccount(deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, "  ").catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  expect(
    await renameMachineAccount(deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, "x".repeat(41)).catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  const renamed = await renameMachineAccount(deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, " Empresa ");
  expect(renamed).toMatchObject({ id: CLAUDE_ID, label: "Empresa", usedBy: ["Dev"] });
  expect(
    await renameMachineAccount(deps, f.owner.id, f.org.id, machineId, CODEX_ID, "Outro").catch((e) => e),
  ).toBeInstanceOf(NotFoundError);

  expect(await removeMachineAccount(deps, admin.id, f.org.id, machineId, CLAUDE_ID).catch((e) => e)).toBeInstanceOf(
    ForbiddenError,
  );
  await removeMachineAccount(deps, f.owner.id, f.org.id, machineId, CLAUDE_ID);
  expect(calls).toEqual([{ op: "account", action: "remove", kind: "claude_code", accountId: CLAUDE_ID }]);
  expect(await accountRows(machineId)).toEqual([]);
  expect((await agentRow()).brainAccountId).toBeNull();
  const actions = (await f.db.select().from(schema.auditLog)).map((a) => a.action);
  expect(actions).toContain("account.renamed");
  expect(actions).toContain("account.removed");
});

test("the agent's account: owner only, on its computer, of its brain's kind; cleared when the kind or computer changes", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, machineId);
  await addAccount(machineId, CLAUDE_ID, "claude_code");
  await addAccount(machineId, CODEX_ID, "codex");
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const deps = { db: f.db };

  const chosen = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, {
    brain: "claude_code",
    acceptPlanTerms: true,
    account: CLAUDE_ID,
    effort: "high",
  });
  expect(chosen).toMatchObject({
    brain: "claude_code",
    account: CLAUDE_ID,
    effort: "high",
    accountsOwner: { id: f.owner.id, name: "ana" },
    canManageAccounts: true,
    accountsSupported: true,
  });
  expect(chosen.accounts.map((a) => [a.id, a.kind, a.usedBy])).toEqual([
    [CLAUDE_ID, "claude_code", ["Dev"]],
    [CODEX_ID, "codex", []],
  ]);
  expect(await agentRow()).toMatchObject({ brainAccountId: CLAUDE_ID, brainEffort: "high" });
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.brain"));
  expect(audit.at(-1)?.details).toMatchObject({ to: { account: CLAUDE_ID, effort: "high" } });

  // Another kind's account, one that isn't there, a bad effort: refused.
  const wrongKind = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { account: CODEX_ID }).catch((e) => e);
  expect(wrongKind).toBeInstanceOf(ValidationError);
  expect(wrongKind.code).toBe("account.invalid");
  const missing = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, {
    account: "0193dddd-0000-4000-8000-000000000009",
  }).catch((e) => e);
  expect(missing.code).toBe("account.invalid");
  const effort = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { effort: "turbo" }).catch((e) => e);
  expect(effort.code).toBe("brain.invalid_effort");
  // "Automático": the model and the effort take auto, and read back as such.
  const auto = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { model: "auto", effort: "auto" });
  expect(auto).toMatchObject({ model: "auto", effectiveModel: "auto", effort: "auto", account: CLAUDE_ID });
  expect(await agentRow()).toMatchObject({ brainModel: "auto", brainEffort: "auto" });

  // An admin sees it locked: changes the effort, not the account.
  const seen = await getAgentBrain(deps, admin.id, f.org.id, f.agent.id);
  expect(seen).toMatchObject({ account: CLAUDE_ID, canManageAccounts: false, accountsOwner: { id: f.owner.id } });
  const locked = await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { account: null }).catch((e) => e);
  expect(locked).toBeInstanceOf(ForbiddenError);
  expect(locked.code).toBe("account.not_owner");
  expect(await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { effort: "low" })).toMatchObject({
    account: CLAUDE_ID,
    effort: "low",
  });
  // Sending the same account back is no change (allowed for anyone who edits the brain).
  expect((await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { account: CLAUDE_ID })).account).toBe(CLAUDE_ID);

  // Another brain kind: back to the computer's own sign-in, whoever changes it.
  const codex = await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { brain: "codex", acceptPlanTerms: true });
  expect(codex).toMatchObject({ brain: "codex", account: null, effort: "low" });
  expect((await agentRow()).brainAccountId).toBeNull();

  // The owner picks the Codex one; moving the agent to another computer clears it.
  await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { account: CODEX_ID });
  expect((await agentRow()).brainAccountId).toBe(CODEX_ID);
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, null);
  expect((await agentRow()).brainAccountId).toBeNull();
  expect(await getAgentBrain(deps, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
    account: null,
    accounts: [],
    accountsOwner: null,
    canManageAccounts: false,
    accountsSupported: false,
  });
});

test("a runner older than accounts: the page says accounts aren't supported", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(BRAIN_PROTOCOL);
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, machineId);
  expect(await getAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
    accounts: [],
    accountsOwner: { id: f.owner.id },
    canManageAccounts: false,
    accountsSupported: false,
  });
});
