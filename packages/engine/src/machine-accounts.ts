import {
  ACCOUNT_LOGIN_TTL_MS,
  ACCOUNTS_PROTOCOL,
  type AccountKind,
  type AccountLoginState,
  accountCodeAad,
  isAccountId,
  isAccountKind,
  MAX_MACHINE_ACCOUNTS,
  type PubSub,
  parseSecretBox,
  type RunnerAccountInfo,
} from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNotNull, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { getMachine, MachineOfflineError, type MachineRow, publishMachineUpdated } from "./machines";
import { can, requirePermission } from "./organizations";

const { machineAccounts, agents, machines } = schema;

/*
 * Accounts of the computer brains on a connected computer (ADR 0041): a
 * folder on the machine where Claude Code or Codex keeps its own sign-in.
 * We keep metadata only (email, plan, signed in or not); the sign-in itself
 * goes through the provider's CLI on the computer, and a Claude code typed in
 * the browser reaches the runner sealed to the machine's key. Only the
 * person who connected the computer adds, renames or removes its accounts
 * and picks one for an agent (the subscription is theirs).
 */

export type MachineAccountRow = typeof machineAccounts.$inferSelect;
export type MachineAccountStatus = "active" | "signed_out";

export interface MachineAccountView {
  id: string;
  kind: AccountKind;
  label: string;
  email: string | null;
  plan: string | null;
  status: MachineAccountStatus;
  /** Names of the agents that think with it. */
  usedBy: string[];
}

export const MACHINE_ACCOUNT_LIMITS = { labelChars: 40 };

export interface MachineAccountDeps {
  db: Database;
  pubsub?: PubSub;
}

export interface MachineAccountHubDeps extends MachineAccountDeps {
  hub: Pick<MachineCaller, "call" | "status">;
}

/**
 * What a new account is called until its owner names it: the CLI and the plan
 * ("Claude Max", "Codex Plus"), never the email (others see the name, only the
 * computer's owner sees the email).
 */
export const defaultAccountLabel = (kind: AccountKind, plan?: string | null) => {
  const word = plan && /^[\w.-]{1,20}$/.test(plan) ? ` ${plan[0]?.toUpperCase()}${plan.slice(1)}` : "";
  return `${kind === "codex" ? "Codex" : "Claude"}${word}`.slice(0, MACHINE_ACCOUNT_LIMITS.labelChars);
};

const statusOf = (v: string): MachineAccountStatus => (v === "signed_out" ? "signed_out" : "active");

function accountView(row: MachineAccountRow, usedBy: string[]): MachineAccountView {
  return {
    id: row.id,
    kind: isAccountKind(row.kind) ? row.kind : "claude_code",
    label: row.label,
    email: row.email,
    plan: row.plan,
    status: statusOf(row.status),
    usedBy,
  };
}

/** The accounts on a machine, both kinds, oldest first, with the agents that use each. No permission check. */
export async function listMachineAccounts(
  deps: Pick<MachineAccountDeps, "db">,
  orgId: string,
  machineId: string,
): Promise<MachineAccountView[]> {
  const rows = await deps.db
    .select()
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.machineId, machineId)))
    .orderBy(machineAccounts.createdAt, machineAccounts.id);
  if (rows.length === 0) return [];
  const using = await deps.db
    .select({ name: agents.name, accountId: agents.brainAccountId })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, orgId),
        inArray(
          agents.brainAccountId,
          rows.map((r) => r.id),
        ),
        isNull(agents.archivedAt),
      ),
    )
    .orderBy(agents.name);
  return rows.map((r) =>
    accountView(
      r,
      using.filter((a) => a.accountId === r.id).map((a) => a.name),
    ),
  );
}

async function accountViewOf(db: Database, orgId: string, row: MachineAccountRow) {
  const views = await listMachineAccounts({ db }, orgId, row.machineId);
  return views.find((v) => v.id === row.id) ?? accountView(row, []);
}

/** Agents that used these accounts go back to the computer's own sign-in (their cache too). */
async function releaseAgents(db: Executor, orgId: string, accountIds: string[], now = new Date()) {
  if (accountIds.length === 0) return [];
  const rows = await db
    .update(agents)
    .set({ brainAccountId: null, updatedAt: now })
    .where(and(eq(agents.orgId, orgId), inArray(agents.brainAccountId, accountIds)))
    .returning({ id: agents.id });
  return rows.map((r) => r.id);
}

