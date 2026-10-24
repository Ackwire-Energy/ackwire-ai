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
  type ServerFrame,
  sealSecret,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  accountLoginStatus,
  beginAccountLogin,
  ConflictError,
  cancelAccountLogin,
  createMachineHub,
  deleteAccount,
  ForbiddenError,
  getAgentBrain,
  getMachineAccounts,
  listMachineAccounts,
  type MachineHub,
  MachineOfflineError,
  type MachineStatus,
  NotFoundError,
  removeMachineAccount,
  removeMember,
  renameMachineAccount,
  sendAccountLoginCode,
  setAgentBrain,
  setAgentComputerTarget,
  syncMachineAccounts,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0041 and ADR 0056: accounts of the computer brains on a connected
 * computer. An account is the person's who started its sign-in, bound when
 * it starts; one the desktop app signed in is the pairer's. The runner's
 * hello keeps the rows in sync; only the owner renames an account or picks
 * it for an agent (one agent per account); the owner or the pairer removes
 * it, with a tombstone while the computer is off.
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

/** A computer nobody connected (the Cloud's, a server's own): every member adds accounts there. */
async function sharedMachine() {
  const paired = await ownedMachine();
  await f.db.update(schema.machines).set({ pairedByUserId: null }).where(eq(schema.machines.id, paired.machineId));
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
    createdBy: f.owner.id,
    ...over,
  });
}

const agentRow = async (id = f.agent.id) => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, id));
  if (!row) throw new Error("no agent");
  return row;
};

const accountRows = (machineId: string) =>
  f.db
    .select()
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, f.org.id), eq(schema.machineAccounts.machineId, machineId)))
    .orderBy(schema.machineAccounts.createdAt, schema.machineAccounts.id);

const accountRow = async (id: string) =>
  (await f.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, id)))[0] ?? null;

/** Lets the hub's own requests (sent outside the frame that caused them) and their replies land. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

type AccountReq = Extract<MachineRequest, { op: "account" }>;

/** A hub stand-in: the machine's status and the runner's answers to `op: "account"`. */
function fakeHub(
  machineId: string,
  answer: (req: AccountReq) => unknown | Promise<unknown>,
  over: Partial<MachineStatus> = {},
) {
  const calls: AccountReq[] = [];
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
      if (over.online === false) throw new MachineOfflineError("mac");
      calls.push(req);
      return (await answer(req)) as never;
    },
  };
  return { deps: { db: f.db, pubsub: f.pubsub, hub }, calls };
}

/** A runner that signs Claude Code in: a key per sign-in, `done` once its code arrived, with `account()`'s answer. */
function signingRunner(machineId: string, account: (loginId: string) => Omit<RunnerAccountInfo, "id" | "kind">) {
  const keys = new Map<string, string>();
  const codes = new Map<string, string>();
  return {
    codes,
    ...fakeHub(machineId, async (req) => {
      if (req.action === "begin") {
        const pair = await generateSecretKeyPair();
        keys.set(req.loginId, pair.privateKey);
        return { url: "https://claude.ai/oauth/authorize?code=true", publicKey: pair.publicKey };
      }
      if (req.action === "code") {
        codes.set(req.loginId, await openSecret(keys.get(req.loginId) ?? "", req.box, req.aad));
        return {};
      }
      if (req.action === "status") {
        return codes.has(req.loginId)
          ? { state: "done", account: { id: req.loginId, kind: "claude_code", ...account(req.loginId) } }
          : { state: "waiting" };
      }
      return {};
    }),
  };
}

/** Signs in the whole way: begin, the sealed code, the poll that finds it done. */
async function signIn(
  runner: ReturnType<typeof signingRunner>,
  userId: string,
  machineId: string,
  options: { email?: string } = {},
) {
  const login = await beginAccountLogin(
    runner.deps,
    userId,
    f.org.id,
    machineId,
    "claude_code",
    undefined,
    options.email,
  );
  const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
  await sendAccountLoginCode(runner.deps, userId, f.org.id, machineId, login.loginId, box);
  return { login, status: await accountLoginStatus(runner.deps, userId, f.org.id, machineId, login.loginId) };
}

