import { and, type Database, desc, eq, gt, isNull, ne, or, schema, sql } from "@agenteschat/db";
import type { Judge } from "./judge";
import { deferrableGroups, type ToolGroup, toolGroupKey } from "./tools/directory";
import type { ToolDefinition } from "./tools/types";

/**
 * Tools on demand (D65): a run starts with the core tools (conversation,
 * memory, skills, reading the wiki) and the groups the judge expects it to
 * need for this message; every other tool stays one `find_tools` away. The
 * judge only picks what is listed up front: permissions don't change, and a
 * wrong guess costs a search, never a capability. The choice is made once per
 * run and kept on the transcript (`toolGroups`), so the tool list, and with
 * it the prompt cache, stays the same for the whole run. Some groups go
 * without asking (`keptToolGroups`): the thread's (its list only grows) and
 * those used in the channel lately. Completes D58's step 2, for every tool.
 */

/** A group is loaded up front at this probability or more (a miss costs a search; a load costs every call). */
export const TOOL_GROUP_THRESHOLD = 0.3;
/** The judge answers within this, or the run starts with the core tools only. */
export const TOOL_GROUPS_TIMEOUT_MS = 1500;
/** Tool names per group shown to the judge. */
const NAMES_PER_GROUP = 20;

/** Why a run loaded what it did, for its `context` step. */
export interface ToolGroupChoice {
  groups: string[];
  /** Each group's probability; empty when the judge didn't answer. */
  scores: Record<string, number>;
  /** "judge", or why it fell back to the core tools and `keep` ("timeout", "error", "none"). */
  source: "judge" | "timeout" | "error" | "none";
  /** Groups loaded without asking (`keptToolGroups`). */
  kept: string[];
}

const describeGroup = (g: ToolGroup) =>
  `${g.label}: ${g.tools
    .slice(0, NAMES_PER_GROUP)
    .map((t) => t.name)
    .join(", ")}${g.tools.length > NAMES_PER_GROUP ? `, and ${g.tools.length - NAMES_PER_GROUP} more` : ""}`;

/**
 * The tool groups a run loads up front: `keep`, and one calibrated yes/no per
 * other group the agent may use ("will it need these for this message?"), all
 * in one judge request. Without an answer in time, only `keep` (with the core
 * tools and `find_tools`).
 */
export async function chooseToolGroups(
  judge: Judge,
  input: {
    orgId: string;
    /** The agent and run, for the judge's usage record. */
    agentId?: string;
    runId?: string;
    /** The agent's role and instructions, short. */
    agent: { name: string; role: string; instructions: string };
    /** What the run answers. */
    message: string;
    /** The latest messages where it answers, oldest first ("person: text"). */
    recent: string[];
    tools: ToolDefinition[];
    /** Groups loaded without asking the judge (`keptToolGroups`). */
    keep?: string[];
    timeoutMs?: number;
  },
): Promise<ToolGroupChoice> {
  const all = deferrableGroups(input.tools);
  const kept = all.filter((g) => input.keep?.includes(g.key)).map((g) => g.key);
  const groups = all.filter((g) => !kept.includes(g.key));
  const none = (source: ToolGroupChoice["source"]): ToolGroupChoice => ({ groups: kept, scores: {}, source, kept });
  if (groups.length === 0) return none("none");
  const questions = Object.fromEntries(
    groups.map((g, i) => [
      `g${i}`,
      {
        type: "noul" as const,
        instructions: `An AI agent of a team (\`agent\`) is about to answer \`message\` in a chat thread (\`recent\` is what was said before it). Will it need these tools to do what the message asks, or to look into it before answering? ${describeGroup(g)}`,
        criteria: {
          true: "It will likely use these tools for this message: the message (or the thread it continues) is about what they do.",
          false: "It won't need them for this message.",
        },
      },
    ]),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? TOOL_GROUPS_TIMEOUT_MS);
  });
  try {
    const answers = await Promise.race([
      judge.ask({
        orgId: input.orgId,
        agentId: input.agentId,
        runId: input.runId,
        kind: "tool_groups",
        calibrated: true,
        state: {
          agent: {
            name: input.agent.name,
            role: input.agent.role,
            instructions: input.agent.instructions.slice(0, 1500),
          },
          message: input.message.slice(0, 2000),
          recent: input.recent.map((m) => m.slice(0, 400)).join("\n"),
        },
        questions,
      }),
      timeout,
    ]);
    if (answers === "timeout") return none("timeout");
    const scores: Record<string, number> = {};
    const chosen = [...kept];
    groups.forEach((g, i) => {
      const p = answers[`g${i}`]?.noul ?? 0;
      scores[g.key] = Math.round(p * 1000) / 1000;
      if (p >= TOOL_GROUP_THRESHOLD) chosen.push(g.key);
    });
    return { groups: chosen, scores, source: "judge", kept };
  } catch {
    return none("error");
  } finally {
    clearTimeout(timer);
  }
}