const forgetAgents = (orgId: string, ids: string[]) => {
  for (const id of ids) caches.agents.delete(`${orgId}:${id}`);
};

/** The page that shows a machine's accounts refetches them (no emails in the event). */
const publishAccountsChanged = (pubsub: PubSub | undefined, orgId: string, machineId: string) =>
  publishMachineUpdated(pubsub, orgId, machineId, { accounts: true });

/**
 * `hello.accounts` (protocol 13): the machine says which accounts it has.
 * New ones are added (named after their email, nobody as creator), known ones
 * get their email, plan and status, and the ones it no longer has are removed
 * (their agents go back to the computer's own sign-in). An id that belongs to
 * a disconnected machine of the organization (this computer, paired again as a
 * new one) moves here with its name; one that belongs to a live machine is
 * ignored. A list as long as `MAX_MACHINE_ACCOUNTS` may be cut, so nothing is
 * removed from it.
 */
export async function syncMachineAccounts(
  deps: MachineAccountDeps,
  orgId: string,
  machineId: string,
  accounts: RunnerAccountInfo[],
) {
  const reported = new Map<string, RunnerAccountInfo>();
  for (const a of accounts) if (isAccountId(a.id) && isAccountKind(a.kind)) reported.set(a.id, a);
  const now = new Date();
  const { changed, released } = await deps.db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(machineAccounts)
      .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.machineId, machineId)));
    let changed = false;
    const complete = accounts.length < MAX_MACHINE_ACCOUNTS;
    const gone = complete ? existing.filter((r) => !reported.has(r.id)).map((r) => r.id) : [];
    const released = await releaseAgents(tx, orgId, gone, now);
    if (gone.length > 0) {
      await tx
        .delete(machineAccounts)
        .where(
          and(
            eq(machineAccounts.orgId, orgId),
            eq(machineAccounts.machineId, machineId),
            inArray(machineAccounts.id, gone),
          ),
        );
      changed = true;
    }
    for (const a of reported.values()) {
      const status: MachineAccountStatus = a.loggedIn ? "active" : "signed_out";
      const row = existing.find((r) => r.id === a.id);
      if (!row) {
        const inserted = await tx
          .insert(machineAccounts)
          .values({
            id: a.id,
            orgId,
            machineId,
            kind: a.kind,
            label: defaultAccountLabel(a.kind, a.plan),
            email: a.email ?? null,
            plan: a.plan ?? null,
            status,
            createdBy: null,
          })
          .onConflictDoNothing()
          .returning({ id: machineAccounts.id });
        if (inserted.length > 0) {
          changed = true;
          continue;
        }
        // Taken: by a machine that was disconnected (this computer before it was paired again), it comes here.
        const moved = await tx
          .update(machineAccounts)
          .set({ machineId, kind: a.kind, email: a.email ?? null, plan: a.plan ?? null, status, updatedAt: now })
          .where(
            and(
              eq(machineAccounts.orgId, orgId),
              eq(machineAccounts.id, a.id),
              inArray(
                machineAccounts.machineId,
                tx
                  .select({ id: machines.id })
                  .from(machines)
                  .where(and(eq(machines.orgId, orgId), isNotNull(machines.deletedAt))),
              ),
            ),
          )
          .returning({ id: machineAccounts.id });
        if (moved.length > 0) changed = true;
        continue;
      }
      if (row.kind !== a.kind) continue;
      // A signed-out CLI may not say its email or plan any more: keep what we knew.
      const email = a.email ?? row.email;
      const plan = a.plan ?? row.plan;
      if (email === row.email && plan === row.plan && status === row.status) continue;
      await tx
        .update(machineAccounts)
        .set({ email, plan, status, updatedAt: now })
        .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, row.id)));
      changed = true;
    }
    return { changed, released };
  });
  forgetAgents(orgId, released);
  if (changed) await publishAccountsChanged(deps.pubsub, orgId, machineId);
}

