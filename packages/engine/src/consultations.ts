import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, lt, schema } from "@agenteschat/db";
import { canTalkTo } from "./audience";
import { createAgentRuns, requesterOf } from "./dispatch";
import { openAgentDm } from "./dms";
import { publishChannelEvent } from "./events";
import { getMessage, insertMessage } from "./messages";
import { resumeRunWithResult } from "./run-resume";
import type { ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const { agentConsultations, agentRuns, agents, messages } = schema;

export const ASK_AGENT_TOOL = "ask_agent";
/** How long the asking agent waits for an answer before it goes on without one. */
export const CONSULTATION_TTL_MS = 15 * 60_000;
/** Agents in one chain of consultations: Dev → Infra → one more, then no further. */
export const MAX_CONSULTATION_CHAIN = 2;

export type AgentConsultationRow = typeof agentConsultations.$inferSelect;

const refuse = (content: string): ToolOutput => ({ content, isError: true });

/**
 * The built-in `ask_agent` tool (ADR 0034): an agent asks another agent of
 * the organization and waits for the answer, like `ask_user` waits for a
 * person. The question goes to the private DM between the two agents, the
 * consulted agent runs there (on behalf of the same person, with its own
 * scopes: nothing is granted), and its reply resumes the asking run.
 *
 * Code decides who may be asked: an active agent of the org, not the asker,
 * one the person behind the run can talk to (D31), and not already in this
 * chain (no cycles, at most `MAX_CONSULTATION_CHAIN` agents deep).
 */
export function createAskAgentToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: ASK_AGENT_TOOL,
    description:
      "Ask another agent of the organization something and wait for its answer, e.g. a dev agent asking @infra how staging is deployed. It answers privately, with its own tools and knowledge; you get its reply and go on. Use it when another agent knows or can do something you need for this task (its role says so); don't use it for what you can do yourself, and never to ask a person (use ask_user). Write the question so it stands alone: the other agent doesn't see this conversation.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", minLength: 2, maxLength: 33, description: "The agent's handle, e.g. @infra." },
        question: { type: "string", minLength: 1, maxLength: 4000 },
      },
      required: ["agent", "question"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Ask ${String(input.agent)}`, detail: String(input.question ?? "") }),
    async execute(input, ctx) {
      const handle = String(input.agent).trim().replace(/^@/, "").toLowerCase();
      const question = String(input.question).trim();
      if (!question) return refuse("Write the question.");
      const { db } = ctx;
      const [target] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.handle, handle), isNull(agents.archivedAt)));
      if (!target) return refuse(`There is no agent @${handle} in this organization.`);
      if (target.id === ctx.agentId) return refuse("That is you: answer it yourself.");

      const trigger = await getMessage(db, ctx.orgId, ctx.triggerMessageId);
      const person = trigger ? await requesterOf(db, trigger) : null;
      if (!canTalkTo(target, person)) {
        return refuse(`@${handle} only works with some people, and the person you are helping isn't one of them.`);
      }
      // This run may itself answer a consultation: the chain goes on from there.
      const [parent] = await db
        .select({ chain: agentConsultations.chain })
        .from(agentConsultations)
        .where(and(eq(agentConsultations.orgId, ctx.orgId), eq(agentConsultations.targetRunId, ctx.runId)));
      const chain = [...(parent?.chain ?? []), ctx.agentId];
      if (chain.includes(target.id)) {
        return refuse(`@${handle} is already part of this consultation (it asked you). Answer with what you know.`);
      }
      if (chain.length > MAX_CONSULTATION_CHAIN) {
        return refuse(
          "This is already a consultation between agents: answer with what you know, without asking another agent.",
        );
      }

      const [run] = await db
        .select({ hop: agentRuns.hop })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)));
      const waitId = Bun.randomUUIDv7();
      const consultationId = Bun.randomUUIDv7();
      const created = await db.transaction(async (tx) => {
        const channel = await openAgentDm(tx, ctx.orgId, ctx.agentId, target.id);
        const message = await insertMessage(tx, {
          orgId: ctx.orgId,
          channelId: channel.id,
          author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: run?.hop ?? 1 },
          body: question,
          meta: { consultation: { id: consultationId } },
        });
        const [targetRun] = await createAgentRuns(tx, message, [target.id], "dm");
        const [row] = await tx
          .insert(agentConsultations)
          .values({
            id: consultationId,
            orgId: ctx.orgId,
            askerRunId: ctx.runId,
            askerAgentId: ctx.agentId,
            targetAgentId: target.id,
            channelId: channel.id,
            messageId: message.id,
            targetRunId: targetRun?.id ?? null,
            waitId,
            question,
            chain,
            expiresAt: new Date(Date.now() + CONSULTATION_TTL_MS),
          })
          .returning();
        return row;
      });
      if (!created) return refuse(`Could not reach @${handle}. Go on without it.`);
      return {
        content: "",
        data: { pause: { kind: "input", id: waitId }, consultation: { id: created.id, agentId: target.id } },
      };
    },
  };
  return { name: "consultations", tools: async () => [tool] };
}

