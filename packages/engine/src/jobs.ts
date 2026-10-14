import type { SearchIndexResolver, SearchKind } from "@agenteschat/adapters";
import { and, count, eq, schema } from "@agenteschat/db";
import { consolidateOrg } from "./context/consolidate";
import { applyReactionFeedback } from "./context/feedback";
import { REFLECT_DEFAULTS, reflectThread } from "./context/reflect";
import { dispatchMentions } from "./dispatch";
import { executeRun, type RunExecutorDeps } from "./executor";
import { getMessage } from "./messages";
import { enqueue, type JobHandlers } from "./outbox";
import {
  createLlmRouterStrategy,
  DEFAULT_ROUTER_POLICY,
  type RouterStrategy,
  resolveRouterModel,
  routeMessage,
} from "./router";
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
      const input = { orgId: job.orgId, messageId: String(job.payload.messageId) };
      const message = await getMessage(deps.db, input.orgId, input.messageId);
      if (!message) return;
      if (deps.context && message.threadId) await maybeEnqueueReflection(deps, message.orgId, message.threadId);
      if (message.mentionedAgentIds.length > 0) {
        await dispatchMentions(deps.db, input, { maxHops: deps.maxHops });
      } else if (router.enabled) {
        await routeMessage({ db: deps.db, strategy, policy }, input, ctx);
      }
    },
    "agent_run.execute": async (job, ctx) => {
      await executeRun(deps, String(job.payload.runId), ctx);
    },
    "search.index": async (job) => {
      if (!deps.search) return;
      await indexSource(
        { db: deps.db, search: deps.search, gateway: deps.gateway },
        { orgId: job.orgId, kind: job.payload.kind as SearchKind, sourceId: String(job.payload.sourceId) },
      );
    },
    "search.reindex": async (job) => {
      if (!deps.search) return;
      await reindexOrg({ db: deps.db, search: deps.search, gateway: deps.gateway }, job.orgId);
    },
    "context.reflect": async (job) => {
      if (!deps.context) return;
      await reflectThread(deps.context, { orgId: job.orgId, threadRootId: String(job.payload.threadRootId) });
    },
    "context.feedback": async (job) => {
      await applyReactionFeedback(deps.db, {
        orgId: job.orgId,
        messageId: String(job.payload.messageId),
        reaction: String(job.payload.reaction),
      });
    },
    "context.consolidate": async (job) => {
      if (!deps.context) return;
      await consolidateOrg(deps.context, job.orgId);
    },
  };
}