/** A runner on a real hub (each hello on a new connection): it answers every request with `{}` and keeps them. */
function connectedRunner(hub: MachineHub, token: string) {
  const requests: Extract<ServerFrame, { type: "request" }>[] = [];
  const open = () => {
    const conn = hub.open({
      send(text: string) {
        const frame = JSON.parse(text) as ServerFrame;
        if (frame.type !== "request") return;
        requests.push(frame);
        const reply = { type: "result", id: frame.id, ok: true, data: {} };
        setTimeout(() => void hub.message(conn, JSON.stringify(reply)), 1);
      },
      close() {},
    });
    return conn;
  };
  return {
    removals: () => requests.flatMap((r) => (r.op === "account" && r.action === "remove" ? [r] : [])),
    hello: (accounts: RunnerAccountInfo[], protocol = ACCOUNTS_PROTOCOL) =>
      hub.message(open(), JSON.stringify({ type: "hello", token, ...RUNNER, protocol, exec: true, accounts })),
  };
}

test("hello.accounts: new accounts are added as the pairer's, known ones refreshed, missing ones removed (their agents released)", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine();
  const runner = connectedRunner(hub, token);

  await runner.hello([
    { id: CLAUDE_ID, kind: "claude_code", loggedIn: true, email: "ana@example.com", plan: "max" },
    { id: CODEX_ID, kind: "codex", loggedIn: false },
  ]);
  let rows = await accountRows(machineId);
  // Signed in on the computer itself (the desktop app): the pairer's from the start.
  expect(rows.map((r) => [r.id, r.kind, r.label, r.email, r.plan, r.status, r.createdBy])).toEqual([
    [CLAUDE_ID, "claude_code", "Claude Max", "ana@example.com", "max", "active", f.owner.id],
    [CODEX_ID, "codex", "ChatGPT", null, null, "signed_out", f.owner.id],
  ]);

  // An agent thinks with the Claude account; the computer no longer has it.
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  expect((await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id))[0]?.usedBy).toEqual(["Dev"]);
  await renameMachineAccount({ db: f.db }, f.owner.id, f.org.id, machineId, CODEX_ID, "Pessoal");
  await runner.hello([{ id: CODEX_ID, kind: "codex", loggedIn: true, email: "ana@example.com", plan: "plus" }]);
  rows = await accountRows(machineId);
  // The name people gave it stays; what the CLI says is refreshed.
  expect(rows.map((r) => [r.id, r.label, r.email, r.plan, r.status])).toEqual([
    [CODEX_ID, "Pessoal", "ana@example.com", "plus", "active"],
  ]);
  expect((await agentRow()).brainAccountId).toBeNull();

  // A runner that says nothing about accounts (an older one) changes nothing.
  await runner.hello([], ACCOUNTS_PROTOCOL - 1);
  expect((await accountRows(machineId)).length).toBe(1);
});

test("signing in: the person who connected the computer; the code is sealed to it; done stores the account once", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: "ana@example.com", plan: "max" }));
  const { deps, calls } = runner;

  // Someone else on a computer a person connected (an admin either): refused before anything reaches it.
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
  // Bound now: the row is there, the starter's, and no account yet.
  expect(await accountRow(login.loginId)).toMatchObject({ status: "signing_in", createdBy: f.owner.id });
  expect(await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id)).toEqual([]);
  expect(await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId)).toEqual({ state: "waiting" });

  // The browser seals the code to the computer's key, bound to this sign-in and organization.
  const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
  expect(
    await sendAccountLoginCode(deps, f.owner.id, f.org.id, machineId, login.loginId, { v: 9 }).catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  await sendAccountLoginCode(deps, f.owner.id, f.org.id, machineId, login.loginId, box);
  expect(runner.codes.get(login.loginId)).toBe("abc#123");

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
      ownerId: f.owner.id,
      ownerName: "ana",
      mine: true,
      usedBy: [],
    },
  });
  // Polled again: the same account, added once.
  await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId);
  const rows = await accountRows(machineId);
  expect(rows.map((r) => [r.id, r.createdBy])).toEqual([[login.loginId, f.owner.id]]);
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.added"));
  expect(audit.length).toBe(1);
  expect(audit[0]).toMatchObject({ actorType: "person", actorId: f.owner.id });
  expect(JSON.stringify(audit[0]?.details)).not.toContain("abc#123");

  await cancelAccountLogin(deps, f.owner.id, f.org.id, machineId, login.loginId);
  expect(calls.at(-1)).toEqual({ op: "account", action: "cancel", loginId: login.loginId });

  // The admin sees the accounts (never the email) but can't manage them.
  const seen = await getMachineAccounts({ db: f.db }, admin.id, f.org.id, machineId);
  expect(seen).toMatchObject({ canManage: false, supported: true });
  expect(seen.accounts.map((a) => [a.email, a.mine, a.ownerName])).toEqual([[null, false, "ana"]]);
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
  expect(await accountRows(machineId)).toEqual([]);

  const bad = fakeHub(machineId, (req) => (req.action === "begin" ? { url: "javascript:alert(1)" } : {}));
  const refused = await beginAccountLogin(bad.deps, f.owner.id, f.org.id, machineId, "codex").catch((e) => e);
  expect(refused).toBeInstanceOf(ConflictError);
  expect(refused.code).toBe("account.begin_failed");
  // The half-started sign-in is stopped on the computer, and its row goes.
  expect(bad.calls.map((c) => c.action)).toEqual(["begin", "cancel"]);
  expect(await accountRows(machineId)).toEqual([]);

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