/** What the asking agent hears back. */
export function consultationResult(c: Pick<AgentConsultationRow, "status" | "answer">, handle: string) {
  if (c.status === "answered" && c.answer) return { content: `@${handle} answered:\n\n${c.answer}` };
  if (c.status === "expired")
    return {
      content: `@${handle} didn't answer within ${CONSULTATION_TTL_MS / 60_000} minutes. Go on with what you know, and say what is still missing.`,
    };
  return { content: `@${handle} couldn't answer (${c.answer ?? "its run failed"}). Go on with what you know.` };
}

async function handleOf(db: Database, orgId: string, agentId: string) {
  const [a] = await db
    .select({ handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return a?.handle ?? "agent";
}

/** Closes a consultation and resumes the asking run with what came of it. */
async function closeConsultation(
  deps: { db: Database; pubsub?: PubSub },
  row: AgentConsultationRow,
  status: "answered" | "expired" | "failed",
  answer: string | null,
) {
  const [closed] = await deps.db
    .update(agentConsultations)
    .set({ status, answer, answeredAt: new Date() })
    .where(and(eq(agentConsultations.id, row.id), eq(agentConsultations.status, "open")))
    .returning();
  if (!closed) return null;
  const handle = await handleOf(deps.db, closed.orgId, closed.targetAgentId);
  const resumed = await resumeRunWithResult(deps.db, {
    runId: closed.askerRunId,
    waitId: closed.waitId,
    result: consultationResult(closed, handle),
    consulted: { agentId: closed.targetAgentId, consultationId: closed.id, status },
  });
  if (resumed) {
    const [asker] = await deps.db
      .select({ channelId: agentRuns.channelId, threadRootId: agentRuns.threadRootId })
      .from(agentRuns)
      .where(eq(agentRuns.id, closed.askerRunId));
    if (asker) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.consulted",
        channelId: asker.channelId,
        threadId: asker.threadRootId,
        runId: closed.askerRunId,
        agentId: closed.askerAgentId,
        consultedAgentId: closed.targetAgentId,
        status,
      });
    }
  }
  return closed;
}

/**
 * A run in an agents' DM ended: if it answered a consultation, its reply
 * goes back to the asking run (done), or the asker hears it failed.
 * Waiting states (an approval the consulted agent needs) keep it open.
 */
export async function onConsultedRunFinished(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string },
  status: "done" | "failed" | "canceled" | "waiting_approval" | "waiting_input",
  error?: string,
) {
  if (status === "waiting_approval" || status === "waiting_input") return null;
  const [row] = await deps.db
    .select()
    .from(agentConsultations)
    .where(
      and(
        eq(agentConsultations.orgId, run.orgId),
        eq(agentConsultations.targetRunId, run.id),
        eq(agentConsultations.status, "open"),
      ),
    );
  if (!row) return null;
  if (status !== "done") return closeConsultation(deps, row, "failed", error?.slice(0, 500) ?? status);
  const [reply] = await deps.db
    .select({ body: messages.body })
    .from(agentRuns)
    .innerJoin(messages, and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.replyMessageId)))
    .where(eq(agentRuns.id, run.id));
  const answer = reply?.body?.trim() || null;
  return answer
    ? closeConsultation(deps, row, "answered", answer.slice(0, 16_000))
    : closeConsultation(deps, row, "failed", "no reply");
}

/** Closes consultations past their deadline and resumes the asking runs (worker, every minute). */
export async function expireConsultations(deps: { db: Database; pubsub?: PubSub }, now = new Date()) {
  const rows = await deps.db
    .select()
    .from(agentConsultations)
    .where(and(eq(agentConsultations.status, "open"), lt(agentConsultations.expiresAt, now)))
    .limit(200);
  let closed = 0;
  for (const row of rows) if (await closeConsultation(deps, row, "expired", null)) closed++;
  return closed;
}
