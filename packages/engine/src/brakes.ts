import { createHash } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { PERMISSION_TOOL } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import { accountablePerson, messageRoot, type RunAuthority } from "./authority";
import {
  AUTONOMY_DEFAULTS,
  type AutonomySettings,
  autonomySettings,
  COST_KINDS,
  type CostKind,
  LONG_STEPS,
  mayCall,
} from "./autonomy-settings";
import { crowdedAgents } from "./computer-queue";
import { publishDelivery } from "./delivery";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { insertMessage, type Message, messageView } from "./messages";
import { can, requireActiveMembership } from "./organizations";
import { enqueue } from "./outbox";
import { ACTIVE_RUN_STATUSES } from "./run-inbox";
import { deliverNoticeToRun } from "./run-resume";
import { type AgentRun, replyThreadOf } from "./runs";

export { AUTONOMY_DEFAULTS, type AutonomySettings, autonomySettings, COST_KINDS, type CostKind, LONG_STEPS, mayCall };

const { agents, agentRuns, autonomySignals, messages, organizationMembers } = schema;

/**
 * Autonomy brakes (ADR 0131): agents stay proactive, but work nobody asked for directly is bounded. Asking waits for
 * the answer (`endsAsking`), costly unrequested steps get a person's go first (`costlyGate`), one item is worked once
 * (`brakeWakes`: open work is linked, noise goes to a digest, repeats stop), parallel unrequested work has caps, and an
 * agent calls only the agents its settings allow (`callableAgents`). What a person asked is never held by these.
 */

// --- 1. Asking means waiting -------------------------------------------------------------------------------

/**
 * The reply ends asking something (its last line is a question): the person decides, so the run waits for them. Code
 * blocks and trailing marks, quotes and emoji don't count.
 */
export function endsAsking(text: string): boolean {
  const lines = text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return false;
  return /\?[\s"'»”’)*_~\p{Extended_Pictographic}]*$/u.test(last.replace(/\uFE0F/g, ""));
}

// --- 3. Costly unrequested work needs a go ------------------------------------------------------------------

const PR_COMMAND = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create|hub\s+pull-request)\b/;
const INSTALL_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)|pipx?\s+install|pip3\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|(?:apt|apt-get|brew|cargo|gem|go)\s+install)\b/;
const PR_TOOL = /(?:create|open)_?(?:a_)?(?:pull_?request|merge_?request)|(?:pull_?request|merge_?request)_?create/i;

const commandOf = (input: Record<string, unknown>) => (typeof input.command === "string" ? input.command : "");

/**
 * What a tool call costs, if it is a costly step (`CostKind`): a computer command (asked through the permission
 * prompt, or run directly) that opens a PR or installs packages, or a connector's tool that opens a PR.
 */
export function costlyKind(name: string, input: Record<string, unknown>): CostKind | null {
  if (name === PERMISSION_TOOL) {
    const inner = input.input;
    return inner && typeof inner === "object" && !Array.isArray(inner)
      ? costlyKind(typeof input.tool_name === "string" ? input.tool_name : "", inner as Record<string, unknown>)
      : null;
  }
  if (PR_TOOL.test(name)) return "pr";
  const command = commandOf(input);
  if (PR_COMMAND.test(command)) return "pr";
  if (INSTALL_COMMAND.test(command)) return "install";
  return null;
}

/** Who is behind a run decides whether the brakes apply: a person's request never meets them. */
export const unrequested = (authority: RunAuthority | null) => authority !== null && authority.kind !== "person";

/** A proposal card's meta (`meta.actionCard`). The card keeps its state; the signal row is the source of truth. */
export interface ProposalCard {
  kind: "autonomy_proposal";
  signalId: string;
  agentId: string;
  cost: CostKind;
  /** What it wants to do, in its words (the command or the tool, cut). */
  what: string;
  forUserId: string | null;
  state: "open" | "go" | "not_now" | "never" | "always";
  decidedByUserId: string | null;
}

export interface GateRun {
  orgId: string;
  agentId: string;
  runId: string;
  channelId: string;
  threadRootId: string;
}

export type GateRefusal = { message: string; code: string };

const PR_WINDOW_MS = 3600_000;