/** A turn ran with it (best effort, after the turn). */
export async function touchMachineAccount(db: Executor, orgId: string, accountId: string) {
  await db
    .update(machineAccounts)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, accountId)));
}

/** One account of the organization, on that machine. */
export async function getMachineAccount(db: Executor, orgId: string, machineId: string, accountId: string) {
  if (!isAccountId(accountId)) return null;
  const [row] = await db
    .select()
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.machineId, machineId),
        eq(machineAccounts.id, accountId),
      ),
    );
  return row ?? null;
}

// ── Who may ─────────────────────────────────────────────────────────────────

/** The machine, when `userId` is the person who connected it (the subscription is theirs). */
async function ownedMachine(db: Database, userId: string, orgId: string, machineId: string) {
  await requirePermission(db, userId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (machine.pairedByUserId !== userId) {
    throw new ForbiddenError(
      "Only the person who connected this computer can manage its accounts",
      "account.not_owner",
    );
  }
  return machine;
}

const runnerOld = (machine: Pick<MachineRow, "name">) =>
  new ConflictError(`The runner on ${machine.name} is too old for accounts; update it`, "account.runner_old", {
    name: machine.name,
  });

/** Owned, on a runner that knows accounts, and online now. */
async function liveOwnedMachine(deps: MachineAccountHubDeps, userId: string, orgId: string, machineId: string) {
  const machine = await ownedMachine(deps.db, userId, orgId, machineId);
  if (machine.protocol < ACCOUNTS_PROTOCOL) throw runnerOld(machine);
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name);
  if (status.protocol < ACCOUNTS_PROTOCOL) throw runnerOld(machine);
  return machine;
}

const loginIdOf = (loginId: string) => {
  if (!isAccountId(loginId)) throw new NotFoundError("Sign-in not found", "account.login_not_found");
  return loginId;
};

// ── The page ────────────────────────────────────────────────────────────────

/**
 * `GET …/machines/{id}/accounts`: the person who connected it or an admin.
 * `canManage`: only the former, on a runner that knows accounts.
 */
export async function getMachineAccounts(
  deps: Pick<MachineAccountDeps, "db">,
  userId: string,
  orgId: string,
  machineId: string,
) {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  const mine = machine.pairedByUserId === userId;
  if (!mine && !can(membership.role, "configure")) {
    throw new ForbiddenError(
      "Only an admin or the person who connected this computer can see its accounts",
      "machine.forbidden",
    );
  }
  const supported = machine.protocol >= ACCOUNTS_PROTOCOL;
  const accounts = await listMachineAccounts(deps, orgId, machine.id);
  return {
    // The emails are the computer owner's: an admin sees the accounts, not whose they are.
    accounts: mine ? accounts : accounts.map((a) => ({ ...a, email: null })),
    canManage: mine && supported,
    supported,
  };
}

// ── Signing in (ADR 0041 §2) ────────────────────────────────────────────────

export interface AccountLoginView {
  loginId: string;
  kind: AccountKind;
  /** The provider's page (Claude's sign-in, or Codex's device page). */
  url: string;
  /** Claude Code: the key the browser seals the pasted code to (raw P-256, base64). */
  publicKey?: string;
  /** Codex: the one-time code to type on its page. */
  userCode?: string;
  expiresAt: string;
}

const PUBLIC_KEY = /^[A-Za-z0-9+/=_-]{20,200}$/;
const USER_CODE = /^[A-Za-z0-9-]{4,20}$/;

