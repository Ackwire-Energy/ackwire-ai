import { and, type Executor, eq, gt, schema, sql } from "@agenteschat/db";
import { UUID } from "./authority";
import { cutText } from "./format";

const { agentQuestions, browserHandoffs, channels, messages, secretRequests } = schema;

/** A request for a person an agent made and nobody answered yet: help on one of its screens, a secret, a question. */
export interface OpenRequest {
  id: string;
  kind: "browser" | "desktop" | "secret" | "question";
  /** What it asked, in its words. */
  what: string;
  runId: string | null;
  channelName: string;
  channelKind: string;
  createdAt: Date;
}

/**
 * The agent's open requests, oldest first. Asked help counts only while nobody took control (then it is the
 * person's turn, not the agent's to take back).
 */
export async function openRequestsOf(db: Executor, orgId: string, agentId: string): Promise<OpenRequest[]> {
  const now = new Date();
  const place = { channelName: channels.name, channelKind: channels.kind };
  const [handoffs, secrets, questions] = await Promise.all([
    db
      .select({ row: browserHandoffs, ...place })
      .from(browserHandoffs)
      .innerJoin(messages, and(eq(messages.orgId, browserHandoffs.orgId), eq(messages.id, browserHandoffs.id)))
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(browserHandoffs.orgId, orgId),
          eq(browserHandoffs.agentId, agentId),
          eq(browserHandoffs.kind, "ask"),
          sql`(${browserHandoffs.status} = 'pending' or (${browserHandoffs.status} = 'active' and ${browserHandoffs.controllerUserId} is null))`,
          gt(browserHandoffs.expiresAt, now),
        ),
      ),
    db
      .select({ row: secretRequests, ...place })
      .from(secretRequests)
      .innerJoin(channels, eq(channels.id, secretRequests.channelId))
      .where(
        and(
          eq(secretRequests.orgId, orgId),
          eq(secretRequests.agentId, agentId),
          eq(secretRequests.status, "pending"),
          gt(secretRequests.expiresAt, now),
        ),
      ),
    db
      .select({ row: agentQuestions, ...place })
      .from(agentQuestions)
      .innerJoin(channels, eq(channels.id, agentQuestions.channelId))
      .where(
        and(
          eq(agentQuestions.orgId, orgId),
          eq(agentQuestions.agentId, agentId),
          eq(agentQuestions.status, "open"),
          gt(agentQuestions.expiresAt, now),
        ),
      ),
  ]);
  return [
    ...handoffs.map(({ row, ...p }) => ({
      id: row.id,
      kind: row.screen,
      what: row.instructions,
      runId: row.runId,
      createdAt: row.createdAt,
      ...p,
    })),
    ...secrets.map(({ row, ...p }) => ({
      id: row.id,
      kind: "secret" as const,
      what: `${row.name}: ${row.purpose}`,
      runId: row.runId,
      createdAt: row.createdAt,
      ...p,
    })),
    ...questions.map(({ row, ...p }) => ({
      id: row.id,
      kind: "question" as const,
      what: row.text,
      runId: row.runId,
      createdAt: row.createdAt,
      ...p,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

const KIND_TEXT: Record<OpenRequest["kind"], string> = {
  browser: "help in your browser",
  desktop: "help on your desktop",
  secret: "a secret",
  question: "a question",
};

/** One request as the agent reads it: id, what, where. */
export const openRequestLine = (r: OpenRequest) =>
  `- ${r.id}: ${KIND_TEXT[r.kind]}, "${cutText(r.what, 200)}", ${r.channelKind === "dm" ? "in a DM" : `in #${r.channelName}`}`;

export const WITHDRAW_REQUEST_TOOL = "withdraw_request";

export const WITHDRAW_RULE =
  "When the person picks another way, the need goes away, or you got what you needed another way, withdraw the request at once with `withdraw_request`: people stop waiting on it.";

/** "# Your open requests", read every turn; null with none. */
export function openRequestsBlock(rows: OpenRequest[]): string | null {
  if (rows.length === 0) return null;
  return [
    "# Your open requests",
    "What you asked people for and nobody answered yet:",
    ...rows.map(openRequestLine),
    WITHDRAW_RULE,
  ].join("\n");
}

/**
 * What a run reads, once, when it reached its answer with requests it made and stopped waiting on still open (a
 * person wrote meanwhile and it went on): it withdraws what it no longer needs, deterministically, without a judge.
 * "" with none.
 */
export function openRequestNudge(rows: OpenRequest[]): string {
  if (rows.length === 0) return "";
  return [
    "Your answer was posted. These requests of yours are still open, and people still see them waiting:",
    ...rows.map(openRequestLine),
    "If you no longer need one (the person chose another way, or you got it done otherwise), withdraw it now with `withdraw_request`. Either way, then end your turn without writing anything.",
  ].join("\n");
}

/** A wait that is help the agent withdrew: no result comes back for it. */
export async function isWithdrawnHandoff(db: Executor, orgId: string, waitId: string) {
  if (!UUID.test(waitId)) return false;
  const [row] = await db
    .select({ id: browserHandoffs.id })
    .from(browserHandoffs)
    .where(
      and(eq(browserHandoffs.orgId, orgId), eq(browserHandoffs.id, waitId), eq(browserHandoffs.status, "withdrawn")),
    );
  return Boolean(row);
}