/**
 * The gate a costly step of unrequested work meets (ADR 0131 §3), on every brain (the Tool Gateway sees API calls,
 * bridged tools and a computer brain's permission prompts). Null: go (a person said go for this run, "always", or the
 * agent's setting is `go`; PRs within the hourly cap). Otherwise the refusal the agent reads; the first one posts the
 * proposal card for the person accountable (the routine's creator, else the agent's owner).
 */
export async function costlyGate(
  deps: { db: Database; pubsub?: PubSub },
  run: GateRun,
  authority: RunAuthority | null,
  cost: CostKind,
  what: string,
): Promise<GateRefusal | null> {
  if (!unrequested(authority)) return null;
  const { db } = deps;
  const [agent] = await db
    .select({ autonomy: agents.autonomyBrakes, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, run.orgId), eq(agents.id, run.agentId)));
  const settings = autonomySettings(agent?.autonomy);
  if (settings.never.includes(cost))
    return {
      code: "autonomy.never",
      message: `A person said never to ${COST_WORDS[cost]} for work nobody asked for. Don't do it; say in one line what you would have done, and stop.`,
    };
  const signals = await db
    .select({ id: autonomySignals.id, kind: autonomySignals.kind, state: autonomySignals.state })
    .from(autonomySignals)
    .where(
      and(
        eq(autonomySignals.orgId, run.orgId),
        eq(autonomySignals.runId, run.runId),
        eq(autonomySignals.kind, "proposal"),
        eq(autonomySignals.signature, cost),
      ),
    );
  const said = signals.find((s) => s.state !== "open")?.state;
  if (said === "not_now" || said === "never")
    return {
      code: "autonomy.declined",
      message: `A person said no to ${COST_WORDS[cost]} for this. Don't do it; finish without it and say what is left.`,
    };
  const go = settings.costly === "go" || settings.go.includes(cost) || said === "go" || said === "always";
  if (go) {
    if (cost !== "pr") return null;
    const [opened] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(autonomySignals)
      .where(
        and(
          eq(autonomySignals.orgId, run.orgId),
          eq(autonomySignals.agentId, run.agentId),
          eq(autonomySignals.kind, "pr"),
          gt(autonomySignals.createdAt, new Date(Date.now() - PR_WINDOW_MS)),
        ),
      );
    if (Number(opened?.n ?? 0) >= settings.maxPrsPerHour)
      return {
        code: "autonomy.pr_limit",
        message: `You already opened ${settings.maxPrsPerHour} PRs in the last hour for work nobody asked for (the limit in your settings). Don't open another now: list what is left in your reply and stop.`,
      };
    await db.insert(autonomySignals).values({
      orgId: run.orgId,
      agentId: run.agentId,
      kind: "pr",
      runId: run.runId,
      channelId: run.channelId,
      title: cutText(what, 200),
    });
    return null;
  }
  if (signals.some((s) => s.state === "open")) return waitingRefusal(cost);
  await proposeCostly(
    deps,
    run,
    (authority ? accountablePerson(authority) : null) ?? agent?.ownerUserId ?? null,
    cost,
    what,
  );
  return waitingRefusal(cost);
}

const COST_WORDS: Record<CostKind, string> = {
  pr: "opening a pull request",
  install: "installing packages",
  long: `going on past ${LONG_STEPS} steps`,
};

const waitingRefusal = (cost: CostKind): GateRefusal => ({
  code: "autonomy.needs_go",
  message: `Nobody asked for this directly, and ${COST_WORDS[cost]} is costly: a card now asks the person responsible whether to go ahead. Don't try it another way. End your turn with one short line of what you found and what you'd do; you'll be told their answer.`,
});

