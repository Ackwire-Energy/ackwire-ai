import { dispatchMentions } from "./dispatch";
import { executeRun, type RunExecutorDeps } from "./executor";
import { getMessage } from "./messages";
import type { JobHandlers } from "./outbox";
import {
  createLlmRouterStrategy,
  DEFAULT_ROUTER_POLICY,
  type RouterStrategy,
  resolveRouterModel,
  routeMessage,
} from "./router";

export interface JobDeps extends RunExecutorDeps {
  maxHops: number;
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
      if (message.mentionedAgentIds.length > 0) {
        await dispatchMentions(deps.db, input, { maxHops: deps.maxHops });
      } else if (router.enabled) {
        await routeMessage({ db: deps.db, strategy, policy }, input, ctx);
      }
    },
    "agent_run.execute": async (job, ctx) => {
      await executeRun(deps, String(job.payload.runId), ctx);
    },
  };
}
