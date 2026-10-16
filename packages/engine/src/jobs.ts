import type { EmailSender, SearchIndexResolver, SearchKind } from "@agenteschat/adapters";
import { and, count, eq, inArray, queryTrace, schema } from "@agenteschat/db";
import type { ArtifactDeps } from "./artifacts";
import { getChannelCached } from "./context";
import { consolidateOrg } from "./context/consolidate";
import { applyReactionFeedback } from "./context/feedback";
import { REFLECT_DEFAULTS, reflectThread } from "./context/reflect";
import { judgeOf } from "./context/summaries";
import { dispatchDm, dispatchMentions, requesterOf } from "./dispatch";
import { sendQueuedEmail } from "./email";
import { publishChannelEvent } from "./events";
import { executeRun, type RunExecutorDeps } from "./executor";
import { advanceForumTopic } from "./forum";
import { mentionHandoffs } from "./judge";
import { interruptOfflineMachineTasks, wakeConversationForTask } from "./machine-tasks";
import { getMessage } from "./messages";
import { checkMissionDone } from "./mission-delivery";
import { onMissionApprovalDecided, onMissionTaskEnded, syncMissionFiles } from "./mission-sync";
import { type MissionDeps, missionOfThread, missionRole, reactivateMission } from "./missions";
import { enqueue, type JobHandlers, type OutboxJob, PermanentJobError } from "./outbox";
import {
  createLlmRouterStrategy,
  DEFAULT_ROUTER_POLICY,
  type RouterStrategy,
  resolveRouterModel,
  routeMessage,
} from "./router";
import { createJevRouterStrategy, jevCostNanoUsd, withFallback } from "./router-jev";
import { executeRoutineRun } from "./routines";
import type { AgentRun } from "./runs";
import { runComputerStart, runComputerStop, type SandboxDeps } from "./sandbox";
import { indexSource, reindexOrg } from "./search";
import { runMigration, type StorageDeps } from "./storage";

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
  /** Org storage (job `storage.migrate`). */
  storage?: StorageDeps;
  /** Drive (job `forum.advance` saves the forum synthesis). */
  artifacts?: ArtifactDeps;
  /** Agents' computers (jobs `sandbox.start`, `sandbox.stop`). */
  sandbox?: SandboxDeps | null;
  router?: {
    /** Off = only @mentions start runs. */
    enabled: boolean;
    /** Anthropic cheap model (ROUTER_MODEL); an org may override it in its settings. */
    model: string;
    /** Cheap model per other provider (e.g. `{ openai: "gpt-6-luna" }`), used when the org's default key is theirs. */
    cheapModels?: Record<string, string>;
    minScore?: number;
    /** Jev probability needed for an agent's @mention of another agent to start it (default 0.6). */
    mentionThreshold?: number;
    /** Replaces the core LLM strategy (e.g. an optional external classifier). */
    strategy?: RouterStrategy;
    /** TypeSafe Jev as the strategy, with the LLM one as fallback (platform key, never per org). */
    jev?: { apiKey: string; timeoutMs?: number; fetch?: typeof fetch; baseURL?: string };
  };
}

/** Organization of an org-scoped job (only system jobs such as some emails have none). */
const orgOf = (job: OutboxJob) => {
  if (!job.orgId) throw new PermanentJobError(`job ${job.kind} needs an organization`);
  return job.orgId;
};

