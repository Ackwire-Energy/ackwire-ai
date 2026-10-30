import {
  ACCOUNT_KINDS,
  ACCOUNT_LOGIN_TTL_MS,
  ACCOUNTS_PROTOCOL,
  type AccountKind,
  type AccountLoginState,
  accountCodeAad,
  isAccountId,
  isAccountKind,
  isLoginEmail,
  MAX_MACHINE_ACCOUNTS,
  type MachineReplies,
  OWN_USAGE_ID,
  type OwnPlanUsage,
  PLAN_KEYS_PROTOCOL,
  PLAN_USAGE_PROTOCOL,
  type PlanUsage,
  type PubSub,
  parseSecretBox,
  type RunnerAccountInfo,
} from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNotNull, isNull, ne, schema, sql } from "@agenteschat/db";
import { isPlanId, loginPerAgent, type PlanId, planOf } from "@agenteschat/providers/plans";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import {
  getMachine,
  MACHINE_CONTROL_TOPIC,
  MachineOfflineError,
  type MachineRow,
  publishMachineUpdated,
} from "./machines";
import { can, requirePermission } from "./organizations";

const { machineAccounts, agents, machines, users } = schema;

/*
 * Accounts of the computer brains on a connected computer (ADR 0041, ADR
 * 0059): a folder on the machine where Claude Code or Codex keeps its own
 * sign-in. We keep metadata only (email, plan, signed in or not); the sign-in
 * itself goes through the provider's CLI on the computer, and a Claude code
 * typed in the browser reaches the runner sealed to the machine's key.
 *
 * An account belongs to the person who started its sign-in: its row is
 * written when the sign-in starts (`signing_in`), never inferred later from
 * who asked first. One the desktop app signed in is the computer's pairer's.
 * Only the owner sees its email, renames it, picks it for an agent or signs
 * in to it again; the owner or the computer's pairer removes it (an admin
 * too, when the computer or the account has no person). The pairer adds
 * accounts to a computer; on one nobody paired (the Cloud's, a server's own),
 * any member does. Removing leaves a tombstone (`removing`) until the runner
 * has signed the account out and deleted its folder, now or when it is back.
 *
 * Usage (protocol 19): what the runner says about each plan's limits, during
 * turns or when someone looks (`refreshAiAccounts`), is stored with the row
 * (the computer's own sign-ins' in `machines.executors.ownUsage`); pages hear
 * of it only when they would show something else (`usageMoved`).
 *
 * Key accounts (protocol 20): a coding plan on Claude Code (`provider`, a plan
 * of `@agenteschat/providers/plans`). The key goes sealed from the browser to
 * the computer and stays there; we keep its last 4 as the runner says them.
 *
 * Logins per agent: a login thinks for one agent, and an account whose plan
 * allows it (`LOGIN_PER_AGENT`) has one login per agent, the same account
 * signed in again. Its logins share one name, told apart by the account's
 * email or key's last 4 (`sameAccountWhere`), and a rename renames them all.
 */

export type MachineAccountRow = typeof machineAccounts.$inferSelect;
export type MachineAccountStatus = "active" | "signed_out";

/** Rows that are accounts: not a sign-in still in progress, not a tombstone. */
export const LISTED_ACCOUNT_STATUSES = ["active", "signed_out"];

export interface MachineAccountView {
  id: string;
  kind: AccountKind;
  label: string;
  /** Its owner's eyes only. */
  email: string | null;
  plan: string | null;
  status: MachineAccountStatus;
  /** Whose it is; null: nobody's (its person was deleted, or the desktop app signed it in where nobody paired). */
  ownerId: string | null;
  ownerName: string | null;
  /** The viewer owns it. */
  mine: boolean;
  /** Names of the agents that think with it. */
  usedBy: string[];
  /** The plan's usage limits as last reported (protocol 19); null: not known yet. */
  usage: PlanUsage | null;
  /** A key account's coding plan (`zai`, `kimi`…); null: the CLI's own sign-in. */
  provider: string | null;
  /** The last 4 of a key account's key, for its owner's eyes only. */
  keyHint: string | null;
}

/** An account on a computer, by what the runner needs to remove it. */
export interface MachineAccountRef {
  kind: AccountKind;
  id: string;
}

export const MACHINE_ACCOUNT_LIMITS = { labelChars: 40 };
/** A sign-in started from the app stays one this long without the runner listing it (its TTL, plus a reply on its way). */
const SIGNING_IN_KEEP_MS = ACCOUNT_LOGIN_TTL_MS + 60_000;

export interface MachineAccountDeps {
  db: Database;
  pubsub?: PubSub;
}

export interface MachineAccountHubDeps extends MachineAccountDeps {
  hub: Pick<MachineCaller, "call" | "status">;
}

const kindOf = (row: Pick<MachineAccountRow, "kind">): AccountKind =>
  isAccountKind(row.kind) ? row.kind : "claude_code";

/**
 * What a new account is called until its owner names it: the maker and the
 * plan ("Claude Max", "ChatGPT Plus", "GLM Coding"), numbered among the names
 * its owner already has ("Claude Team 2"); never the email (others see the name).
 */
