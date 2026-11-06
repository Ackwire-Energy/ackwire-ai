import { CODING_PLANS, type CodingPlan, learnPlanModels, PLAN_IDS, readPlanModels } from "@agenteschat/providers/plans";

const LIST_TIMEOUT_MS = 10_000;

/**
 * Reads each plan's public list of models (`modelsUrl`) into this process. A list that's down, slow or unreadable
 * changes nothing: the plan goes on with what it last said, or the table.
 */
export async function refreshPlanModels(read: typeof fetch = fetch) {
  for (const id of PLAN_IDS) {
    const plan: CodingPlan = CODING_PLANS[id];
    if (!plan.modelsUrl) continue;
    const answer = await read(plan.modelsUrl, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }).catch(() => null);
    const body = answer?.ok ? await answer.json().catch(() => null) : null;
    learnPlanModels({ [id]: readPlanModels(plan, body) });
  }
}
