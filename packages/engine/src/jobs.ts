import type {
  EmailSender,
  Presence,
  PushSender,
  SearchIndexResolver,
  SearchKind,
  WebPushSender,
} from "@agenteschat/adapters";
import { and, count, eq, inArray, queryTrace, schema } from "@agenteschat/db";
import { aiConnectIntent, type ConnectIntent } from "./ai-intent";
import { orgHasAi } from "./ai-status";
import type { ArtifactDeps } from "./artifacts";
import { getChannelCached } from "./context";
import { consolidateOrg } from "./context/consolidate";
import { applyReactionFeedback } from "./context/feedback";
import { REFLECT_DEFAULTS, reflectThread } from "./context/reflect";
import { judgeOf } from "./context/summaries";
import { dispatchDm, dispatchMentions, requesterOf } from "./dispatch";
import { isAgentOnlyDm } from "./dms";
import { type EmailArt, sendQueuedEmail } from "./email";
import { type DecidedBy, publishRouted } from "./events";
import { executeRun, type RunExecutorDeps } from "./executor";
import { advanceForumTopic } from "./forum";
import { FILE_JOIN_REQUEST_JOB, fileJoinRequest, forgetJoinCodeEmail } from "./invite-requests";
import type { JevKey, JevKeySource } from "./jev-key";
import { mentionHandoffs } from "./judge";
import { wakeForAccessDecision } from "./machine-access";
import type { MachineCaller } from "./machine-hub";
import { interruptOfflineMachineTasks, wakeConversationForTask } from "./machine-tasks";
import { getMessage, referencedOf } from "./messages";
import { checkMissionDone } from "./mission-delivery";
import { onMissionTaskEnded, syncMissionFiles } from "./mission-sync";
import { afterMachineTaskEnded, afterMissionRunEnded } from "./mission-worktree";
import { type MissionDeps, missionOfThread, missionRole, reactivateMission } from "./missions";
import type { MissionEngine } from "./missions-engine";
import { notifyMessage } from "./notification-producers";
import { ORG_FILES_PURGE_ATTEMPTS, ORG_FILES_PURGE_JOB } from "./organizations";
import { enqueue, type JobHandlers, type OutboxJob, PermanentJobError } from "./outbox";
import { checkPushReceipts, deliverPush, pushTicketsOf } from "./push";
import {
  createLlmRouterStrategy,
  DEFAULT_ROUTER_POLICY,
  type RouterDeps,
  type RouterStrategy,
  routeMessage,
  smallModelFor,
} from "./router";
import { createJevRouterStrategy, jevCostNanoUsd, routeChain } from "./router-jev";
import { createPlanRouterStrategy } from "./router-plan";
import { executeRoutineRun } from "./routines";
import { type AgentRun, NO_AI } from "./runs";
import type { SandboxDeps } from "./sandbox";
import { indexSource, reindexOrg } from "./search";
import { activateDeliveredSecret, discardClosedSecret } from "./secrets";
import { purgeOrgFiles, runMigration, type StorageDeps } from "./storage";
import { isAgentesCloud } from "./telemetry";
import { assessThread } from "./thread-assess";
import { saveWaitlistContact } from "./waitlist";

/** A thread that grew by another `everyMessages` gets reflected on (capture), within the per-thread cap. */
async function maybeEnqueueReflection(deps: JobDeps, orgId: string, threadId: string) {
  const every = deps.context?.reflect?.everyMessages ?? REFLECT_DEFAULTS.everyMessages;
  const [row] = await deps.db
    .select({ n: count() })
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.threadId, threadId)));
  const n = Number(row?.n ?? 0);
  if (n === 0 || n % every !== 0) return;
  await enqueue(deps.db, {
    orgId,
    kind: "context.reflect",
    payload: { threadRootId: threadId },
    dedupeKey: `context.reflect:${threadId}:n${n}`,
  });
}

