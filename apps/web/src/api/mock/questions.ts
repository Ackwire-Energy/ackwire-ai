/**
 * MOCK — answering an agent's question (`ask_user`).
 * Waiting for: `POST /api/app/organizations/{orgId}/questions/{id}/answer`
 * `{ choice? , text? }` → the question (`status: "answered"`), plus the
 * `question.asked` / `question.answered` events. The mock only marks it
 * answered locally; no agent resumes.
 */
import type { MockedApi } from "../client";
import type { AgentQuestion } from "../types";
import type { MockContext } from "./context";

export function createMockQuestions(ctx: MockContext): MockedApi["questions"] {
  return {
    answer: async (_orgId, questionId, input) => {
      const me = await ctx.lookup.me();
      const answered: AgentQuestion = {
        id: questionId,
        agentId: "",
        channelId: "",
        threadId: null,
        messageId: null,
        text: "",
        choices: null,
        status: "answered",
        answer: input.choice ?? input.text ?? "",
        answeredByUserId: me?.user.id ?? null,
      };
      return answered;
    },
  };
}