/** Posts the proposal card where the run answers, for `forUserId` (notified as the card's person). */
async function proposeCostly(
  deps: { db: Database; pubsub?: PubSub },
  run: GateRun,
  forUserId: string | null,
  cost: CostKind,
  what: string,
) {
  const message = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, run.orgId), eq(agentRuns.id, run.runId)));
    if (!row) return null;
    const [signal] = await tx
      .insert(autonomySignals)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        kind: "proposal",
        signature: cost,
        title: cutText(what, 300),
        channelId: run.channelId,
        runId: run.runId,
        state: "open",
      })
      .returning();
    if (!signal) return null;
    const card: ProposalCard = {
      kind: "autonomy_proposal",
      signalId: signal.id,
      agentId: run.agentId,
      cost,
      what: signal.title,
      forUserId,
      state: "open",
      decidedByUserId: null,
    };
    const posted = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId: replyThreadOf(row),
      author: { type: "agent", agentId: run.agentId, runId: run.runId, hop: row.hop },
      body: `Nobody asked for this directly: may I go ahead with ${COST_WORDS[cost]}? ${signal.title}`,
      meta: { actionCard: card, bodyCode: "autonomy_proposal", bodyParams: { cost } },
    });
    await tx.update(autonomySignals).set({ messageId: posted.id }).where(eq(autonomySignals.id, signal.id));
    await enqueue(tx, {
      orgId: run.orgId,
      kind: "notifications.message",
      payload: { messageId: posted.id },
      dedupeKey: `notifications.message:${posted.id}`,
      maxAttempts: 4,
    });
    return posted;
  });
  if (message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
}

/** A message's proposal card, or null. */
export function proposalCardOf(meta: Record<string, unknown> | null | undefined): ProposalCard | null {
  const c = meta?.actionCard as Partial<ProposalCard> | undefined;
  return c?.kind === "autonomy_proposal" && typeof c.signalId === "string" ? (c as ProposalCard) : null;
}

export type ProposalDecision = "go" | "not_now" | "never" | "always";
export const PROPOSAL_DECISIONS: readonly ProposalDecision[] = ["go", "not_now", "never", "always"];

/**
 * A person decides a proposal card: the person it is for, the agent's owner or an admin. `always` and `never` are
 * remembered on the agent (`autonomy.go` / `autonomy.never`) for that kind; every decision reaches the run that asked
 * as a notice, which wakes it.
 */
export async function decideCostlyProposal(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  signalId: string,
  decision: ProposalDecision,
) {
  if (!PROPOSAL_DECISIONS.includes(decision)) throw new ValidationError("Unknown decision");
  const { db } = deps;
  const [signal] = await db
    .select()
    .from(autonomySignals)
    .where(
      and(eq(autonomySignals.orgId, orgId), eq(autonomySignals.id, signalId), eq(autonomySignals.kind, "proposal")),
    );
  if (!signal?.messageId) throw new NotFoundError("Proposal not found");
  const [message] = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, signal.messageId)));
  const card = proposalCardOf(message?.meta);
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId, autonomy: agents.autonomyBrakes, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, signal.agentId)));
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [member] = await db
    .select({ handle: organizationMembers.handle })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, actorId)));
  if (!card || !agent || !member) throw new NotFoundError("Proposal not found");
  if (actorId !== card.forUserId && actorId !== agent.ownerUserId && !can(membership, "manage_agents"))
    throw new NotFoundError("Proposal not found");
  const cost = signal.signature as CostKind;
  const out = await db.transaction(async (tx) => {
    const [decided] = await tx
      .update(autonomySignals)
      .set({ state: decision, decidedByUserId: actorId, doneAt: new Date() })
      .where(and(eq(autonomySignals.id, signalId), eq(autonomySignals.state, "open")))
      .returning();
    if (!decided) return null;
    const next: ProposalCard = { ...card, state: decision, decidedByUserId: actorId };
    const [updated] = await tx
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, signal.messageId as string)))
      .returning();
    if (decision === "always" || decision === "never") {
      const s = autonomySettings(agent.autonomy);
      const add = (list: CostKind[]) => [...new Set([...list, cost])];
      const remember =
        decision === "always"
          ? { go: add(s.go), never: s.never.filter((k) => k !== cost) }
          : { never: add(s.never), go: s.go.filter((k) => k !== cost) };
      await tx
        .update(agents)
        .set({
          autonomyBrakes: sql`${agents.autonomyBrakes} || ${JSON.stringify(remember)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.orgId, orgId), eq(agents.id, signal.agentId)));
    }
    const [run] = signal.runId
      ? await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, signal.runId)))
      : [];
    const go = decision === "go" || decision === "always";
    const who = member.handle ? `@${member.handle}` : "The person";
    const delivered = run
      ? await deliverNoticeToRun(tx, run, {
          kind: "proposal_result",
          text: go
            ? `${who} said go: you may go ahead with ${COST_WORDS[cost]} (${signal.title}). Do it now and report what came of it.`
            : `${who} said ${decision === "never" ? "never" : "not now"} to ${COST_WORDS[cost]} (${signal.title}). Don't do it; finish without it in one short line.`,
          refs: { runId: run.id, signalId },
        })
      : null;
    return { updated, delivered };
  });
  if (!out) throw new ConflictError("This proposal was already decided");
  if (out.updated && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(out.updated));
  if (out.delivered) await publishDelivery(deps.pubsub, out.delivered);
  return { state: decision };
}

