import type { EmailSender, SearchIndexResolver, SearchKind } from "@agenteschat/adapters";
import { and, count, eq, schema } from "@agenteschat/db";
import { consolidateOrg } from "./context/consolidate";
import { applyReactionFeedback } from "./context/feedback";
import { REFLECT_DEFAULTS, reflectThread } from "./context/reflect";
import { dispatchDm, dispatchMentions } from "./dispatch";
import { sendQueuedEmail } from "./email";
import { publishChannelEvent } from "./events";
import { executeRun, type RunExecutorDeps } from "./executor";
import { getMessage } from "./messages";
import { enqueue, type JobHandlers, type OutboxJob, PermanentJobError } from "./outbox";
import {
  createLlmRouterStrategy,
  DEFAULT_ROUTER_POLICY,
  type RouterStrategy,
  resolveRouterModel,
  routeMessage,
} from "./router";
import type { AgentRun } from "./runs";
import { indexSource, reindexOrg } from "./search";

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
  router?: {
    /** Off = only @mentions start runs. */
    enabled: boolean;
    /** Deployment default (ROUTER_MODEL); an org may override it in its settings. */
    model: string;
    minScore?: number;
    /** Replaces the core LLM strategy (e.g. an optional external classifier). */
    strategy?: RouterStrategy;
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
  const strategy =
    router.strategy ??
    createLlmRouterStrategy({
      gateway: deps.gateway,
      resolveModel: (orgId) => resolveRouterModel(deps.db, orgId, router.model),
    });
  const policy = {
    minScore: router.minScore ?? DEFAULT_ROUTER_POLICY.minScore,
    maxAgents: DEFAULT_ROUTER_POLICY.maxAgents,
    maxHops: deps.maxHops,
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
      if (message.mentionedAgentIds.length > 0) {
        const res = await dispatchMentions(deps.db, input, { maxHops: deps.maxHops });
        await routed("mention", message.mentionedAgentIds, res.runs);
        return;
      }
      if (message.authorType !== "person") return;
      const [channel] = await deps.db
        .select({ kind: schema.channels.kind })
        .from(schema.channels)
        .where(eq(schema.channels.id, message.channelId));
      if (channel?.kind === "dm") {
        const res = await dispatchDm(deps.db, message, { maxHops: deps.maxHops });
        await routed("dm", res.agentIds, res.runs);
        return;
      }
      if (!router.enabled) return routed("none", [], []);
      const res = await routeMessage({ db: deps.db, strategy, policy }, input, ctx);
      if (res.skipped === "already_routed") return;
      await routed(res.seenBy ? "router" : "none", res.seenBy ?? [], res.runs, res.reason);
    },
    "agent_run.execute": async (job, ctx) => {
      await executeRun(deps, String(job.payload.runId), ctx);
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
    "email.send": async (job) => {
      if (!deps.email) throw new PermanentJobError("no email sender configured");
      await sendQueuedEmail(deps.email, job.payload);
    },
    "context.consolidate": async (job) => {
      if (!deps.context) return;
      await consolidateOrg(deps.context, orgOf(job));
    },
  };
}
