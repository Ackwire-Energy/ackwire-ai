import { dispatchMentions } from "./dispatch";
import { executeRun, type RunExecutorDeps } from "./executor";
import type { JobHandlers } from "./outbox";

export interface JobDeps extends RunExecutorDeps {
  maxHops: number;
}

/** Every outbox job kind the core knows. Modules can add more through the server's worker options. */
export function createJobHandlers(deps: JobDeps): JobHandlers {
  return {
    "message.posted": async (job) => {
      await dispatchMentions(
        deps.db,
        { orgId: job.orgId, messageId: String(job.payload.messageId) },
        { maxHops: deps.maxHops },
      );
    },
    "agent_run.execute": async (job, ctx) => {
      await executeRun(deps, String(job.payload.runId), ctx);
    },
  };
}