test("the email that names the account: a plain address only, never one a shell would read", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const { deps, calls } = signingRunner(machineId, () => ({ loggedIn: true }));
  const begin = (kind: string, email: string) =>
    beginAccountLogin(deps, f.owner.id, f.org.id, machineId, kind, undefined, email).catch((e) => e);
  // Codex takes no hint either.
  for (const [kind, email] of [
    ["claude_code", "a&calc&x@y.z"],
    ["claude_code", 'a"b@y.z'],
    ["claude_code", "a%PATH%@y.z"],
    ["claude_code", "(a)@y.z"],
    ["claude_code", "-x@y.z"],
    ["claude_code", "a b@y.z"],
    ["claude_code", "a@y"],
    ["codex", "ana@example.com"],
  ] as const) {
    const refused = await begin(kind, email);
    expect(refused).toBeInstanceOf(ValidationError);
    expect(refused.code).toBe("account.invalid_email");
  }
  expect(calls).toEqual([]);
  expect(await accountRows(machineId)).toEqual([]);
  const login = await begin("claude_code", "ana.silva+work@acme-corp.com.br");
  expect(calls[0]).toEqual({
    op: "account",
    action: "begin",
    kind: "claude_code",
    loginId: login.loginId,
    email: "ana.silva+work@acme-corp.com.br",
  });
});

test("ownership is bound when the sign-in starts: a member's account on a computer nobody connected stays theirs", async () => {
  f = await setup();
  const { machineId } = await sharedMachine();
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: "caio@example.com", plan: "team" }));

  const login = await beginAccountLogin(runner.deps, caio.id, f.org.id, machineId, "claude_code");
  // The runner lists the accounts before the sign-in finished: the sign-in in progress stays.
  await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, []);
  expect(await accountRow(login.loginId)).toMatchObject({ status: "signing_in", createdBy: caio.id });
  // Nobody else follows it, sends its code or stops it.
  const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
  for (const attempt of [
    accountLoginStatus(runner.deps, bia.id, f.org.id, machineId, login.loginId),
    sendAccountLoginCode(runner.deps, bia.id, f.org.id, machineId, login.loginId, box),
    cancelAccountLogin(runner.deps, f.owner.id, f.org.id, machineId, login.loginId),
  ]) {
    const refused = await attempt.catch((e) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(refused.code).toBe("account.not_owner");
  }
  expect(runner.calls.map((c) => c.action)).toEqual(["begin"]);

  // Caio's tab closes; the runner reports the finished sign-in: still Caio's, never re-owned.
  await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, [
    { id: login.loginId, kind: "claude_code", loggedIn: true, email: "caio@example.com", plan: "team" },
  ]);
  expect(await accountRow(login.loginId)).toMatchObject({
    status: "active",
    createdBy: caio.id,
    label: "Claude Team",
    email: "caio@example.com",
  });
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.added"));
  expect(audit.map((a) => a.actorId)).toEqual([caio.id]);

  // Only Caio sees the email; everyone sees whose it is.
  const asBia = await getMachineAccounts({ db: f.db }, bia.id, f.org.id, machineId);
  expect(asBia.canManage).toBe(true);
  expect(asBia.accounts).toMatchObject([
    { id: login.loginId, email: null, mine: false, ownerId: caio.id, ownerName: "caio" },
  ]);
  const asCaio = await getMachineAccounts({ db: f.db }, caio.id, f.org.id, machineId);
  expect(asCaio.accounts).toMatchObject([{ email: "caio@example.com", mine: true }]);
  const asAdmin = await getMachineAccounts({ db: f.db }, f.owner.id, f.org.id, machineId);
  expect(asAdmin.accounts[0]?.email).toBeNull();

  // His second seat is "Claude Team 2"; Bia's first is "Claude Team".
  const second = signingRunner(machineId, () => ({ loggedIn: true, email: "caio2@example.com", plan: "team" }));
  expect((await signIn(second, caio.id, machineId)).status.account?.label).toBe("Claude Team 2");
  const hers = signingRunner(machineId, () => ({ loggedIn: true, email: "bia@example.com", plan: "team" }));
  expect((await signIn(hers, bia.id, machineId)).status.account?.label).toBe("Claude Team");

  // Only the owner renames; the others can't.
  expect(
    await renameMachineAccount({ db: f.db }, bia.id, f.org.id, machineId, login.loginId, "Meu").catch((e) => e),
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await renameMachineAccount({ db: f.db }, caio.id, f.org.id, machineId, login.loginId, "Startup"),
  ).toMatchObject({ label: "Startup", mine: true });
});