// --- 4–7. One item is worked once, noise waits for a digest, repeats stop, caps -----------------------------

/**
 * The item a message is about, as a stable fingerprint: its first link (an issue's or an error's page, without the
 * query), else its first line with numbers, ids and hashes taken out. Null when there is nothing to key on.
 */
export function signatureOf(body: string): { key: string; title: string } | null {
  const text = body.replace(/```[\s\S]*?```/g, " ");
  const url = /https?:\/\/[^\s)>\]]+/i.exec(text)?.[0];
  const first =
    text
      .split("\n")
      .map((l) =>
        l
          .replace(/https?:\/\/\S+/g, "")
          .replace(/@[\w-]+/g, "")
          .replace(/[*_`#>]/g, "")
          .trim(),
      )
      .find((l) => l.length >= 4) ?? "";
  const normalized = first
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "#")
    .replace(/\b[0-9a-f]{7,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const basis = url ? url.split(/[?#]/)[0]?.replace(/\/+$/, "").toLowerCase() : normalized;
  if (!basis) return null;
  return {
    key: createHash("sha256").update(basis).digest("hex").slice(0, 32),
    title: cutText(unmention(first || url || ""), 200),
  };
}

/** Text quoted back into the chat never wakes anyone: its @handles lose the @. */
const unmention = (text: string) => text.replace(/@(?=[\w-])/g, "");

/** Runs of an agent on one item within this window are attempts at it; past `LOOP_MAX` it stops and asks. */
export const LOOP_WINDOW_MS = 24 * 3600_000;
export const LOOP_MAX = 3;
/** A deferred wake looks again this often, this many times (an hour), then goes to the digest. */
export const LATER_LOOK_MS = 2 * 60_000;
export const LATER_LOOKS = 30;
export const LATER_JOB = "autonomy.later";

export type BrakeOutcome = "linked" | "digest" | "loop" | "later";

/** The cheap triage a wake on an unrequested item meets (ADR 0131 §5): work on it now, or noise for the digest. */
export async function triageItem(judge: Judge, input: { orgId: string; agentId: string | null; body: string }) {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    kind: "alert_triage",
    state: { message: cutText(input.body, 2000) },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "A routine, a webhook or an agent posted `message` to wake an AI agent nobody asked directly. Should the agent start work on it now?",
        criteria: {
          work: "A request, a question, a hand-off, or a problem that is new, growing or high impact (many users, data loss, an outage, a security issue, a regression just shipped).",
          noise:
            "An alert or error report that is known, old, recurring at a low rate, benign or expected (a known freeze, a timeout that retries, a third-party blip, a client-side error from old versions): nothing to do now beyond a summary for a person.",
        },
      },
    },
  });
  const p = answers.verdict?.probabilities?.noise ?? (answers.verdict?.choice === "noise" ? 1 : 0);
  return p >= 0.6 ? ("noise" as const) : ("work" as const);
}

/**
 * The brakes on agents' wakes from a message nobody asked for directly (its chain roots in a routine, a webhook or an
 * agent's own work): per agent, open work on the same item takes it (`linked`, a note to that run), an item it already
 * tried `LOOP_MAX` times in a day stops (`loop`, one summary to a person), noise waits for the digest (`digest`), and
 * an agent at its cap of unrequested runs, or (for a routine's or a webhook's item) whose computer has turns waiting for
 * room, looks again later (`later`).
 * Returns the agents to wake now; every outcome is recorded (`autonomy_signals`).
 */
export async function brakeWakes(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge | null },
  message: Message,
  agentIds: string[],
  options: { look?: number } = {},
): Promise<{ wake: string[]; held: Map<string, BrakeOutcome> }> {
  const held = new Map<string, BrakeOutcome>();
  if (agentIds.length === 0) return { wake: [], held };
  const { db } = deps;
  const root = await messageRoot(db, message.orgId, message.id);
  if (root.kind === "person") return { wake: agentIds, held };
  const sig = signatureOf(message.body);
  let triage: "work" | "noise" | null = null;
  // A full computer defers new work that a routine or a webhook started; agents' own chains already wait in calm
  // wakes' inbox and ranks (ADR 0032).
  const crowded =
    root.kind === "routine" || root.kind === "routine_report"
      ? await crowdedAgents(db, message.orgId, agentIds)
      : new Set<string>();
  for (const agentId of agentIds) {
    const outcome = await brakeOne(
      deps,
      message,
      agentId,
      sig,
      crowded.has(agentId),
      async () => {
        if (triage === null)
          triage = deps.judge
            ? await triageItem(deps.judge, { orgId: message.orgId, agentId, body: message.body }).catch(
                () => "work" as const,
              )
            : "work";
        return triage;
      },
      options.look ?? 0,
    );
    if (outcome) held.set(agentId, outcome);
  }
  return { wake: agentIds.filter((id) => !held.has(id)), held };
}

async function brakeOne(
  deps: { db: Database; pubsub?: PubSub },
  message: Message,
  agentId: string,
  sig: { key: string; title: string } | null,
  crowded: boolean,
  triage: () => Promise<"work" | "noise">,
  look: number,
): Promise<BrakeOutcome | null> {
  const { db } = deps;
  const orgId = message.orgId;
  const record = (kind: string, extra: { runId?: string | null; doneAt?: Date } = {}) =>
    db.insert(autonomySignals).values({
      orgId,
      agentId,
      kind,
      signature: sig?.key ?? null,
      title: sig?.title ?? cutText(unmention(message.body), 200),
      channelId: message.channelId,
      messageId: message.id,
      runId: extra.runId ?? null,
      ...(extra.doneAt ? { doneAt: extra.doneAt } : {}),
    });
  if (sig) {
    // §4: open work on the same item (a run still at it) takes the new report instead of a second run.
    const [open] = await db
      .select({ run: agentRuns })
      .from(autonomySignals)
      .innerJoin(
        agentRuns,
        and(eq(agentRuns.triggerMessageId, autonomySignals.messageId), eq(agentRuns.agentId, autonomySignals.agentId)),
      )
      .where(
        and(
          eq(autonomySignals.orgId, orgId),
          eq(autonomySignals.agentId, agentId),
          eq(autonomySignals.signature, sig.key),
          eq(autonomySignals.kind, "wake"),
          inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(autonomySignals.createdAt))
      .limit(1);
    if (open) {
      await record("linked", { runId: open.run.id, doneAt: new Date() });
      const delivered = await db.transaction((tx) =>
        deliverNoticeToRun(tx, open.run, {
          kind: "agent_note",
          text: `The same item was reported again (${sig.title}). You are already on it in this run: don't start it over; include it in your report.`,
          refs: { runId: open.run.id, messageId: message.id },
        }),
      );
      await publishDelivery(deps.pubsub, delivered);
      return "linked";
    }
    // §6: tried too often lately: stop, and tell a person once.
    const [tries] = await db
      .select({
        n: sql<number>`count(*)::int`,
        stopped: sql<number>`count(*) filter (where ${autonomySignals.kind} = 'loop')::int`,
      })
      .from(autonomySignals)
      .where(
        and(
          eq(autonomySignals.orgId, orgId),
          eq(autonomySignals.agentId, agentId),
          eq(autonomySignals.signature, sig.key),
          inArray(autonomySignals.kind, ["wake", "loop"]),
          gt(autonomySignals.createdAt, new Date(Date.now() - LOOP_WINDOW_MS)),
        ),
      );
    if (Number(tries?.n ?? 0) - Number(tries?.stopped ?? 0) >= LOOP_MAX) {
      const first = Number(tries?.stopped ?? 0) === 0;
      await record("loop", { doneAt: new Date() });
      if (first) await postLoopStop(deps, message, agentId, sig.title);
      return "loop";
    }
  }
  // §5: noise goes to the next digest, not to work.
  if ((await triage()) === "noise") {
    await record("digest");
    return "digest";
  }
  // §7: at its cap of unrequested runs, or its computer already has turns waiting: later.
  if (crowded || (await unrequestedAtCap(db, orgId, agentId))) {
    if (look >= LATER_LOOKS) {
      await record("digest");
      return "digest";
    }
    await enqueue(db, {
      orgId,
      kind: LATER_JOB,
      payload: { messageId: message.id, agentId, look: look + 1 },
      dedupeKey: `${LATER_JOB}:${message.id}:${agentId}:${look + 1}`,
      runAt: new Date(Date.now() + LATER_LOOK_MS),
    });
    if (look === 0) await record("later", { doneAt: new Date() });
    return "later";
  }
  await record("wake");
  return null;
}