/** Messages the judge reads before the one the run answers. */
const RECENT_MESSAGES = 6;

/**
 * The latest messages where the run answers, oldest first, for the judge:
 * the thread when it has replies, else the channel's top level. Only the
 * last week (the table is partitioned by time).
 */
export async function recentForJudge(
  db: Database,
  run: { orgId: string; channelId: string; threadRootId: string; triggerMessageId: string },
): Promise<string[]> {
  const m = schema.messages;
  const since = gt(m.createdAt, new Date(Date.now() - 7 * 24 * 3600_000));
  const pick = { body: m.body, authorType: m.authorType, id: m.id };
  const base = and(eq(m.orgId, run.orgId), eq(m.channelId, run.channelId), since, isNull(m.deletedAt));
  let rows = await db
    .select(pick)
    .from(m)
    .where(and(base, or(eq(m.threadId, run.threadRootId), eq(m.id, run.threadRootId))))
    .orderBy(desc(m.createdAt))
    .limit(RECENT_MESSAGES + 1);
  if (rows.length <= 1) {
    rows = await db
      .select(pick)
      .from(m)
      .where(and(base, isNull(m.threadId)))
      .orderBy(desc(m.createdAt))
      .limit(RECENT_MESSAGES + 1);
  }
  return rows
    .filter((r) => r.id !== run.triggerMessageId)
    .slice(0, RECENT_MESSAGES)
    .reverse()
    .map((r) => `${r.authorType}: ${r.body.replace(/\s+/g, " ")}`);
}

/** Tools the agent used in the channel this recently are loaded again without asking (D58: 77/77 with the judge). */
export const RECENT_USE_MS = 6 * 3600_000;

/**
 * The groups a run keeps without asking the judge (D65): those the agent's
 * previous run in this thread listed (the thread's tool list only grows, so a
 * computer brain's session and the cache aren't reset by every message), and
 * those of the tools it called in this channel in the last 6 hours.
 */
export async function keptToolGroups(
  db: Database,
  run: { id: string; orgId: string; agentId: string; channelId: string; threadRootId: string },
  tools: ToolDefinition[],
): Promise<string[]> {
  const r = schema.agentRuns;
  const st = schema.agentRunSteps;
  const [previous, used] = await Promise.all([
    db
      .select({ transcript: r.transcript })
      .from(r)
      .where(
        and(eq(r.orgId, run.orgId), eq(r.agentId, run.agentId), eq(r.threadRootId, run.threadRootId), ne(r.id, run.id)),
      )
      .orderBy(desc(r.createdAt))
      .limit(1),
    db
      .selectDistinct({ name: sql<string>`${st.data}->>'name'` })
      .from(r)
      .innerJoin(st, eq(st.runId, r.id))
      .where(
        and(
          eq(r.orgId, run.orgId),
          eq(r.agentId, run.agentId),
          gt(r.createdAt, new Date(Date.now() - RECENT_USE_MS)),
          eq(r.channelId, run.channelId),
          eq(st.kind, "tool_call"),
        ),
      )
      .limit(200),
  ]);
  const groups = (previous[0]?.transcript as { toolGroups?: unknown } | null)?.toolGroups;
  const kept = new Set(Array.isArray(groups) ? groups.filter((g): g is string => typeof g === "string") : []);
  const names = new Set(used.map((u) => u.name));
  for (const t of tools) if (names.has(t.name)) kept.add(toolGroupKey(t));
  return [...kept];
}