test("the same email twice for one owner on one computer is refused, and the new sign-in is removed there", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  await addAccount(machineId, CLAUDE_ID, "claude_code", { label: "Trabalho", email: "Ana@Example.com" });
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: "ana@example.com", plan: "max" }));
  const { login, status } = await signIn(runner, f.owner.id, machineId);
  expect(status).toMatchObject({ state: "failed", duplicate: { label: "Trabalho" } });
  expect(runner.calls.at(-1)).toEqual({
    op: "account",
    action: "remove",
    kind: "claude_code",
    accountId: login.loginId,
  });
  expect((await accountRows(machineId)).map((r) => r.id)).toEqual([CLAUDE_ID]);
  expect(await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.added"))).toEqual([]);

  // Another email is another account.
  const other = signingRunner(machineId, () => ({ loggedIn: true, email: "ana.pessoal@example.com", plan: "pro" }));
  expect((await signIn(other, f.owner.id, machineId)).status).toMatchObject({
    state: "done",
    account: { label: "Claude Pro" },
  });
});

test("rename and remove: the owner renames; the owner or the pairer removes; offline, a tombstone until the next hello", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine();
  await addAccount(machineId, CLAUDE_ID, "claude_code");
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const online = fakeHub(machineId, () => ({}));

  expect(
    await renameMachineAccount(online.deps, admin.id, f.org.id, machineId, CLAUDE_ID, "Meu").catch((e) => e),
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, "  ").catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  expect(
    await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, "x".repeat(41)).catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  const renamed = await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, " Empresa ");
  expect(renamed).toMatchObject({ id: CLAUDE_ID, label: "Empresa", usedBy: ["Dev"] });
  expect(
    await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CODEX_ID, "Outro").catch((e) => e),
  ).toBeInstanceOf(NotFoundError);

  // An admin removes only where the computer or the account has no person.
  expect(
    await removeMachineAccount(online.deps, admin.id, f.org.id, machineId, CLAUDE_ID).catch((e) => e),
  ).toBeInstanceOf(ForbiddenError);

  // The computer is off: the agent is released now, the account waits for it as a tombstone.
  const off = fakeHub(machineId, () => ({}), { online: false });
  await removeMachineAccount(off.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID);
  expect(await accountRow(CLAUDE_ID)).toMatchObject({ status: "removing" });
  expect((await agentRow()).brainAccountId).toBeNull();
  expect(await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id)).toEqual([]);
  const actions = (await f.db.select().from(schema.auditLog)).map((a) => a.action);
  expect(actions).toContain("account.renamed");
  expect(actions).toContain("account.removed");

  // Back: its hello still lists the account, which stays removed, and the runner is told to remove it.
  const runner = connectedRunner(hub, token);
  await runner.hello([{ id: CLAUDE_ID, kind: "claude_code", loggedIn: true, email: "ana@example.com" }]);
  await settle();
  expect(runner.removals()).toMatchObject([{ action: "remove", kind: "claude_code", accountId: CLAUDE_ID }]);
  expect(await accountRow(CLAUDE_ID)).toBeNull();

  // Online, the pairer removes someone's account at once (here an old one nobody owns).
  await addAccount(machineId, CODEX_ID, "codex", { createdBy: null });
  await removeMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CODEX_ID);
  expect(online.calls.at(-1)).toEqual({ op: "account", action: "remove", kind: "codex", accountId: CODEX_ID });
  expect(await accountRow(CODEX_ID)).toBeNull();
});

