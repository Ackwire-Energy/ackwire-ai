import type { RateLimiter } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { FEEDBACK_MAX, FEEDBACK_PER_HOUR, queueFeedback } from "./feedback";
import { getMembership } from "./organizations";
import { personBehindCall } from "./requester";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agents, users } = schema;

export const SEND_FEEDBACK_TOOL = "send_feedback";

/**
 * `send_feedback` (ADR 0160 §11): a person asks an agent to send their feedback, and it goes as the form's does, one
 * email to whoever runs the server (`to`, `FEEDBACK_EMAIL`), in that person's name and within their ten an hour. The
 * email says an agent wrote it. Listed only where the server takes feedback; a run nobody is behind (a routine's, an
 * agent's own) sends none.
 */
export function createFeedbackToolSource(deps: {
  /** `FEEDBACK_EMAIL`; unset, the tool is not listed. */
  to?: string | null;
  /** This server's version. */
  version: string;
  /** The form's limiter, so both ways in count toward the same hour. */
  rateLimiter?: RateLimiter;
}): ToolSource {
  const tool: ToolDefinition = {
    name: SEND_FEEDBACK_TOOL,
    description:
      "Send the person's feedback about this app itself (a bug, something confusing, an idea) to whoever runs this server, by email in their name, only when they ask you to ('manda um feedback dizendo…', 'report this bug for me'). `text`: what they want said, in their words and language, plus what you saw yourself that helps whoever reads it (what was being done, the error as it appeared). Nothing from the conversation they didn't ask to send. Then tell them what you sent.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: FEEDBACK_MAX } },
      required: ["text"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Send feedback" }),
    async execute(input, ctx) {
      const to = deps.to;
      if (!to) return { content: "This server takes no feedback: nothing was sent.", isError: true };
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return { content: "Give the feedback in `text`.", isError: true };
      const person = await personBehindCall(ctx);
      const member = person ? await getMembership(ctx.db, person, ctx.orgId) : null;
      const [user] = person
        ? await ctx.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, person))
        : [];
      if (!person || !member || !user) {
        return {
          content:
            "Feedback goes in a person's name, and nobody asked for this one: nothing was sent. Say it in your reply instead.",
          isError: true,
        };
      }
      if (deps.rateLimiter && !(await deps.rateLimiter.consume(`feedback:${person}`, FEEDBACK_PER_HOUR)).allowed) {
        return {
          content: "They sent too much feedback in the last hour: nothing was sent. Tell them to try again later.",
          isError: true,
        };
      }
      const [agent] = await ctx.db
        .select({ name: agents.name, handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
      await queueFeedback(ctx.db, {
        orgId: ctx.orgId,
        // One email per call: the same call run again (a retry) goes once.
        key: `${person}:${ctx.runId}:${ctx.toolUseId ?? crypto.randomUUID()}`,
        feedback: {
          to,
          name: user.name,
          email: user.email,
          orgName: member.orgName,
          text,
          app: "agent",
          facts: [
            ["Role", member.role],
            ["Written by", agent ? `${agent.name} (@${agent.handle}), an agent, when they asked` : "an agent"],
          ],
          version: deps.version,
        },
      });
      return {
        content:
          "Sent to whoever runs this server, in their name; an answer goes to their email. Tell them what you sent.",
      };
    },
  };
  return { name: "feedback", tools: async () => (deps.to ? [tool] : []) };
}
