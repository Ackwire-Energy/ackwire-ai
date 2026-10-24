import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, lt, schema, sql } from "@agenteschat/db";
import { requireChannelAccess } from "./channels";
import { isAgentOnlyDm } from "./dms";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { resolveQuestionNotifications } from "./notification-producers";
import { enqueue } from "./outbox";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agentQuestions, messages } = schema;

export type AgentQuestionRow = typeof agentQuestions.$inferSelect;

/** How long a question waits for an answer before the run goes on without one. */
export const QUESTION_TTL_MS = 24 * 3600_000;
export const ASK_USER_TOOL = "ask_user";

/** The shape the app renders (`meta.question`, `question.asked` / `question.answered`). */
export interface AgentQuestion {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  messageId: string | null;
  /** The run that asked: the app's receipt finds the message it answers (a channel question has no thread). */
  runId: string;
  text: string;
  choices: string[] | null;
  status: "open" | "answered";
  answer: string | null;
  answeredByUserId: string | null;
}

export function questionView(q: AgentQuestionRow): AgentQuestion {
  return {
    id: q.id,
    agentId: q.agentId,
    channelId: q.channelId,
    threadId: q.threadId,
    messageId: q.messageId,
    runId: q.runId,
    text: q.text,
    choices: q.choices && q.choices.length > 0 ? q.choices : null,
    // An expired question is closed for the app; it shows as answered without an answer.
    status: q.status === "open" ? "open" : "answered",
    answer: q.answer,
    answeredByUserId: q.answeredByUserId,
  };
}

/**
 * A question card's meta: the question as the app renders it, and the agent's required reason
 * (`why`, ADR 0053), which the gateway took out of the call. `syncQuestionMessage` only rewrites
 * `meta.question`, so the reason stays on the card.
 */
export const questionCardMeta = (q: AgentQuestionRow, why: string) => ({
  questionId: q.id,
  question: questionView(q),
  ...(why ? { why } : {}),
});

/**
 * The built-in `ask_user` tool: no scope needed (every agent may ask). It
 * doesn't run anything; the Tool Gateway hands the question (and its `why`)
 * to the executor, which posts it in the thread and suspends the run
 * (`waiting_input`).
 */
export function createAskUserToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: ASK_USER_TOOL,
    description:
      "Ask the person a short clarifying question and wait for the answer. Use it when the request is still ambiguous after you looked with your tools, for a decision that is really theirs, or before a sensitive or irreversible action. Don't use it for what you can just do: internal changes (issues, priorities, assignments, memories, routines) need no ok, the person can undo them. Not for choosing between fixes: recommend one yourself. The question shows as a card with its choices and your `why` (what you found and why you ask): never write the question or the choices in your text; after calling, write nothing else and end your turn. Offer 2 to 4 short choices when the answer is one of a few options.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 1000 },
        choices: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 2, maxItems: 4 },
      },
      required: ["question"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const [channel] = await ctx.db
        .select({ kind: schema.channels.kind, dmKey: schema.channels.dmKey })
        .from(schema.channels)
        .where(and(eq(schema.channels.id, ctx.channelId), eq(schema.channels.orgId, ctx.orgId)));
      if (channel && isAgentOnlyDm(channel)) {
        return {
          content:
            "No person reads this conversation: you are answering another agent. Answer with what you know and say in your answer what is missing.",
          isError: true,
        };
      }
      const text = typeof input.question === "string" ? input.question.trim() : "";
      const choices = Array.isArray(input.choices)
        ? [...new Set((input.choices as unknown[]).map((c) => String(c).trim()).filter(Boolean))]
        : [];
      return {
        content: "",
        waitForAnswer: { text, choices: choices.length >= 2 ? choices.slice(0, 4) : null },
      };
    },
  };
  return { name: "questions", tools: async () => [tool] };
}

/** What the model hears back once the question is closed. */
export function questionResult(q: AgentQuestionRow | undefined): { content: string; isError?: boolean } {
  if (q?.status === "answered" && q.answer !== null) return { content: `The person answered: ${q.answer}` };
  return {
    content:
      "No one answered within 24 hours. Go on with your best judgement if it is safe, or say what you still need.",
  };
}