test("on a computer nobody connected, an admin removes any account; a member only their own", async () => {
  f = await setup();
  const { machineId } = await sharedMachine();
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addAccount(machineId, CLAUDE_ID, "claude_code", { createdBy: caio.id });
  await addAccount(machineId, CODEX_ID, "codex", { createdBy: caio.id });
  const { deps, calls } = fakeHub(machineId, () => ({}));
  expect(await removeMachineAccount(deps, bia.id, f.org.id, machineId, CLAUDE_ID).catch((e) => e)).toBeInstanceOf(
    ForbiddenError,
  );
  await removeMachineAccount(deps, f.owner.id, f.org.id, machineId, CLAUDE_ID);
  await removeMachineAccount(deps, caio.id, f.org.id, machineId, CODEX_ID);
  expect(calls.map((c) => (c.action === "remove" ? c.accountId : c.action))).toEqual([CLAUDE_ID, CODEX_ID]);
  expect(await accountRows(machineId)).toEqual([]);
});

test("a person who leaves or deletes their account: their accounts are signed out everywhere, never inherited", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await sharedMachine();
  const runner = connectedRunner(hub, token);
  await runner.hello([]);
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  await addAccount(machineId, CLAUDE_ID, "claude_code", { createdBy: caio.id });
  await addAccount(machineId, CODEX_ID, "codex", { createdBy: bia.id });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));

  // Caio is removed: his account goes on the computer at once, his agent is released.
  await removeMember(f.db, f.owner.id, f.org.id, caio.id, { pubsub: f.pubsub });
  expect((await agentRow()).brainAccountId).toBeNull();
  await settle();
  expect(runner.removals()).toMatchObject([{ kind: "claude_code", accountId: CLAUDE_ID }]);
  expect(await accountRow(CLAUDE_ID)).toBeNull();

  // Bia deletes her account: a tombstone first, so the row never turns into nobody's account.
  await deleteAccount(f.db, bia.id, { pubsub: f.pubsub });
  await settle();
  expect(runner.removals().map((r) => (r.op === "account" && r.action === "remove" ? r.accountId : ""))).toEqual([
    CLAUDE_ID,
    CODEX_ID,
  ]);
  expect(await accountRow(CODEX_ID)).toBeNull();
  expect(await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id)).toEqual([]);
});

test("the agent's account: its owner's own only, on its computer, of its brain's kind, one agent each", async () => {
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
  expect(chosen.accounts.map((a) => [a.id, a.kind, a.usedBy, a.mine])).toEqual([
    [CLAUDE_ID, "claude_code", ["Dev"], true],
    [CODEX_ID, "codex", [], true],
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

  // An admin sees it locked: changes the effort, not the account (nor the computer's own sign-in, the pairer's).
  const seen = await getAgentBrain(deps, admin.id, f.org.id, f.agent.id);
  expect(seen).toMatchObject({ account: CLAUDE_ID, canManageAccounts: false, accountsOwner: { id: f.owner.id } });
  expect(seen.accounts.map((a) => [a.email, a.mine])).toEqual([
    [null, false],
    [null, false],
  ]);
  const locked = await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { account: null }).catch((e) => e);
  expect(locked).toBeInstanceOf(ForbiddenError);
  expect(locked.code).toBe("account.not_owner");
  expect(await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { effort: "low" })).toMatchObject({
    account: CLAUDE_ID,
    effort: "low",
  });
  // Sending the same account back is no change (allowed for anyone who edits the brain).
  expect((await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { account: CLAUDE_ID })).account).toBe(CLAUDE_ID);

  // One agent per account: another agent of the owner's can't take it, not even in the database.
  const [theo] = await f.db
    .insert(schema.agents)
    .values({
      orgId: f.org.id,
      name: "Theo",
      handle: "theo",
      model: "claude-sonnet-5-5",
      ownerUserId: f.owner.id,
      machineId,
      brain: "claude_code",
    })
    .returning();
  if (!theo) throw new Error("no agent");
  const taken = await setAgentBrain(deps, f.owner.id, f.org.id, theo.id, { account: CLAUDE_ID }).catch((e) => e);
  expect(taken).toBeInstanceOf(ConflictError);
  expect(taken.code).toBe("account.in_use");
  expect(
    await f.db
      .update(schema.agents)
      .set({ brainAccountId: CLAUDE_ID })
      .where(eq(schema.agents.id, theo.id))
      .catch((e) => e),
  ).toBeInstanceOf(Error);
  // An archived agent doesn't count.
  await f.db
    .update(schema.agents)
    .set({ archivedAt: new Date(), brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, theo.id));

  // Someone else's account: only its owner picks it.
  await addAccount(machineId, "0193dddd-0000-4000-8000-000000000003", "claude_code", {
    createdBy: admin.id,
    email: "bia@example.com",
  });
  const theirs = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, {
    account: "0193dddd-0000-4000-8000-000000000003",
  }).catch((e) => e);
  expect(theirs).toBeInstanceOf(ForbiddenError);

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
