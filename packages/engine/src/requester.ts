import { and, type Executor, eq, schema } from "@agenteschat/db";
import { MAX_CONSULTATION_CHAIN } from "./consultations";

const { agentConsultations, agentRuns, messages } = schema;

/**
 * The person a run acts for, for tools that need "a person's request"
 * (routines and reminders): the author of its trigger message when a person
 * wrote it; for a run answering a consultation (`ask_agent`, ADR 0034), the
 * person at the root of that chain of consultations (on-behalf-of authority).
 *
 * Only consultations carry it, and each link is checked against
 * `agent_consultations` (the message's meta alone proves nothing). Null when
 * no person is at the root: a routine, a webhook, an agent's own message or
 * mention. It never grants anything: the tool still checks the consulted
 * agent's own scopes and that person's permissions.
 */
export async function personBehindRun(db: Executor, orgId: string, triggerMessageId: string): Promise<string | null> {
  let messageId = triggerMessageId;
  for (let depth = 0; depth <= MAX_CONSULTATION_CHAIN; depth++) {
    const [m] = await db
      .select({
        authorType: messages.authorType,
        authorUserId: messages.authorUserId,
        agentRunId: messages.agentRunId,
        meta: messages.meta,
      })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
    if (!m) return null;
    if (m.authorType === "person") return m.authorUserId;
    const consultationId = (m.meta.consultation as { id?: unknown } | undefined)?.id;
    if (typeof consultationId !== "string" || !m.agentRunId) return null;
    const [link] = await db
      .select({ askerTrigger: agentRuns.triggerMessageId })
      .from(agentConsultations)
      .innerJoin(agentRuns, eq(agentRuns.id, agentConsultations.askerRunId))
      .where(
        and(
          eq(agentConsultations.orgId, orgId),
          eq(agentConsultations.id, consultationId),
          eq(agentConsultations.messageId, messageId),
          eq(agentConsultations.askerRunId, m.agentRunId),
        ),
      );
    if (!link) return null;
    messageId = link.askerTrigger;
  }
  return null;
}
