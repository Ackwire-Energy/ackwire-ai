/**
 * MOCK — an agent's run history ("Ver execuções").
 * Waiting for: GET /api/app/organizations/{orgId}/agents/{agentId}/runs?q=&month=
 * returning summary, where, tokens and cost per run (agent_runs + usage_records).
 */
import type { MockedApi } from "../client";
import type { AgentRunSummary } from "../types";
import { type MockContext, minutesAgo, mockId } from "./context";

const DEMO: [minutesAgo: number, summary: string, where: string, tokens: number, costUsd: number][] = [
  [2, "Pediu aprovação para o merge do PR #42", "#eng", 310, 0.001],
  [3, "Investigou o 401 no login", "#eng", 1240, 0.004],
  [24 * 60, "Revisou o PR #39 de Marina", "#eng", 6880, 0.021],
  [25 * 60, "Explicou a fila de e-mails", "thread em #eng", 2110, 0.007],
  [2 * 24 * 60, "Explicou o fluxo de convites", "DM João", 2950, 0.009],
  [3 * 24 * 60, "Abriu o PR #37: timeout do agendamento", "#eng", 18400, 0.058],
  [4 * 24 * 60, "Resumiu os erros da semana no Sentry", "#eng", 9700, 0.03],
];

export function createMockRuns(ctx: MockContext): MockedApi["runs"] {
  const cache = new Map<string, AgentRunSummary[]>();
  return {
    list: async (orgId, agentId) => {
      const k = `${orgId}:${agentId}`;
      let runs = cache.get(k);
      if (!runs) {
        const now = ctx.now();
        runs = ctx.seed
          ? DEMO.map(([m, summary, where, tokens, costUsd]) => ({
              id: mockId("run"),
              at: minutesAgo(now, m),
              summary,
              where,
              tokens,
              costUsd,
            }))
          : [];
        cache.set(k, runs);
      }
      return { runs: structuredClone(runs), total: runs.length };
    },
  };
}