/** Whether an agent already has as many unrequested runs going as its settings allow. */
async function unrequestedAtCap(db: Executor, orgId: string, agentId: string) {
  const [agent] = await db
    .select({ autonomy: agents.autonomyBrakes })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  const max = autonomySettings(agent?.autonomy).maxUnrequested;
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${agentRuns.id})::int` })
    .from(autonomySignals)
    .innerJoin(
      agentRuns,
      and(eq(agentRuns.triggerMessageId, autonomySignals.messageId), eq(agentRuns.agentId, autonomySignals.agentId)),
    )
    .where(
      and(
        eq(autonomySignals.orgId, orgId),
        eq(autonomySignals.agentId, agentId),
        eq(autonomySignals.kind, "wake"),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  return Number(row?.n ?? 0) >= max;
}

/** The person who hears about an agent's unrequested work: its owner. */
async function ownerOfAgent(db: Executor, orgId: string, agentId: string) {
  const [a] = await db
    .select({ ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return a?.ownerUserId ?? null;
}

/** One line where the item came in: the agent stopped after repeated attempts and asks a person (§6). */
async function postLoopStop(deps: { db: Database; pubsub?: PubSub }, message: Message, agentId: string, title: string) {
  const forUserId = await ownerOfAgent(deps.db, message.orgId, agentId);
  const posted = await deps.db.transaction(async (tx) => {
    const m = await insertMessage(tx, {
      orgId: message.orgId,
      channelId: message.channelId,
      threadId: message.threadId ?? message.id,
      author: { type: "agent", agentId, runId: null, hop: message.hop + 1, stretchId: message.stretchId },
      body: `I stopped working on this on my own: it came back ${LOOP_MAX} times in a day (${title}). Tell me how you want it handled.`,
      meta: {
        autonomyNote: { kind: "loop", forUserId },
        bodyCode: "autonomy_loop",
        bodyParams: { count: String(LOOP_MAX), title },
      },
    });
    await enqueue(tx, {
      orgId: message.orgId,
      kind: "notifications.message",
      payload: { messageId: m.id },
      dedupeKey: `notifications.message:${m.id}`,
      maxAttempts: 4,
    });
    return m;
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(posted));
}

/** A digest goes out once its oldest item waited this long. */
export const DIGEST_AFTER_MS = 3600_000;

/**
 * The noise digest (§5): per agent and conversation, the items held as noise for at least `DIGEST_AFTER_MS` go out as
 * one summary line, for the agent's owner. Returns how many digests were posted.
 */
export async function postAutonomyDigests(deps: { db: Database; pubsub?: PubSub }, now = new Date()) {
  const { db } = deps;
  const due = await db
    .select({
      orgId: autonomySignals.orgId,
      agentId: autonomySignals.agentId,
      channelId: autonomySignals.channelId,
    })
    .from(autonomySignals)
    .where(and(eq(autonomySignals.kind, "digest"), isNull(autonomySignals.doneAt)))
    .groupBy(autonomySignals.orgId, autonomySignals.agentId, autonomySignals.channelId)
    .having(
      sql`min(${autonomySignals.createdAt}) <= ${new Date(now.getTime() - DIGEST_AFTER_MS).toISOString()}::timestamptz`,
    );
  let posted = 0;
  for (const d of due) {
    if (!d.channelId) continue;
    const forUserId = await ownerOfAgent(db, d.orgId, d.agentId);
    const message = await db.transaction(async (tx) => {
      const items = await tx
        .update(autonomySignals)
        .set({ doneAt: now })
        .where(
          and(
            eq(autonomySignals.orgId, d.orgId),
            eq(autonomySignals.agentId, d.agentId),
            eq(autonomySignals.channelId, d.channelId as string),
            eq(autonomySignals.kind, "digest"),
            isNull(autonomySignals.doneAt),
          ),
        )
        .returning({ title: autonomySignals.title, signature: autonomySignals.signature });
      if (items.length === 0) return null;
      const grouped = new Map<string, { title: string; n: number }>();
      for (const i of items) {
        const key = i.signature ?? i.title;
        const g = grouped.get(key);
        if (g) g.n++;
        else grouped.set(key, { title: i.title, n: 1 });
      }
      const lines = [...grouped.values()]
        .slice(0, 15)
        .map((g) => `• ${g.title}${g.n > 1 ? ` ×${g.n}` : ""}`)
        .join("\n");
      const m = await insertMessage(tx, {
        orgId: d.orgId,
        channelId: d.channelId as string,
        author: { type: "agent", agentId: d.agentId, runId: null, hop: 1, stretchId: null },
        body: `${items.length} alerts looked known or harmless, so I didn't work on them:\n${lines}`,
        meta: {
          autonomyNote: { kind: "digest", forUserId },
          bodyCode: "autonomy_digest",
          bodyParams: { count: String(items.length), lines },
        },
      });
      await enqueue(tx, {
        orgId: d.orgId,
        kind: "notifications.message",
        payload: { messageId: m.id },
        dedupeKey: `notifications.message:${m.id}`,
        maxAttempts: 4,
      });
      return m;
    });
    if (message) {
      posted++;
      if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
    }
  }
  return posted;
}