/** Starts the CLI's sign-in on the computer, in a new account folder named `loginId`. */
export async function beginAccountLogin(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  kind: unknown,
  /** Sign in again to this account (signed out): same id, same folder, the agents that use it keep it. */
  accountId?: string,
): Promise<AccountLoginView> {
  if (!isAccountKind(kind)) throw new ValidationError("Choose claude_code or codex", "account.invalid_kind");
  const machine = await liveOwnedMachine(deps, userId, orgId, machineId);
  if (accountId !== undefined) {
    const existing = isAccountId(accountId) ? await getMachineAccount(deps.db, orgId, machine.id, accountId) : null;
    if (!existing || existing.kind !== kind) {
      throw new ValidationError("That account isn't on this computer", "account.invalid");
    }
  }
  const again = accountId !== undefined;
  const loginId = again ? accountId : crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ACCOUNT_LOGIN_TTL_MS).toISOString();
  const reply = await deps.hub.call(machine.id, {
    op: "account",
    action: "begin",
    kind,
    loginId,
    ...(again ? { again: true } : {}),
  });
  // Only a provider page the person can open: never another scheme.
  let url: URL | null = null;
  try {
    url = reply.url ? new URL(reply.url) : null;
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:") {
    await deps.hub.call(machine.id, { op: "account", action: "cancel", loginId }).catch(() => undefined);
    throw new ConflictError("The computer couldn't start the sign-in", "account.begin_failed", { name: machine.name });
  }
  const publicKey =
    typeof reply.publicKey === "string" && PUBLIC_KEY.test(reply.publicKey) ? reply.publicKey : undefined;
  const userCode = typeof reply.userCode === "string" && USER_CODE.test(reply.userCode) ? reply.userCode : undefined;
  return {
    loginId,
    kind,
    url: reply.url as string,
    ...(publicKey ? { publicKey } : {}),
    ...(userCode ? { userCode } : {}),
    expiresAt,
  };
}

/** The Claude code the person pasted, sealed in their browser to the computer's key; relayed, never kept. */
export async function sendAccountLoginCode(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  loginId: string,
  rawBox: unknown,
) {
  const id = loginIdOf(loginId);
  const box = parseSecretBox(rawBox);
  if (!box) throw new ValidationError("The sealed code is malformed", "account.invalid_code");
  const machine = await liveOwnedMachine(deps, userId, orgId, machineId);
  await deps.hub.call(machine.id, { op: "account", action: "code", loginId: id, aad: accountCodeAad(id, orgId), box });
}

export interface AccountLoginStatus {
  state: AccountLoginState;
  account?: MachineAccountView;
  /** `failed`: why, for people. */
  error?: string;
}

const LOGIN_STATES: readonly AccountLoginState[] = ["waiting", "done", "failed", "expired"];

/** Where a sign-in is; once done, the account is stored (named after its email) and returned. */
export async function accountLoginStatus(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  loginId: string,
): Promise<AccountLoginStatus> {
  const id = loginIdOf(loginId);
  const machine = await liveOwnedMachine(deps, userId, orgId, machineId);
  const reply = await deps.hub.call(machine.id, { op: "account", action: "status", loginId: id });
  const state: AccountLoginState = LOGIN_STATES.includes(reply.state as AccountLoginState)
    ? (reply.state as AccountLoginState)
    : "failed";
  const error = typeof reply.error === "string" ? reply.error.slice(0, 300) : undefined;
  if (state !== "done") return { state, ...(state === "failed" && error ? { error } : {}) };
  const info = reply.account;
  if (!info || !isAccountId(info.id) || !isAccountKind(info.kind)) {
    return { state: "failed", error: "The computer didn't say which account signed in." };
  }
  if (info.id !== id) return { state: "failed", error: "The computer reported another account." };
  const row = await storeSignedInAccount(deps, userId, orgId, machine, info);
  if (!row) return { state: "failed", error: "That account belongs to another computer." };
  return { state, account: await accountViewOf(deps.db, orgId, row) };
}