export interface JobDeps extends RunExecutorDeps {
  maxHops: number;
  /** Search index (jobs `search.index`, `search.reindex`). */
  search?: SearchIndexResolver;
  /** Transactional email (job `email.send`). */
  email?: EmailSender;
  /** Where emails get their pictures (`emailArtFor`); absent: from each link's own server. */
  emailArt?: EmailArt;
  /** Push to the phone app (job `push.send`); absent = push off. */
  push?: PushSender | null;
  /** Web Push to browsers (job `push.send`, ADR 0071); absent = off. */
  webPush?: WebPushSender | null;
  /** Who has the app open: pushes not waiting on them hold a little (ADR 0071 §7); absent = never held. */
  presence?: Presence | null;
  /** Org storage (job `storage.migrate`). */
  storage?: StorageDeps;
  /** Drive (job `forum.advance` saves the forum synthesis). */
  artifacts?: ArtifactDeps;
  /** Agents' computers: the hub and public URL missions use. */
  sandbox?: SandboxDeps | null;
  /** The engine missions start, resume and cancel runs with (default: today's run queue). */
  missionEngine?: MissionEngine | null;
  router?: {
    /** Off = only @mentions start runs. */
    enabled: boolean;
    /** The small model on a Claude key (ROUTER_MODEL); an org may override it in its settings. */
    model: string;
    /** The small model on another provider's key (e.g. `{ openai: "gpt-6-luna" }`); else its catalog pick. */
    cheapModels?: Record<string, string>;
    minScore?: number;
    /** Jev probability needed for an agent's @mention of another agent to start it (default 0.6). */
    mentionThreshold?: number;
    /** Replaces the core small-model step (e.g. an optional external classifier). */
    strategy?: RouterStrategy;
    /** TypeSafe Jev as the chain's first step (the installation's key, never per org). */
    jev?: { key: JevKeySource; timeoutMs?: number; fetch?: typeof fetch; baseURL?: string };
    /**
     * The author's own plan as a step (ADR 0074 §3): the computers it picks on, and this server's address. Off
     * on the Cloud (`isAgentesCloud`), where Jev is ours. Absent: no plan step.
     */
    plans?: { hub: Pick<MachineCaller, "call" | "status">; publicUrl: string };
  };
}

/** Organization of an org-scoped job (only system jobs such as some emails have none). */
const orgOf = (job: OutboxJob) => {
  if (!job.orgId) throw new PermanentJobError(`job ${job.kind} needs an organization`);
  return job.orgId;
};

/**
 * The router of messages nobody mentioned (`message.posted`, and "Responder agora" routing one again): the
 * chain of ADR 0074 (Jev when configured, the organization's small model, the author's own plan where it is
 * on, then rules in `routeMessage`), with the organization's AI checked first. Null when routing is off.
 */
export function messageRouter(deps: JobDeps): RouterDeps | null {
  const router = deps.router;
  if (!router?.enabled) return null;
  const perProvider = { anthropic: router.model, ...router.cheapModels };
  const smallModel = (orgId: string) => smallModelFor(deps, orgId, perProvider);
  const jev = router.jev;
  const plans = router.plans && !isAgentesCloud(router.plans.publicUrl) ? router.plans.hub : null;
  const steps = [
    ...(jev
      ? [
          createJevRouterStrategy({
            key: jev.key,
            timeoutMs: jev.timeoutMs,
            fetch: jev.fetch,
            baseURL: jev.baseURL,
            recordUsage: async (u) => {
              await deps.gateway.recordExternalUsage({
                orgId: u.orgId,
                kind: "router",
                provider: "typesafe",
                model: u.model,
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
                costNanoUsd: jevCostNanoUsd(u.inputTokens),
              });
            },
          }),
        ]
      : []),
    router.strategy ?? createLlmRouterStrategy({ gateway: deps.gateway, resolveModel: smallModel }),
    ...(plans ? [createPlanRouterStrategy({ db: deps.db, hub: plans, pubsub: deps.pubsub })] : []),
  ];
  return {
    db: deps.db,
    strategy: routeChain(steps, { onTiming: deps.onTiming }),
    policy: {
      ...DEFAULT_ROUTER_POLICY,
      minScore: router.minScore ?? DEFAULT_ROUTER_POLICY.minScore,
      maxHops: deps.maxHops,
    },
    hasAi: (orgId) => orgHasAi({ db: deps.db, gateway: deps.gateway, machines: deps.machines }, orgId),
    routing: { jev: () => jevPicks(jev?.key), smallModel, plans },
  };
}

/** Whether Jev picks now: a key its owner sees working (a limit, an outage or a slow answer don't count). */
async function jevPicks(key: JevKeySource | undefined): Promise<boolean> {
  if (!key) return false;
  if (typeof key === "string") return true;
  return "view" in key ? (await (key as JevKey).view()).state === "ok" : (await key.key()) !== null;
}