/** Writes the current state of the question into its chat message (`meta.question`). */
export async function syncQuestionMessage(db: Executor, q: AgentQuestionRow) {
  if (!q.messageId) return;
  await db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{question}', ${JSON.stringify(questionView(q))}::jsonb)` })
    .where(and(eq(messages.id, q.messageId), eq(messages.orgId, q.orgId)));
}

const resumeJob = (q: AgentQuestionRow) => ({
  orgId: q.orgId,
  kind: "agent_run.execute",
  payload: { runId: q.runId },
  dedupeKey: `agent_run.execute:${q.runId}:question:${q.id}`,
  maxAttempts: 4,
});

export async function publishQuestion(
  pubsub: PubSub | undefined,
  q: AgentQuestionRow,
  type: "question.asked" | "question.answered",
) {
  await publishChannelEvent(pubsub, { type, channelId: q.channelId, threadId: q.threadId, question: questionView(q) });
}

/**
 * A person answers a question from the card (`choice`) or with text; both
 * can come together. Anyone who can read the channel may answer. The run
 * resumes with the answer as the tool result.
 */
export async function answerQuestion(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  questionId: string,
  input: { choice?: string; text?: string },
): Promise<AgentQuestion> {
  const { db } = deps;
  const [current] = await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.orgId, orgId)));
  if (!current) throw new NotFoundError("Question not found");
  await requireChannelAccess(db, actorId, orgId, current.channelId);
  const choice = input.choice?.trim() || null;
  const text = input.text?.trim().slice(0, 4000) || null;
  if (!choice && !text) throw new ValidationError("Send a choice or a text answer");
  if (choice && !(current.choices ?? []).includes(choice)) throw new ValidationError("That is not one of the choices");
  const answer = choice && text ? `${choice} (${text})` : (choice ?? text ?? "");
  const answered = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentQuestions)
      .set({ status: "answered", answer, answeredByUserId: actorId, answeredAt: new Date() })
      .where(
        and(
          eq(agentQuestions.id, questionId),
          eq(agentQuestions.status, "open"),
          sql`${agentQuestions.expiresAt} > now()`,
        ),
      )
      .returning();
    if (!row) return null;
    await syncQuestionMessage(tx, row);
    await enqueue(tx, resumeJob(row));
    return row;
  });
  if (!answered) throw new ConflictError("This question was already answered or expired");
  await publishQuestion(deps.pubsub, answered, "question.answered");
  await resolveQuestionNotifications(deps, orgId, answered.id).catch(() => {});
  return questionView(answered);
}

/**
 * After a person's message that answered a question in the same statement
 * (see `insertMessageWithRuns`): sync the card and tell the channel.
 */
export async function afterReplyAnswered(deps: { db: Database; pubsub?: PubSub }, orgId: string, questionId: string) {
  const [row] = await deps.db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.orgId, orgId)));
  if (!row) return;
  await syncQuestionMessage(deps.db, row);
  await publishQuestion(deps.pubsub, row, "question.answered");
  await resolveQuestionNotifications(deps, orgId, row.id).catch(() => {});
}

/** Closes questions past their deadline and resumes their runs (worker, every minute). */
export async function expireQuestions(deps: { db: Database; pubsub?: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(agentQuestions)
      .set({ status: "expired" })
      .where(and(eq(agentQuestions.status, "open"), lt(agentQuestions.expiresAt, now)))
      .returning();
    for (const row of rows) {
      await syncQuestionMessage(tx, row);
      await enqueue(tx, resumeJob(row));
    }
    return rows;
  });
  for (const row of expired) {
    await publishQuestion(deps.pubsub, row, "question.answered");
    await resolveQuestionNotifications(deps, row.orgId, row.id).catch(() => {});
  }
  return expired.length;
}

export async function getQuestion(db: Database, actorId: string, orgId: string, questionId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.orgId, orgId)));
  if (!row) throw new NotFoundError("Question not found");
  await requireChannelAccess(db, actorId, orgId, row.channelId);
  return questionView(row);
}