/** Adds (audited) or refreshes the account a finished sign-in reported. Null: the id is another machine's. */
async function storeSignedInAccount(
  deps: MachineAccountDeps,
  userId: string,
  orgId: string,
  machine: MachineRow,
  info: RunnerAccountInfo,
): Promise<MachineAccountRow | null> {
  const now = new Date();
  const email = info.email ?? null;
  const plan = info.plan ?? null;
  const [existing] = await deps.db
    .select()
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, info.id)));
  if (existing) {
    if (existing.machineId !== machine.id) return null;
    const [row] = await deps.db
      .update(machineAccounts)
      .set({
        email: email ?? existing.email,
        plan: plan ?? existing.plan,
        status: "active",
        // The runner's hello may have reported it first: the person who signed in made it.
        createdBy: existing.createdBy ?? userId,
        updatedAt: now,
      })
      .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, info.id)))
      .returning();
    // The runner's `accounts.changed` usually arrives before this poll: the sign-in is still this person's, audited once.
    if (!existing.createdBy) {
      await recordAudit(deps.db, {
        orgId,
        actor: { type: "person", id: userId },
        action: "account.added",
        target: { type: "machine_account", id: existing.id },
        details: { machineId: machine.id, kind: existing.kind, plan: plan ?? existing.plan },
      });
    }
    if (existing.status !== "active") await publishAccountsChanged(deps.pubsub, orgId, machine.id);
    return row ?? existing;
  }
  const [row] = await deps.db
    .insert(machineAccounts)
    .values({
      id: info.id,
      orgId,
      machineId: machine.id,
      kind: info.kind,
      label: defaultAccountLabel(info.kind, plan),
      email,
      plan,
      status: "active",
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning();
  // Added meanwhile (a hello, another poll): read it back.
  if (!row) return getMachineAccount(deps.db, orgId, machine.id, info.id);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "account.added",
    target: { type: "machine_account", id: row.id },
    details: { machineId: machine.id, kind: row.kind, plan: row.plan },
  });
  await publishAccountsChanged(deps.pubsub, orgId, machine.id);
  return row;
}

/** Stops a sign-in (the runner kills the CLI and removes its folder). */
export async function cancelAccountLogin(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  loginId: string,
) {
  const id = loginIdOf(loginId);
  const machine = await liveOwnedMachine(deps, userId, orgId, machineId);
  await deps.hub.call(machine.id, { op: "account", action: "cancel", loginId: id });
}

// ── Naming and removing ─────────────────────────────────────────────────────

export const cleanAccountLabel = (label: unknown) =>
  typeof label === "string"
    ? label
        .replace(/[\p{Cc}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

/** What people call it (1 to 40 characters). Works with the computer offline. Audited. */
export async function renameMachineAccount(
  deps: MachineAccountDeps,
  userId: string,
  orgId: string,
  machineId: string,
  accountId: string,
  rawLabel: unknown,
): Promise<MachineAccountView> {
  const label = cleanAccountLabel(rawLabel);
  if (!label || label.length > MACHINE_ACCOUNT_LIMITS.labelChars) {
    throw new ValidationError("Give the account a name of up to 40 characters", "account.invalid_label");
  }
  const machine = await ownedMachine(deps.db, userId, orgId, machineId);
  const account = await getMachineAccount(deps.db, orgId, machine.id, accountId);
  if (!account) throw new NotFoundError("Account not found", "account.not_found");
  if (label === account.label) return accountViewOf(deps.db, orgId, account);
  const [row] = await deps.db
    .update(machineAccounts)
    .set({ label, updatedAt: new Date() })
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, account.id)))
    .returning();
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "account.renamed",
    target: { type: "machine_account", id: account.id },
    details: { machineId: machine.id, from: account.label, to: label },
  });
  await publishAccountsChanged(deps.pubsub, orgId, machine.id);
  return accountViewOf(deps.db, orgId, row ?? { ...account, label });
}

/**
 * Removes an account (ADR 0041 §7): the runner signs the CLI out there and
 * deletes the folder, the agents that used it go back to the computer's own
 * sign-in, and the row goes. Audited.
 */
export async function removeMachineAccount(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  accountId: string,
) {
  const machine = await liveOwnedMachine(deps, userId, orgId, machineId);
  const account = await getMachineAccount(deps.db, orgId, machine.id, accountId);
  if (!account) throw new NotFoundError("Account not found", "account.not_found");
  const kind: AccountKind = isAccountKind(account.kind) ? account.kind : "claude_code";
  try {
    await deps.hub.call(machine.id, { op: "account", action: "remove", kind, accountId: account.id });
  } catch (error) {
    // Already gone from the computer: the row goes too.
    if (!(error instanceof MachineRequestError && error.code === "not_found")) throw error;
  }
  const released = await deps.db.transaction(async (tx) => {
    const ids = await releaseAgents(tx, orgId, [account.id]);
    await tx.delete(machineAccounts).where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, account.id)));
    return ids;
  });
  forgetAgents(orgId, released);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "account.removed",
    target: { type: "machine_account", id: account.id },
    details: { machineId: machine.id, kind: account.kind, agents: released },
  });
  await publishAccountsChanged(deps.pubsub, orgId, machine.id);
}