/** Every outbox job kind the core knows. Modules can add more through the server's worker options. */
export function createJobHandlers(deps: JobDeps): JobHandlers {
  const routing = messageRouter(deps);

  // An agent's @mention starts the other agent only when it asks it to act now (the judge decides).
  const mentionThreshold = deps.router?.mentionThreshold ?? 0.6;
  /**
   * Which agents an agent's @mentions actually hand off to: the judge asks,
   * per mentioned agent, "is this asking it to act now?" (any language)
   * against the threshold. Without a judge, or when it fails, none: a
   * mention alone never starts another agent. Every decision is recorded in
   * `routing_decisions` for audit.
   */
  async function delegatedAgents(message: NonNullable<Awaited<ReturnType<typeof getMessage>>>) {
    const targets = await deps.db
      .select({
        id: schema.agents.id,
        handle: schema.agents.handle,
        name: schema.agents.name,
        role: schema.agents.role,
      })
      .from(schema.agents)
      .where(inArray(schema.agents.id, message.mentionedAgentIds));
    const others = targets.filter((t) => t.id !== message.authorAgentId);
    const scores = new Map<string, number>();
    // Spoken to by name ("@ada já postei…" opens the message): a reply to it, it answers (hop cap still holds).
    for (const t of others) if (opensWith(message.body, t.handle)) scores.set(t.id, 1);
    const toJudge = others.filter((t) => !scores.has(t.id));
    let strategy = "mention-judge";
    let error: string | null = null;
    const judge = deps.context ? judgeOf(deps.context) : null;
    if (judge && toJudge.length > 0) {
      const [author] = message.authorAgentId
        ? await deps.db
            .select({ handle: schema.agents.handle })
            .from(schema.agents)
            .where(eq(schema.agents.id, message.authorAgentId))
        : [];
      try {
        const judged = await mentionHandoffs(judge, {
          orgId: message.orgId,
          body: message.body,
          author: author ? `@${author.handle}` : "agent",
          targets: toJudge.map((t) => ({ agentId: t.id, handle: t.handle, name: t.name, role: t.role || null })),
        });
        for (const [id, p] of judged) scores.set(id, p);
        strategy = `mention-${judge.name}`;
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }
    const allowed = others.filter((t) => (scores.get(t.id) ?? 0) >= mentionThreshold).map((t) => t.id);
    await deps.db
      .insert(schema.routingDecisions)
      .values({
        orgId: message.orgId,
        channelId: message.channelId,
        messageId: message.id,
        strategy,
        candidates: others.map((t) => ({ agentId: t.id, score: scores.get(t.id) ?? 0 })),
        selectedAgentIds: allowed,
        reason: others
          .map((t) => `@${t.handle}: ${(scores.get(t.id) ?? 0).toFixed(2)}`)
          .join(", ")
          .slice(0, 500),
        error,
      })
      .onConflictDoNothing();
    return allowed;
  }

  const missions: MissionDeps = {
    db: deps.db,
    pubsub: deps.pubsub,
    hub: deps.sandbox?.machines?.hub ?? null,
    artifacts: deps.artifacts,
    search: deps.context,
    publicUrl: deps.sandbox?.publicUrl,
    missionEngine: deps.missionEngine ?? null,
  };

  return {
    "message.posted": async (job) => {
      const input = { orgId: orgOf(job), messageId: String(job.payload.messageId) };
      const message = await getMessage(deps.db, input.orgId, input.messageId);
      if (!message) return;
      if (deps.context && message.threadId) await maybeEnqueueReflection(deps, message.orgId, message.threadId);
      // An issue's work card, its start (the run is already started) and the "took issue #N" line route to nobody.
      if (message.meta.issueWork || message.meta.issueWorkStart || message.meta.issueTaken) return;
      // A fast reply while the task works (talker.ts): its task reads it; it starts nobody, not even by mention.
      if (message.meta.talker) return;
      // A routine's trigger: its background run is already started; nobody else is routed (routines.ts).
      if (message.meta.background) return;
      const routed = (
        strategy: "mention" | "dm" | "router" | "none",
        seenBy: string[],
        runs: AgentRun[],
        reason?: string,
        intent?: ConnectIntent,
        decidedBy?: DecidedBy,
      ) =>
        publishRouted(deps.pubsub, message, {
          strategy,
          seenBy,
          runs,
          ...(reason ? { reason } : {}),
          ...(decidedBy ? { decidedBy } : {}),
          ...intent,
        });
      const where = await getChannelCached(deps.db, message.orgId, message.channelId);
      // The forum moves by its own turns (ADR 0022): no mentions, router or DMs there.
      if (where?.kind === "forum") return;
      // Addressed a mission's agent without the right to act there (ADR 0029): a suggestion, no run.
      if (message.meta.missionSuggestion) return routed("none", message.mentionedAgentIds, [], "mission_suggestion");
      // Someone who acts in a mission waiting to be concluded wrote in its thread: new work, active again.
      if (message.authorType === "person" && message.threadId && message.authorUserId) {
        const waiting = await missionOfThread(deps.db, message.orgId, message.threadId);
        if (waiting?.status === "awaiting_close") {
          const role = await missionRole(deps.db, waiting, message.authorUserId);
          if (role === "owner" || role === "decide") await reactivateMission(missions, waiting, "message");
        }
      }
      if (message.authorType !== "person") {
        // Between agents only (`ask_agent`, ADR 0034): the consultation runs are started by the tool.
        if (where && isAgentOnlyDm(where)) return;
        // A notice is for its own agent (`deliverNotice` starts or joins its run), a no-AI card says why
        // its agent didn't answer, and an action card waits for a person's click: nobody else chimes in.
        if (message.meta.notice || message.meta.noAi || message.meta.actionCard) return;
        // Agents' mentions go through the hop limit here; a person's mentions and DMs already
        // started their runs in the same statement as the message (postPersonMessage).
        if (message.mentionedAgentIds.length > 0) {
          // Agents answer each other at most once in a row: a reply to an agent's request can't hand off again.
          if (message.hop >= 2) return routed("none", message.mentionedAgentIds, [], "agent_chain_cap");
          let allowed = await delegatedAgents(message);
          // In an open mission's thread, another agent acts for the person behind it: only the
          // mission's owner and deciders make the mission's agent work (ADR 0029).
          if (message.threadId && allowed.length > 0) {
            const mission = await missionOfThread(deps.db, message.orgId, message.threadId);
            if (
              mission &&
              allowed.includes(mission.agentId) &&
              ["proposed", "active", "paused", "awaiting_close"].includes(mission.status)
            ) {
              const person = await requesterOf(deps.db, message);
              const role = person ? await missionRole(deps.db, mission, person) : "none";
              if (role !== "owner" && role !== "decide") allowed = allowed.filter((id) => id !== mission.agentId);
            }
          }
          const res = allowed.length
            ? await dispatchMentions(deps.db, input, { maxHops: deps.maxHops, onlyAgentIds: allowed })
            : { runs: [] };
          await routed("mention", message.mentionedAgentIds, res.runs, allowed.length ? undefined : "reference_only");
          return;
        }
        // No mention: another agent may chime in when it clearly should (ADR 0034). Only in
        // channels, never in a mission's thread (the mission's own turns run it).
        if (!routing || where?.kind !== "channel") return;
        if (message.threadId && (await missionOfThread(deps.db, message.orgId, message.threadId))) return;
        const res = await routeMessage(routing, input);
        // Receipts only when someone answers: an agent's message isn't waiting for anyone.
        if (res.runs.length > 0)
          await routed("router", res.seenBy ?? [], res.runs, res.reason, undefined, res.decidedBy);
        return;
      }
      if (message.mentionedAgentIds.length > 0) {
        // No-op unless inserted elsewhere; never the agents the person only referenced, nor the ones whose
        // run in progress already took this message (steering): once that run ends, a second one would
        // answer the same message again.
        const referenced = referencedOf(message.meta);
        const steeredIds = Array.isArray(message.meta.steeredRunIds)
          ? message.meta.steeredRunIds.filter((v): v is string => typeof v === "string")
          : [];
        const steered =
          steeredIds.length > 0
            ? (
                await deps.db
                  .select({ agentId: schema.agentRuns.agentId })
                  .from(schema.agentRuns)
                  .where(and(eq(schema.agentRuns.orgId, message.orgId), inArray(schema.agentRuns.id, steeredIds)))
              ).map((r) => r.agentId)
            : [];
        const skip = new Set([...referenced, ...steered]);
        await dispatchMentions(deps.db, input, {
          maxHops: deps.maxHops,
          ...(skip.size > 0 ? { onlyAgentIds: message.mentionedAgentIds.filter((id) => !skip.has(id)) } : {}),
        });
        return;
      }
      // An answer to an agent's question resumes that run; nobody else is routed.
      if (typeof message.meta.answersQuestionId === "string") return;
      // Delivered to an agent's task already in progress (steering): no second run.
      if (Array.isArray(message.meta.steeredRunIds)) return;
      const channel = where;
      if (channel?.kind === "dm") {
        await dispatchDm(deps.db, message, { maxHops: deps.maxHops }); // idempotent safety net
        return;
      }
      if (!routing) return routed("none", [], []);
      // In a mission's thread only its owner and deciders make the agent work (the router included).
      if (message.threadId && message.authorUserId) {
        const mission = await missionOfThread(deps.db, message.orgId, message.threadId);
        if (mission && ["proposed", "active", "paused", "awaiting_close"].includes(mission.status)) {
          const role = await missionRole(deps.db, mission, message.authorUserId);
          if (role !== "owner" && role !== "decide") return routed("none", [], [], "mission_read_only");
        }
      }
      const res = await routeMessage(routing, input);
      if (res.skipped === "already_routed") return;
      // Nobody can think: what the person asks for may be to connect an AI (Jev reads it), for the Connect step.
      if (res.reason === NO_AI) {
        const intent = await aiConnectIntent(deps.context?.judge, { orgId: message.orgId, text: message.body });
        return routed("none", [], [], NO_AI, intent);
      }
      await routed(res.seenBy ? "router" : "none", res.seenBy ?? [], res.runs, res.reason, undefined, res.decidedBy);
    },
    "agent_run.execute": async (job, ctx) => {
      // Counted per run (statements per stage go into the run profile).
      const wait = typeof job.payload.wait === "string" ? job.payload.wait : undefined;
      await queryTrace.run({ count: 0 }, () =>
        executeRun(deps, String(job.payload.runId), wait ? { ...ctx, wait, jobId: job.id } : ctx),
      );
      // A mission's main-session turn that ended: write items queued behind it may start (ADR 0044).
      await afterMissionRunEnded(missions, String(job.payload.runId)).catch(() => 0);
    },
    "secret.activate": async (job) => {
      if (!deps.sandbox) throw new Error("Computer secret delivery is unavailable");
      await activateDeliveredSecret(
        { ...deps.sandbox, pubsub: deps.pubsub },
        orgOf(job),
        String(job.payload.requestId),
      );
    },
    "secret.discard": async (job) => {
      if (!deps.sandbox) throw new Error("Computer secret cleanup is unavailable");
      await discardClosedSecret(deps.sandbox, orgOf(job), String(job.payload.requestId));
    },
    "search.index": async (job) => {
      if (!deps.search) return;
      await indexSource(
        { db: deps.db, search: deps.search, gateway: deps.gateway },
        { orgId: orgOf(job), kind: job.payload.kind as SearchKind, sourceId: String(job.payload.sourceId) },
      );
    },
    "search.reindex": async (job) => {
      if (!deps.search) return;
      await reindexOrg({ db: deps.db, search: deps.search, gateway: deps.gateway }, orgOf(job));
    },
    "context.reflect": async (job) => {
      if (!deps.context) return;
      await reflectThread(deps.context, { orgId: orgOf(job), threadRootId: String(job.payload.threadRootId) });
    },
    // A reply a while ago: the thread's title and "resolved?" suggestion, unless a newer reply came.
    "threads.assess": async (job) => {
      if (!deps.context) return;
      await assessThread(deps.context, {
        orgId: orgOf(job),
        threadRootId: String(job.payload.threadRootId),
        messageId: typeof job.payload.messageId === "string" ? job.payload.messageId : undefined,
      });
    },
    "context.feedback": async (job) => {
      await applyReactionFeedback(deps.db, {
        orgId: orgOf(job),
        messageId: String(job.payload.messageId),
        reaction: String(job.payload.reaction),
      });
    },
    "routine.run": async (job) => {
      await executeRoutineRun(
        { db: deps.db, pubsub: deps.pubsub, context: deps.context, artifacts: deps.artifacts },
        String(job.payload.routineRunId),
      );
    },
    "forum.advance": async (job) => {
      await advanceForumTopic(
        { db: deps.db, pubsub: deps.pubsub, artifacts: deps.artifacts },
        String(job.payload.topicId),
      );
    },
    "storage.migrate": async (job) => {
      if (!deps.storage) throw new PermanentJobError("no storage configured");
      await runMigration(deps.storage, String(job.payload.migrationId));
    },
    // A page at a time: a full page enqueues the next run, once even if this one runs twice.
    [ORG_FILES_PURGE_JOB]: async (job) => {
      if (!deps.storage) throw new PermanentJobError("no storage configured");
      const orgId = String(job.payload.orgId);
      if (!(await purgeOrgFiles(deps.storage, orgId))) return;
      await enqueue(deps.db, {
        orgId: null,
        kind: ORG_FILES_PURGE_JOB,
        payload: { orgId },
        dedupeKey: `${ORG_FILES_PURGE_JOB}:${job.id}`,
        maxAttempts: ORG_FILES_PURGE_ATTEMPTS,
      });
    },
    "email.send": async (job, ctx) => {
      try {
        if (!deps.email) throw new PermanentJobError("no email sender configured");
        await sendQueuedEmail(deps.email, job.payload, deps.emailArt);
      } catch (error) {
        if (ctx.finalAttempt || error instanceof PermanentJobError) await forgetJoinCodeEmail(deps.db, job);
        throw error;
      }
      await forgetJoinCodeEmail(deps.db, job);
    },
    "waitlist.contact": async (job) => {
      if (!deps.email) throw new PermanentJobError("no email sender configured");
      await saveWaitlistContact(deps.db, deps.email, String(job.payload.entryId));
    },
    // A background task on a connected computer ended: its conversation wakes (ADR 0029).
    "machine.task_done": async (job) => {
      const woke = await wakeConversationForTask({ db: deps.db, pubsub: deps.pubsub }, String(job.payload.taskId), {
        maxHops: deps.maxHops,
      });
      // A mission's task: its notes come back, its main session hears, queued messages go out.
      if (woke && "missionTask" in woke) await onMissionTaskEnded(missions, String(job.payload.taskId));
      // A slot on that computer is free: queued mission items may start (ADR 0044). The one walk of the
      // machine's queue per task end (also kicked for a resumed item queued with this job, its own id).
      await afterMachineTaskEnded(missions, String(job.payload.taskId)).catch(() => 0);
    },
    // The `.agentes/` files of a mission changed (debounced): written to its machine.
    "mission.sync_files": async (job) => {
      await syncMissionFiles(missions, String(job.payload.missionId));
    },
    // A mission's plan finished or its work stopped: is everything done (then it waits to be concluded)?
    "mission.check_done": async (job) => {
      await checkMissionDone(missions, String(job.payload.missionId), Number(job.payload.attempt ?? 0) || 0);
    },
    // The person at a connected computer answered an agent's folder request (ADR 0036 §8): the agent wakes.
    "machine.access_decided": async (job) => {
      await wakeForAccessDecision({ db: deps.db, pubsub: deps.pubsub }, String(job.payload.requestId), {
        maxHops: deps.maxHops,
      });
    },
    // A machine went offline a grace ago: if still offline, its running tasks are interrupted (one notice per thread).
    "machine.tasks_offline": async (job) => {
      await interruptOfflineMachineTasks({ db: deps.db, pubsub: deps.pubsub }, String(job.payload.machineId));
    },
    // A request to join through an invitation link, filed apart from the ask's reply (ADR 0068).
    [FILE_JOIN_REQUEST_JOB]: async (job) => {
      await fileJoinRequest({ db: deps.db, pubsub: deps.pubsub }, job.payload);
    },
    // In-app notifications of a message: mentions, thread replies, DMs.
    "notifications.message": async (job) => {
      await notifyMessage({ db: deps.db, pubsub: deps.pubsub }, orgOf(job), String(job.payload.messageId));
    },
    // A notification for a person's phones and browsers (ADR 0035, 0071): skipped if read, done or snoozed meanwhile.
    "push.send": async (job) => {
      await deliverPush(
        { db: deps.db, push: deps.push, webPush: deps.webPush, presence: deps.presence },
        String(job.payload.notificationId),
        { held: job.payload.held === true },
      );
    },
    // Receipts of a push ~15 min later: tokens whose device is gone are deleted.
    "push.receipts": async (job) => {
      await checkPushReceipts({ db: deps.db, push: deps.push }, pushTicketsOf(job.payload.tickets));
    },
    "context.consolidate": async (job) => {
      if (!deps.context) return;
      await consolidateOrg(deps.context, orgOf(job));
    },
  };
}

/** The message opens by addressing `handle` ("@ada …", after any other leading mentions). */
export function opensWith(body: string, handle: string): boolean {
  const lead = /^\s*((?:@[\w.-]+[\s,]*)+)/.exec(body)?.[1] ?? "";
  return (lead.match(/@([\w.-]+)/g) ?? []).some((m) => m.slice(1).toLowerCase() === handle.toLowerCase());
}