/** Who a message's `meta.autonomyNote` is for (the digest and the loop stop): notified like an agent's answer. */
export const autonomyNoteFor = (meta: Record<string, unknown> | null | undefined): string | null => {
  const n = meta?.autonomyNote as { forUserId?: unknown } | undefined;
  return typeof n?.forUserId === "string" ? n.forUserId : null;
};

// --- 8. Who an agent may call -------------------------------------------------------------------------------

/**
 * Of `targetIds`, the agents `fromAgentId` may wake or hand work to (§8): its `callAgents` setting, and agents of
 * another project only when it allows other projects. A person's own mentions never pass through here.
 */
export async function callableAgents(
  db: Executor,
  orgId: string,
  fromAgentId: string,
  targetIds: string[],
): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id, autonomy: agents.autonomyBrakes })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, [...new Set([fromAgentId, ...targetIds])])));
  const from = rows.find((r) => r.id === fromAgentId)?.autonomy;
  return new Set(targetIds.filter((id) => mayCall(from, { id, autonomy: rows.find((r) => r.id === id)?.autonomy })));
}

/** What an agent reads when its settings kept it from calling `handles`. */
export const notCallableText = (handles: string[]) =>
  `Your settings don't let you call ${handles.join(", ")} (another project, or not on your list of agents to call). Don't mention or hand work to ${handles.length === 1 ? "it" : "them"}; do it yourself or tell the person.`;

export type { AgentRun };

/**
 * The agent's last word in a run's conversation asks the person something, and nobody wrote since (§1): what it set
 * up to come back by itself (a follow-up) waits for their answer instead.
 */
export async function askStillOpen(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
) {
  const thread = replyThreadOf(run);
  const [last] = await db
    .select({ authorAgentId: messages.authorAgentId, body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        thread ? eq(messages.threadId, thread) : isNull(messages.threadId),
        isNull(messages.deletedAt),
        sql`${messages.meta}->'notice' is null`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return last?.authorAgentId === run.agentId && endsAsking(last.body);
}