export function defaultAccountLabel(
  kind: AccountKind,
  plan?: string | null,
  taken: readonly string[] = [],
  provider?: string | null,
) {
  const word = plan && /^[\w.-]{1,20}$/.test(plan) ? ` ${plan[0]?.toUpperCase()}${plan.slice(1)}` : "";
  const base = planOf(provider)?.label ?? `${kind === "codex" ? "ChatGPT" : "Claude"}${word}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** The names of an owner's accounts in the organization (`exceptId`'s aside). */
async function takenLabels(db: Executor, orgId: string, ownerId: string | null, exceptId: string) {
  const rows = await db
    .select({ label: machineAccounts.label })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        ownerId ? eq(machineAccounts.createdBy, ownerId) : isNull(machineAccounts.createdBy),
        inArray(machineAccounts.status, LISTED_ACCOUNT_STATUSES),
        ne(machineAccounts.id, exceptId),
      ),
    );
  return rows.map((r) => r.label);
}

const statusOf = (v: string): MachineAccountStatus => (v === "active" ? "active" : "signed_out");

function accountView(
  row: MachineAccountRow,
  usedBy: string[],
  viewerId: string | null,
  ownerName: string | null,
): MachineAccountView {
  const mine = viewerId !== null && row.createdBy === viewerId;
  return {
    id: row.id,
    kind: kindOf(row),
    label: row.label,
    email: mine ? row.email : null,
    plan: row.plan,
    status: statusOf(row.status),
    ownerId: row.createdBy,
    ownerName,
    mine,
    usedBy,
    usage: row.usage ?? null,
    provider: row.provider,
    keyHint: mine ? row.keyHint : null,
  };
}

/** People would see a difference: a window moved a point or more, its reset moved, one came or went, or the limit. */
export function usageMoved(prev: PlanUsage | null | undefined, next: PlanUsage | null | undefined): boolean {
  if (!prev || !next) return Boolean(prev) !== Boolean(next);
  if (Boolean(prev.limited) !== Boolean(next.limited) || prev.windows.length !== next.windows.length) return true;
  return next.windows.some((w) => {
    const p = prev.windows.find((x) => x.kind === w.kind && x.label === w.label);
    return !p || Math.abs(p.usedPercent - w.usedPercent) >= 1 || p.resetsAt !== w.resetsAt;
  });
}

/**
 * The accounts on a machine, both kinds, oldest first, with whose each is and
 * the agents that use it; emails only of the viewer's own. No permission check.
 */
export async function listMachineAccounts(
  deps: Pick<MachineAccountDeps, "db">,
  orgId: string,
  machineId: string,
  viewerId: string | null,
): Promise<MachineAccountView[]> {
  const rows = await deps.db
    .select({ account: machineAccounts, ownerName: users.name })
    .from(machineAccounts)
    .leftJoin(users, eq(users.id, machineAccounts.createdBy))
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.machineId, machineId),
        inArray(machineAccounts.status, LISTED_ACCOUNT_STATUSES),
      ),
    )
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
          rows.map((r) => r.account.id),
        ),
        isNull(agents.archivedAt),
      ),
    )
    .orderBy(agents.name);
  return rows.map(({ account, ownerName }) =>
    accountView(
      account,
      using.filter((a) => a.accountId === account.id).map((a) => a.name),
      viewerId,
      ownerName,
    ),
  );
}

async function accountViewOf(db: Database, orgId: string, row: MachineAccountRow, viewerId: string) {
  const views = await listMachineAccounts({ db }, orgId, row.machineId, viewerId);
  return views.find((v) => v.id === row.id) ?? accountView(row, [], viewerId, null);
}

/**
 * Agents that used these accounts lose them: back to the computer's own
 * sign-in when that is their owner's, else to the API (a plan thinks only for
 * its owner's agents, ADR 0059 §3). Their cache goes with `forgetAgents`.
 */
export async function releaseAgents(db: Executor, orgId: string, accountIds: string[], now = new Date()) {
  if (accountIds.length === 0) return [];
  const rows = await db
    .update(agents)
    .set({
      brainAccountId: null,
      brain: sql`case when exists (select 1 from ${machines} m where m.id = "agents"."machine_id"
        and m.paired_by_user_id = "agents"."owner_user_id") then "agents"."brain" else 'model' end`,
      updatedAt: now,
    })
    .where(and(eq(agents.orgId, orgId), inArray(agents.brainAccountId, accountIds)))
    .returning({ id: agents.id });
  return rows.map((r) => r.id);
}

export const forgetAgents = (orgId: string, ids: string[]) => {
  for (const id of ids) caches.agents.delete(`${orgId}:${id}`);
};

/** The page that shows a machine's accounts refetches them (no emails in the event). */
const publishAccountsChanged = (pubsub: PubSub | undefined, orgId: string, machineId: string) =>
  publishMachineUpdated(pubsub, orgId, machineId, { accounts: true });

/** These accounts are being removed: their agents are released now, the rows wait for the runner. */
async function tombstone(db: Executor, orgId: string, ids: string[], now = new Date()) {
  if (ids.length === 0) return [];
  await db
    .update(machineAccounts)
    .set({ status: "removing", updatedAt: now })
    .where(and(eq(machineAccounts.orgId, orgId), inArray(machineAccounts.id, ids)));
  return releaseAgents(db, orgId, ids, now);
}

/** The runner removed it (or never had it): the tombstone goes. */
export async function forgetRemovedAccount(db: Executor, orgId: string, accountId: string) {
  await db
    .delete(machineAccounts)
    .where(
      and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, accountId), eq(machineAccounts.status, "removing")),
    );
}

/** The tombstones on a machine: what its runner still has to sign out and delete. */
export async function accountsToRemove(db: Executor, orgId: string, machineId: string): Promise<MachineAccountRef[]> {
  const rows = await db
    .select({ id: machineAccounts.id, kind: machineAccounts.kind })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.machineId, machineId),
        eq(machineAccounts.status, "removing"),
      ),
    );
  return rows.map((r) => ({ id: r.id, kind: kindOf(r) }));
}

/** Signs these out and deletes their folders on the computer now; offline, it happens at its next hello. */
async function removeOnComputer(
  deps: MachineAccountHubDeps,
  orgId: string,
  machineId: string,
  refs: MachineAccountRef[],
) {
  for (const ref of refs) {
    try {
      await deps.hub.call(machineId, { op: "account", action: "remove", kind: ref.kind, accountId: ref.id });
    } catch (error) {
      if (!(error instanceof MachineRequestError && error.code === "not_found")) continue;
    }
    await forgetRemovedAccount(deps.db, orgId, ref.id);
  }
}

type AccountKey = Pick<MachineAccountRow, "orgId" | "machineId" | "kind" | "createdBy" | "provider">;
type AccountIdentity = { email?: string | null; keyHint?: string | null };

/**
 * The logins of one account on this computer, its owner's: the same CLI, plan and email, or for a key account
 * the same key's last 4 (the key never leaves the computer). Never the label, which any rename can repeat.
 * Undefined while neither is known.
 */
function sameAccountWhere(row: AccountKey, same: AccountIdentity) {
  // ponytail: a key account is told apart by its last 4 only; a fingerprint from the runner if two keys ever share them.
  const match = row.provider
    ? same.keyHint
      ? eq(machineAccounts.keyHint, same.keyHint)
      : null
    : same.email
      ? sql`lower(${machineAccounts.email}) = ${same.email.toLowerCase()}`
      : null;
  if (!match) return undefined;
  return and(
    eq(machineAccounts.orgId, row.orgId),
    eq(machineAccounts.machineId, row.machineId),
    eq(machineAccounts.kind, row.kind),
    row.createdBy ? eq(machineAccounts.createdBy, row.createdBy) : isNull(machineAccounts.createdBy),
    row.provider ? eq(machineAccounts.provider, row.provider) : isNull(machineAccounts.provider),
    inArray(machineAccounts.status, LISTED_ACCOUNT_STATUSES),
    match,
  );
}

/** Another login of the same account (`sameAccountWhere`), the oldest. */
async function sameAccount(db: Executor, row: AccountKey & Pick<MachineAccountRow, "id">, same: AccountIdentity) {
  const where = sameAccountWhere(row, same);
  if (!where) return null;
  const [other] = await db
    .select()
    .from(machineAccounts)
    .where(and(where, ne(machineAccounts.id, row.id)))
    .orderBy(machineAccounts.createdAt, machineAccounts.id)
    .limit(1);
  return other ?? null;
}

/**
 * The login of this account its owner already has here, which makes this one a duplicate. None where the
 * account may have one login per agent (`LOGIN_PER_AGENT`).
 */
const duplicateOf = async (db: Executor, row: AccountKey & Pick<MachineAccountRow, "id">, same: AccountIdentity) =>
  loginPerAgent(row.kind, row.provider) ? null : sameAccount(db, row, same);

interface Settled {
  /** The account as stored now; null: it isn't this computer's. */
  row: MachineAccountRow | null;
  /** Its owner already has it on this computer: this one is a tombstone now, for the runner to remove. */
  duplicate?: MachineAccountRow;
  /**
   * Signed in again, but as another account: `email`, or `duplicate`, one its owner already has here. It stays as it
   * was, signed out, with its agents.
   */
  other?: { email: string | null; duplicate?: MachineAccountRow };
  /** Agents released (a duplicate that some agent already used). */
  released: string[];
  /** Something people see changed. */
  changed: boolean;
}

/**
 * What the runner says about an account whose row exists: a sign-in started
 * from the app finishes (named after its plan, audited for its owner, who
 * never changes), a known one is refreshed. `dedupe` (the person who signed
 * in is asking, so they hear why): one their own account on this computer
 * already is becomes a tombstone. A known account that signed in as another
 * one (`other`) keeps what it was, signed out.
 */
async function settleAccount(
  db: Executor,
  orgId: string,
  machine: Pick<MachineRow, "id">,
  info: RunnerAccountInfo,
  dedupe: boolean,
  now = new Date(),
): Promise<Settled> {
  const [row] = await db
    .select()
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, info.id)));
  if (!row || row.machineId !== machine.id || row.kind !== info.kind)
    return { row: null, released: [], changed: false };
  if (row.status === "removing") {
    const duplicate = await duplicateOf(db, row, row);
    return { row, ...(duplicate ? { duplicate } : {}), released: [], changed: false };
  }
  // A signed-out CLI may not say its email or plan any more: keep what we knew.
  const email = info.email ?? row.email;
  const plan = info.plan ?? row.plan;
  const keyHint = info.keyHint ?? row.keyHint;
  const status: MachineAccountStatus = info.loggedIn ? "active" : "signed_out";
  const signingIn = row.status === "signing_in";
  // Signed in again as another account (an email other than its own, or one its owner already has here): it stays
  // signed out with what it was, so its agents never think with an account nobody chose for them, and Try again signs
  // in to it once more. Checked on every report, not only when its owner asks: the runner reports a new login at once.
  // ponytail: that login stays in the account's folder on the computer until it signs in again or is removed (nothing
  // thinks with a signed-out account); a runner sign-out that keeps the folder, if a stray login there ever matters.
  if (!signingIn && info.loggedIn && (email !== row.email || keyHint !== row.keyHint)) {
    const otherEmail = Boolean(row.email && info.email && row.email.toLowerCase() !== info.email.toLowerCase());
    const duplicate = await duplicateOf(db, row, { email, keyHint });
    if (otherEmail || duplicate) {
      const [kept] =
        row.status === "signed_out"
          ? [row]
          : await db
              .update(machineAccounts)
              .set({ status: "signed_out", updatedAt: now })
              .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, row.id)))
              .returning();
      return {
        row: kept ?? row,
        other: { email: info.email ?? null, ...(duplicate ? { duplicate } : {}) },
        released: [],
        changed: row.status !== "signed_out",
      };
    }
  }
  const duplicate = dedupe ? await duplicateOf(db, row, { email, keyHint }) : null;
  if (duplicate) {
    const [gone] = await db
      .update(machineAccounts)
      .set({ status: "removing", email, plan, keyHint, updatedAt: now })
      .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, row.id)))
      .returning();
    const released = await releaseAgents(db, orgId, [row.id], now);
    return { row: gone ?? row, duplicate, released, changed: !signingIn };
  }
  // The runner says it when it knows it; one that just started doesn't yet (the last stays).
  const usage = info.usage ? { usage: info.usage } : {};
  if (signingIn) {
    // A login of an account its owner already has here (one per agent) takes that account's name.
    const label =
      (await sameAccount(db, row, { email, keyHint }))?.label ??
      defaultAccountLabel(kindOf(row), plan, await takenLabels(db, orgId, row.createdBy, row.id), row.provider);
    const [done] = await db
      .update(machineAccounts)
      .set({ email, plan, keyHint, status, label, ...usage, updatedAt: now })
      .where(
        and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, row.id), eq(machineAccounts.status, "signing_in")),
      )
      .returning();
    // Finished meanwhile by the other path (the runner's report, the person's poll): as it is now.
    if (!done) return settleAccount(db, orgId, machine, info, false, now);
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: row.createdBy },
      action: "account.added",
      target: { type: "machine_account", id: row.id },
      details: { machineId: machine.id, kind: row.kind, plan, ...(row.provider ? { provider: row.provider } : {}) },
    });
    return { row: done, released: [], changed: true };
  }
  const same = email === row.email && plan === row.plan && keyHint === row.keyHint && status === row.status;
  if (same && !info.usage) return { row, released: [], changed: false };
  const [fresh] = await db
    .update(machineAccounts)
    .set({ email, plan, keyHint, status, ...usage, updatedAt: now })
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, row.id)))
    .returning();
  return { row: fresh ?? row, released: [], changed: !same || usageMoved(row.usage, info.usage) };
}

/**
 * `hello.accounts` (protocol 13): the machine says which accounts it has.
 * Sign-ins started from the app finish, known accounts get their email, plan
 * and status, ones it signed in by itself (the desktop app) are added as its
 * pairer's, and the ones it no longer has are removed (their agents are
 * released, `releaseAgents`). A sign-in still in progress is kept until
 * it would have expired. An id that belongs to a disconnected machine of the
 * organization (this computer, paired again as a new one) moves here with its
 * name and owner; one that belongs to a live machine is ignored. A list as
 * long as `MAX_MACHINE_ACCOUNTS` may be cut, so nothing is removed from it.
 * Returns the accounts the runner must still remove (tombstones it listed,
 * duplicates of its pairer's that it signed in by itself).
 */
export async function syncMachineAccounts(
  deps: MachineAccountDeps,
  orgId: string,
  machineId: string,
  accounts: RunnerAccountInfo[],
): Promise<MachineAccountRef[]> {
  const reported = new Map<string, RunnerAccountInfo>();
  for (const a of accounts) if (isAccountId(a.id) && isAccountKind(a.kind)) reported.set(a.id, a);
  const now = new Date();
  const out = await deps.db.transaction(async (tx) => {
    const [machine] = await tx
      .select()
      .from(machines)
      .where(and(eq(machines.orgId, orgId), eq(machines.id, machineId)));
    if (!machine) return null;
    const existing = await tx
      .select()
      .from(machineAccounts)
      .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.machineId, machineId)));
    let changed = false;
    const released: string[] = [];
    const remove: MachineAccountRef[] = [];
    if (accounts.length < MAX_MACHINE_ACCOUNTS) {
      const gone = existing.filter(
        (r) =>
          !reported.has(r.id) &&
          !(r.status === "signing_in" && now.getTime() - r.createdAt.getTime() < SIGNING_IN_KEEP_MS),
      );
      if (gone.length > 0) {
        const ids = gone.map((r) => r.id);
        released.push(...(await releaseAgents(tx, orgId, ids, now)));
        await tx
          .delete(machineAccounts)
          .where(
            and(
              eq(machineAccounts.orgId, orgId),
              eq(machineAccounts.machineId, machineId),
              inArray(machineAccounts.id, ids),
            ),
          );
        changed ||= gone.some((r) => LISTED_ACCOUNT_STATUSES.includes(r.status));
      }
    }
    for (const a of reported.values()) {
      const row = existing.find((r) => r.id === a.id);
      if (row?.status === "removing") {
        remove.push({ kind: kindOf(row), id: row.id });
        continue;
      }
      if (row) {
        if ((await settleAccount(tx, orgId, machine, a, false, now)).changed) changed = true;
        continue;
      }
      const [elsewhere] = await tx
        .select()
        .from(machineAccounts)
        .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, a.id)));
      if (!elsewhere) {
        // Signed in on the computer itself (the desktop app): its pairer's.
        const owner = machine.pairedByUserId;
        const provider = isPlanId(a.provider) ? a.provider : null;
        const candidate = { orgId, machineId, id: a.id, kind: a.kind, createdBy: owner, provider };
        const same = await sameAccount(tx, candidate, a);
        if (same && !loginPerAgent(a.kind, provider)) {
          remove.push({ kind: a.kind, id: a.id });
          continue;
        }
        const inserted = await tx
          .insert(machineAccounts)
          .values({
            ...candidate,
            label:
              same?.label ?? defaultAccountLabel(a.kind, a.plan, await takenLabels(tx, orgId, owner, a.id), provider),
            email: a.email ?? null,
            plan: a.plan ?? null,
            keyHint: a.keyHint ?? null,
            status: a.loggedIn ? "active" : "signed_out",
            usage: a.usage ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: machineAccounts.id });
        changed ||= inserted.length > 0;
        continue;
      }
      // Taken: by a machine that was disconnected (this computer before it was paired again), it comes here.
      const [moved] = await tx
        .update(machineAccounts)
        .set(
          elsewhere.status === "removing"
            ? { machineId, updatedAt: now }
            : {
                machineId,
                email: a.email ?? elsewhere.email,
                plan: a.plan ?? elsewhere.plan,
                keyHint: a.keyHint ?? elsewhere.keyHint,
                status: a.loggedIn ? "active" : "signed_out",
                ...(a.usage ? { usage: a.usage } : {}),
                updatedAt: now,
              },
        )
        .where(
          and(
            eq(machineAccounts.orgId, orgId),
            eq(machineAccounts.id, a.id),
            eq(machineAccounts.kind, a.kind),
            inArray(
              machineAccounts.machineId,
              tx
                .select({ id: machines.id })
                .from(machines)
                .where(and(eq(machines.orgId, orgId), isNotNull(machines.deletedAt))),
            ),
          ),
        )
        .returning({ status: machineAccounts.status });
      if (moved?.status === "removing") remove.push({ kind: a.kind, id: a.id });
      else if (moved) changed = true;
    }
    return { changed, released, remove };
  });
  if (!out) return [];
  forgetAgents(orgId, out.released);
  if (out.changed) await publishAccountsChanged(deps.pubsub, orgId, machineId);
  return out.remove;
}

/**
 * The computer's own sign-ins' usage (protocol 19, `accounts.changed`), over the last known of each brain;
 * the pages hear it when they would show something else.
 */
export async function storeOwnUsage(deps: MachineAccountDeps, orgId: string, machineId: string, own: OwnPlanUsage) {
  if (!ACCOUNT_KINDS.some((k) => own[k])) return;
  const where = and(eq(machines.orgId, orgId), eq(machines.id, machineId));
  const [row] = await deps.db.select({ executors: machines.executors }).from(machines).where(where);
  if (!row) return;
  const prev = row.executors?.ownUsage ?? {};
  const next = { ...prev, ...own };
  // Only this key: what `hello` wrote meanwhile (the CLIs, the browser) stays.
  await deps.db
    .update(machines)
    .set({ executors: sql`${machines.executors} || ${JSON.stringify({ ownUsage: next })}::jsonb` })
    .where(where);
  if (ACCOUNT_KINDS.some((k) => usageMoved(prev[k], next[k])))
    await publishAccountsChanged(deps.pubsub, orgId, machineId);
}

/**
 * `POST …/ai-accounts/refresh` (an accounts screen opened): the caller's accounts, and the own sign-ins of
 * the computers they connected, look their usage up again on each online computer that can. The runner
 * decides how often each really is (`list.fresh`); what it finds comes back as `accounts.changed`.
 */
export async function refreshAiAccounts(deps: MachineAccountHubDeps, userId: string, orgId: string) {
  await requirePermission(deps.db, userId, orgId, "read");
  const mine = await deps.db
    .select({ id: machineAccounts.id, machineId: machineAccounts.machineId })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.createdBy, userId),
        inArray(machineAccounts.status, LISTED_ACCOUNT_STATUSES),
      ),
    );
  const paired = await deps.db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.pairedByUserId, userId), isNull(machines.deletedAt)));
  const fresh = new Map<string, string[]>();
  for (const a of mine) fresh.set(a.machineId, [...(fresh.get(a.machineId) ?? []), a.id]);
  for (const m of paired) fresh.set(m.id, [...(fresh.get(m.id) ?? []), ...Object.values(OWN_USAGE_ID)]);
  await Promise.all(
    [...fresh].map(async ([machineId, ids]) => {
      const status = await deps.hub.status(machineId);
      if (!status?.online || status.protocol < PLAN_USAGE_PROTOCOL) return;
      await deps.hub.call(machineId, { op: "account", action: "list", fresh: ids }).catch(() => undefined);
    }),
  );
}

/** A turn ran with it (best effort, after the turn). */
export async function touchMachineAccount(db: Executor, orgId: string, accountId: string) {
  await db
    .update(machineAccounts)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, accountId)));
}

/** One row of the organization's accounts, on that machine, whatever its status. */
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

/** An account on that machine (not a sign-in in progress, not one being removed). */
export async function getListedAccount(db: Executor, orgId: string, machineId: string, accountId: string) {
  const row = await getMachineAccount(db, orgId, machineId, accountId);
  return row && LISTED_ACCOUNT_STATUSES.includes(row.status) ? row : null;
}

// ── Who may ─────────────────────────────────────────────────────────────────

/**
 * Who adds accounts to a computer: the person who connected it (other
 * people's sign-ins on someone's own computer would need their consent, and
 * outlive it), or any member on one nobody did (the Cloud's, a server's own).
 */
export const mayAddAccounts = (machine: Pick<MachineRow, "pairedByUserId">, userId: string) =>
  machine.pairedByUserId === null || machine.pairedByUserId === userId;

/** A member and the machine of the organization. */
async function memberMachine(db: Database, userId: string, orgId: string, machineId: string) {
  const membership = await requirePermission(db, userId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  return { membership, machine };
}

const runnerOld = (machine: Pick<MachineRow, "name">) =>
  new ConflictError(`The runner on ${machine.name} is too old for accounts. Update it.`, "account.runner_old", {
    name: machine.name,
  });

/** On a runner that knows accounts (`protocol`: and what is asked of it), and online now. */
async function requireLive(deps: MachineAccountHubDeps, machine: MachineRow, protocol = ACCOUNTS_PROTOCOL) {
  if (machine.protocol < protocol) throw runnerOld(machine);
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  if (status.protocol < protocol) throw runnerOld(machine);
}

const loginIdOf = (loginId: string) => {
  if (!isAccountId(loginId)) throw new NotFoundError("Sign-in not found", "account.login_not_found");
  return loginId;
};

/** The sign-in `loginId` on the machine, when `userId` started it: nobody else sends its code, follows or stops it. */
async function ownSignIn(db: Database, userId: string, orgId: string, machineId: string, loginId: string) {
  const row = await getMachineAccount(db, orgId, machineId, loginIdOf(loginId));
  if (!row || row.status === "removing") throw new NotFoundError("Sign-in not found", "account.login_not_found");
  if (row.createdBy !== userId) {
    throw new ForbiddenError("Only the person who started this sign-in can go on with it", "account.not_owner");
  }
  return row;
}

// ── The page ────────────────────────────────────────────────────────────────

/**
 * `GET …/machines/{id}/accounts`: the person who connected it, an admin, or
 * anyone on a computer nobody connected. Emails only of the caller's own.
 * `canManage`: the caller adds accounts there, on a runner that knows them.
 */
export async function getMachineAccounts(
  deps: Pick<MachineAccountDeps, "db">,
  userId: string,
  orgId: string,
  machineId: string,
) {
  const { membership, machine } = await memberMachine(deps.db, userId, orgId, machineId);
  const adds = mayAddAccounts(machine, userId);
  if (!adds && !can(membership.role, "configure")) {
    throw new ForbiddenError(
      "Only an admin or the person who connected this computer can see its accounts",
      "machine.forbidden",
    );
  }
  const supported = machine.protocol >= ACCOUNTS_PROTOCOL;
  return {
    accounts: await listMachineAccounts(deps, orgId, machine.id, userId),
    canManage: adds && supported,
    supported,
  };
}

// ── Signing in (ADR 0041 §2, ADR 0059 §1) ───────────────────────────────────

export interface AccountLoginView {
  loginId: string;
  kind: AccountKind;
  /** The provider's page (Claude's sign-in, Codex's device page, or where a plan's key is made). */
  url: string;
  /** A key account's coding plan. */
  provider?: PlanId;
  /** Claude Code: the key the browser seals the pasted code to (raw P-256, base64). */
  publicKey?: string;
  /** Codex: the one-time code to type on its page. */
  userCode?: string;
  expiresAt: string;
}

const PUBLIC_KEY = /^[A-Za-z0-9+/=_-]{20,200}$/;
const USER_CODE = /^[A-Za-z0-9-]{4,20}$/;

/** A sign-in started from the app that didn't finish: its row goes (the runner removes its folder). */
async function dropSignIn(db: Executor, orgId: string, loginId: string) {
  await db
    .delete(machineAccounts)
    .where(
      and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, loginId), eq(machineAccounts.status, "signing_in")),
    );
}

/**
 * Starts the CLI's sign-in on the computer, in a new account folder named
 * `loginId`, as the caller's account from this moment on.
 */
export async function beginAccountLogin(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  kind: unknown,
  /** Sign in again to this account (signed out): same id, same folder, the agents that use it keep it. Its owner's. */
  accountId?: string,
  /** Claude Code: which account to sign in to, as the CLI's login hint. */
  email?: string,
  /** A coding plan's key account on Claude Code (protocol 20): the key comes next, sealed like a code. */
  provider?: string,
): Promise<AccountLoginView> {
  if (!isAccountKind(kind)) throw new ValidationError("Choose claude_code or codex", "account.invalid_kind");
  if (email !== undefined && (kind !== "claude_code" || provider !== undefined || !isLoginEmail(email))) {
    throw new ValidationError("Use a plain email address, like ana@example.com", "account.invalid_email");
  }
  if (provider !== undefined && (kind !== "claude_code" || !isPlanId(provider))) {
    throw new ValidationError("Choose one of the coding plans", "account.invalid_plan");
  }
  const plan = planOf(provider);
  const { machine } = await memberMachine(deps.db, userId, orgId, machineId);
  if (accountId !== undefined) {
    const existing = await getListedAccount(deps.db, orgId, machine.id, accountId);
    if (!existing || existing.kind !== kind || (existing.provider ?? undefined) !== provider) {
      throw new ValidationError("That account isn't on this computer", "account.invalid");
    }
    if (existing.createdBy !== userId) {
      throw new ForbiddenError("Only the account's owner can sign in to it again", "account.not_owner");
    }
  } else if (!mayAddAccounts(machine, userId)) {
    throw new ForbiddenError("Only the person who connected this computer can add accounts to it", "account.not_owner");
  }
  await requireLive(deps, machine, plan ? PLAN_KEYS_PROTOCOL : ACCOUNTS_PROTOCOL);
  const again = accountId !== undefined;
  const loginId = again ? accountId : crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ACCOUNT_LOGIN_TTL_MS).toISOString();
  if (!again) {
    await deps.db.insert(machineAccounts).values({
      id: loginId,
      orgId,
      machineId: machine.id,
      kind,
      label: defaultAccountLabel(kind, null, [], provider),
      status: "signing_in",
      createdBy: userId,
      provider: plan ? provider : null,
    });
  }
  const fail = async () => {
    await deps.hub.call(machine.id, { op: "account", action: "cancel", loginId }).catch(() => undefined);
    if (!again) await dropSignIn(deps.db, orgId, loginId);
  };
  let reply: MachineReplies["account"];
  try {
    reply = await deps.hub.call(machine.id, {
      op: "account",
      action: "begin",
      kind,
      loginId,
      ...(again ? { again: true } : {}),
      ...(email ? { email } : {}),
      ...(plan ? { provider } : {}),
    });
  } catch (error) {
    await fail();
    throw error;
  }
  const publicKey =
    typeof reply.publicKey === "string" && PUBLIC_KEY.test(reply.publicKey) ? reply.publicKey : undefined;
  if (plan && isPlanId(provider)) {
    // A plan's key: nothing signs in on the computer; the person makes the key on the plan's own page.
    if (!publicKey) {
      await fail();
      throw new ConflictError("The computer couldn't start the sign-in", "account.begin_failed", {
        name: machine.name,
      });
    }
    return { loginId, kind, url: plan.site, provider, publicKey, expiresAt };
  }
  // Only a provider page the person can open: never another scheme.
  let url: URL | null = null;
  try {
    url = reply.url ? new URL(reply.url) : null;
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:") {
    await fail();
    throw new ConflictError("The computer couldn't start the sign-in", "account.begin_failed", { name: machine.name });
  }
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
  const box = parseSecretBox(rawBox);
  if (!box) throw new ValidationError("The sealed code is malformed", "account.invalid_code");
  const { machine } = await memberMachine(deps.db, userId, orgId, machineId);
  const row = await ownSignIn(deps.db, userId, orgId, machine.id, loginId);
  await requireLive(deps, machine);
  await deps.hub.call(machine.id, {
    op: "account",
    action: "code",
    loginId: row.id,
    aad: accountCodeAad(row.id, orgId),
    box,
  });
}

export interface AccountLoginStatus {
  state: AccountLoginState;
  account?: MachineAccountView;
  /** `failed`: why, for people. */
  error?: string;
  /**
   * `failed`: the account that signed in is one the person already has on this computer (a new sign-in is removed
   * there): its name, and the account itself, theirs to think with instead.
   */
  duplicate?: { label: string; account: MachineAccountView };
  /** `failed`: signing in again came back as another account, this email; the account stays signed out. */
  signedInAs?: string;
}

const LOGIN_STATES: readonly AccountLoginState[] = ["waiting", "done", "failed", "expired"];

/** Where a sign-in is; once done, the account is stored (named after its plan) and returned. */
export async function accountLoginStatus(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  loginId: string,
): Promise<AccountLoginStatus> {
  const { machine } = await memberMachine(deps.db, userId, orgId, machineId);
  const row = await ownSignIn(deps.db, userId, orgId, machine.id, loginId);
  await requireLive(deps, machine);
  const reply = await deps.hub.call(machine.id, { op: "account", action: "status", loginId: row.id });
  const state: AccountLoginState = LOGIN_STATES.includes(reply.state as AccountLoginState)
    ? (reply.state as AccountLoginState)
    : "failed";
  const error = typeof reply.error === "string" ? reply.error.slice(0, 300) : undefined;
  if (state !== "done") {
    // The runner removed the folder of a new sign-in that ended without signing in.
    if (state !== "waiting") await dropSignIn(deps.db, orgId, row.id);
    return { state, ...(state === "failed" && error ? { error } : {}) };
  }
  const info = reply.account;
  if (!info || !isAccountId(info.id) || !isAccountKind(info.kind)) {
    return { state: "failed", error: "The computer didn't say which account signed in." };
  }
  if (info.id !== row.id) return { state: "failed", error: "The computer reported another account." };
  const settled = await deps.db.transaction((tx) => settleAccount(tx, orgId, machine, info, true));
  forgetAgents(orgId, settled.released);
  if (settled.other) {
    if (settled.changed) await publishAccountsChanged(deps.pubsub, orgId, machine.id);
    const { email, duplicate } = settled.other;
    return {
      state: "failed",
      error: "That's another account. This one stays signed out.",
      ...(email ? { signedInAs: email } : {}),
      ...(duplicate
        ? { duplicate: { label: duplicate.label, account: await accountViewOf(deps.db, orgId, duplicate, userId) } }
        : {}),
    };
  }
  if (settled.duplicate) {
    await removeOnComputer(deps, orgId, machine.id, [{ kind: info.kind, id: info.id }]);
    if (settled.changed) await publishAccountsChanged(deps.pubsub, orgId, machine.id);
    return {
      state: "failed",
      error: `That account is already on this computer (${settled.duplicate.label}).`,
      duplicate: {
        label: settled.duplicate.label,
        account: await accountViewOf(deps.db, orgId, settled.duplicate, userId),
      },
    };
  }
  if (!settled.row || !LISTED_ACCOUNT_STATUSES.includes(settled.row.status)) {
    return { state: "failed", error: "The account was removed from this computer." };
  }
  if (settled.changed) await publishAccountsChanged(deps.pubsub, orgId, machine.id);
  return { state, account: await accountViewOf(deps.db, orgId, settled.row, userId) };
}

/**
 * Stops a sign-in (the runner kills the CLI and removes its folder). The row
 * stays until the runner's list goes without it: a sign-in that finished just
 * before is still reported, and is still this person's.
 */
export async function cancelAccountLogin(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  loginId: string,
) {
  const { machine } = await memberMachine(deps.db, userId, orgId, machineId);
  const row = await ownSignIn(deps.db, userId, orgId, machine.id, loginId);
  await requireLive(deps, machine);
  await deps.hub.call(machine.id, { op: "account", action: "cancel", loginId: row.id });
}

// ── Naming and removing ─────────────────────────────────────────────────────

export const cleanAccountLabel = (label: unknown) =>
  typeof label === "string"
    ? label
        .replace(/[\p{Cc}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

/**
 * What people call it (1 to 40 characters): its owner only, for every login of the account on that computer
 * (one per agent, `sameAccountWhere`). Works with the computer offline. Audited per login.
 */
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
  const { machine } = await memberMachine(deps.db, userId, orgId, machineId);
  const account = await getListedAccount(deps.db, orgId, machine.id, accountId);
  if (!account) throw new NotFoundError("Account not found", "account.not_found");
  if (account.createdBy !== userId) {
    throw new ForbiddenError("Only the account's owner can rename it", "account.not_owner");
  }
  const logins = await deps.db
    .select()
    .from(machineAccounts)
    .where(
      sameAccountWhere(account, account) ?? and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, account.id)),
    )
    .orderBy(machineAccounts.createdAt, machineAccounts.id);
  const renamed = logins.filter((r) => r.label !== label);
  if (renamed.length === 0) return accountViewOf(deps.db, orgId, account, userId);
  await deps.db
    .update(machineAccounts)
    .set({ label, updatedAt: new Date() })
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        inArray(
          machineAccounts.id,
          renamed.map((r) => r.id),
        ),
      ),
    );
  for (const r of renamed) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.renamed",
      target: { type: "machine_account", id: r.id },
      details: { machineId: machine.id, from: r.label, to: label },
    });
  }
  await publishAccountsChanged(deps.pubsub, orgId, machine.id);
  return accountViewOf(deps.db, orgId, { ...account, label }, userId);
}

/**
 * Removes an account (ADR 0041 §7, ADR 0059 §1): its owner, the computer's
 * pairer, or an admin when the computer or the account has no person. The
 * agents that used it are released now (`releaseAgents`); the runner
 * signs the CLI out there and deletes the folder now, or at its next hello
 * when the computer is off, and the row goes then. Audited.
 */
export async function removeMachineAccount(
  deps: MachineAccountHubDeps,
  userId: string,
  orgId: string,
  machineId: string,
  accountId: string,
) {
  const { membership, machine } = await memberMachine(deps.db, userId, orgId, machineId);
  const account = await getListedAccount(deps.db, orgId, machine.id, accountId);
  if (!account) throw new NotFoundError("Account not found", "account.not_found");
  const allowed =
    account.createdBy === userId ||
    machine.pairedByUserId === userId ||
    (can(membership.role, "configure") && (machine.pairedByUserId === null || account.createdBy === null));
  if (!allowed) {
    throw new ForbiddenError(
      "Only the account's owner or the person who connected this computer can remove it",
      "account.not_owner",
    );
  }
  const released = await deps.db.transaction((tx) => tombstone(tx, orgId, [account.id]));
  forgetAgents(orgId, released);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "account.removed",
    target: { type: "machine_account", id: account.id },
    details: { machineId: machine.id, kind: account.kind, agents: released },
  });
  await publishAccountsChanged(deps.pubsub, orgId, machine.id);
  await removeOnComputer(deps, orgId, machine.id, [{ kind: kindOf(account), id: account.id }]);
}

// ── People who leave ────────────────────────────────────────────────────────

export interface ReleasedAccounts {
  /** The machines with new tombstones, by organization. */
  machines: { orgId: string; machineId: string }[];
  /** The agents released, by organization. */
  agents: { orgId: string; agentIds: string[] }[];
}

/**
 * A person left `orgId`, or deleted their account (`orgId` null: every
 * organization): their accounts become tombstones, never anyone else's, and
 * the agents that thought with them are released. Runs in the caller's
 * transaction; `announceReleasedAccounts` afterwards.
 */
export async function releaseMemberAccounts(
  db: Executor,
  userId: string,
  orgId: string | null,
): Promise<ReleasedAccounts> {
  const now = new Date();
  const rows = await db
    .update(machineAccounts)
    .set({ status: "removing", updatedAt: now })
    .where(
      and(
        eq(machineAccounts.createdBy, userId),
        ne(machineAccounts.status, "removing"),
        orgId ? eq(machineAccounts.orgId, orgId) : undefined,
      ),
    )
    .returning({ orgId: machineAccounts.orgId, id: machineAccounts.id, machineId: machineAccounts.machineId });
  const out: ReleasedAccounts = { machines: [], agents: [] };
  for (const org of new Set(rows.map((r) => r.orgId))) {
    const mine = rows.filter((r) => r.orgId === org);
    out.agents.push({
      orgId: org,
      agentIds: await releaseAgents(
        db,
        org,
        mine.map((r) => r.id),
        now,
      ),
    });
    for (const machineId of new Set(mine.map((r) => r.machineId))) out.machines.push({ orgId: org, machineId });
  }
  return out;
}

/** After `releaseMemberAccounts`: pages refetch, and the replica holding each machine's runner removes them. */
export async function announceReleasedAccounts(pubsub: PubSub | undefined, released: ReleasedAccounts) {
  for (const a of released.agents) forgetAgents(a.orgId, a.agentIds);
  for (const m of released.machines) {
    await publishAccountsChanged(pubsub, m.orgId, m.machineId);
    await pubsub
      ?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.accounts", machineId: m.machineId })
      .catch(() => undefined);
  }
}