/** Every outbox job kind the core knows. Modules can add more through the server's worker options. */
export function createJobHandlers(deps: JobDeps): JobHandlers {
  const router = deps.router ?? { enabled: false, model: "" };
  const llm = createLlmRouterStrategy({
    gateway: deps.gateway,
    resolveModel: (orgId) => resolveRouterModel(deps.db, orgId, router.model, router.cheapModels),
  });
  const jev = router.jev;
  const strategy =
    router.strategy ??
    (jev
      ? withFallback(
          createJevRouterStrategy({
            apiKey: jev.apiKey,
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
          llm,
        )
      : llm);
  const policy = {
    ...DEFAULT_ROUTER_POLICY,
    minScore: router.minScore ?? DEFAULT_ROUTER_POLICY.minScore,
    maxHops: deps.maxHops,
  };

  // An agent's @mention starts the other agent only when it asks it to act now (the judge decides).
  const mentionThreshold = router.mentionThreshold ?? 0.6;
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
    let strategy = "mention-judge";
    let error: string | null = null;
    const judge = deps.context ? judgeOf(deps.context) : null;
    if (judge && others.length > 0) {
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
          targets: others.map((t) => ({ agentId: t.id, handle: t.handle, name: t.name, role: t.role || null })),
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
  };

  return {
    "message.posted": async (job, ctx) => {
      const input = { orgId: orgOf(job), messageId: String(job.payload.messageId) };
      const message = await getMessage(deps.db, input.orgId, input.messageId);
      if (!message) return;
      if (deps.context && message.threadId) await maybeEnqueueReflection(deps, message.orgId, message.threadId);
      const routed = async (
        strategy: "mention" | "dm" | "router" | "none",
        seenBy: string[],
        runs: AgentRun[],
        reason?: string,
      ) => {
        const threadId = message.threadId ?? message.id;
        await publishChannelEvent(deps.pubsub, {
          type: "message.routed",
          channelId: message.channelId,
          messageId: message.id,
          seenBy,
          pickedBy: runs.map((r) => r.agentId),
          strategy,
          ...(reason ? { reason } : {}),
        });
        for (const run of runs) {
          await publishChannelEvent(deps.pubsub, {
            type: "agent.thinking",
            channelId: message.channelId,
            threadId,
            agentId: run.agentId,
            runId: run.id,
          });
        }
      };
      const where = await getChannelCached(deps.db, message.orgId, message.channelId);
      // The forum moves by its own turns (D33): no mentions, router or DMs there.
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
        }
        return;
      }
      if (message.mentionedAgentIds.length > 0) {
        await dispatchMentions(deps.db, input, { maxHops: deps.maxHops }); // no-op unless inserted elsewhere
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
      if (!router.enabled) return routed("none", [], []);
      // In a mission's thread only its owner and deciders make the agent work (the router included).
      if (message.threadId && message.authorUserId) {
        const mission = await missionOfThread(deps.db, message.orgId, message.threadId);
        if (mission && ["proposed", "active", "paused", "awaiting_close"].includes(mission.status)) {
          const role = await missionRole(deps.db, mission, message.authorUserId);
          if (role !== "owner" && role !== "decide") return routed("none", [], [], "mission_read_only");
        }
      }
      const res = await routeMessage({ db: deps.db, strategy, policy }, input, ctx);
      if (res.skipped === "already_routed") return;
      await routed(res.seenBy ? "router" : "none", res.seenBy ?? [], res.runs, res.reason);
    },
    "agent_run.execute": async (job, ctx) => {
      // Counted per run (statements per stage go into the run profile).
      await queryTrace.run({ count: 0 }, () => executeRun(deps, String(job.payload.runId), ctx));
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
    "sandbox.start": async (job) => {
      const provider = deps.sandbox?.provider;
      if (!deps.sandbox || !provider) throw new PermanentJobError("no computer provider configured");
      await runComputerStart(
        { ...deps.sandbox, provider, pubsub: deps.pubsub },
        orgOf(job),
        String(job.payload.agentId),
        String(job.payload.actorId),
      );
    },
    "sandbox.stop": async (job) => {
      const provider = deps.sandbox?.provider;
      if (!deps.sandbox || !provider) throw new PermanentJobError("no computer provider configured");
      await runComputerStop(
        { ...deps.sandbox, provider, pubsub: deps.pubsub },
        orgOf(job),
        String(job.payload.agentId),
        String(job.payload.actorId),
      );
    },
    "storage.migrate": async (job) => {
      if (!deps.storage) throw new PermanentJobError("no storage configured");
      await runMigration(deps.storage, String(job.payload.migrationId));
    },
    "email.send": async (job) => {
      if (!deps.email) throw new PermanentJobError("no email sender configured");
      await sendQueuedEmail(deps.email, job.payload);
    },
    // A background task on a connected computer ended: its conversation wakes (ADR 0029).
    "machine.task_done": async (job) => {
      const woke = await wakeConversationForTask({ db: deps.db, pubsub: deps.pubsub }, String(job.payload.taskId), {
        maxHops: deps.maxHops,
      });
      // A mission's task: its notes come back, its main session hears, queued messages go out.
      if (woke && "missionTask" in woke) await onMissionTaskEnded(missions, String(job.payload.taskId));
    },
    // The `.agentes/` files of a mission changed (debounced): written to its machine.
    "mission.sync_files": async (job) => {
      await syncMissionFiles(missions, String(job.payload.missionId));
    },
    // A mission's plan finished or its work stopped: is everything done (then it waits to be concluded)?
    "mission.check_done": async (job) => {
      await checkMissionDone(missions, String(job.payload.missionId), Number(job.payload.attempt ?? 0) || 0);
    },
    // An approval asked by a mission's executor was decided or expired: its session is resumed.
    "mission.approval_decided": async (job) => {
      await onMissionApprovalDecided(missions, String(job.payload.approvalId));
    },
    // A machine went offline a grace ago: if still offline, its running tasks are interrupted (one notice per thread).
    "machine.tasks_offline": async (job) => {
      await interruptOfflineMachineTasks({ db: deps.db, pubsub: deps.pubsub }, String(job.payload.machineId));
    },
    "context.consolidate": async (job) => {
      if (!deps.context) return;
      await consolidateOrg(deps.context, orgOf(job));
    },
  };
}
