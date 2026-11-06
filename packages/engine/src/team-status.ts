import { and, type Database, eq, gte, inArray, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { lineInEnglish, loadAgentStatuses } from "./agent-status";
import { listApprovals } from "./approvals";
import { seesAgentDetails } from "./audience";
import { readsOrMayJoin } from "./channels";
import { proposalsWaitingFor } from "./context/proposals";
import { listIssues } from "./issues";
import { oneLine } from "./mail/text";
import { appPageLink } from "./message-links";
import { getMembership } from "./organizations";
import { isRightHand, rightHandReader } from "./right-hand";
import type { ToolDefinition, ToolSource } from "./tools/types";
import { liveWorksByAgent } from "./works";

const { agentQuestions, agentRuns, agents, channels } = schema;

export const TEAM_STATUS_TOOL = "team_status";

/** "Lately": what the report looks back on. */
const LATELY_MS = 24 * 3_600_000;
/** A task of an agent that moved for this long is stuck. */
const STUCK_MS = 4 * 3_600_000;
const TEAM_MAX = 40;
const TASKS_LISTED = 12;
const TITLE_CHARS = 100;

/**
 * Titles and lines as plain text, never in the `<external_data>` envelope: "what's going on" must not mark the run as
 * outside (`readsOutside`), or what it hands on next is treated as outside too. With no angle brackets they can't
 * open one, and `read_conversation` keeps its mark for when the person asks for detail.
 */
const clean = (text: string) => oneLine(text.replace(/[<>]/g, " "), TITLE_CHARS);

/**
 * What the team is doing, for this person, from stored data with no model call (ADR 0137 §13): only agents they see
 * (the rest a count), and work in a place they can't read says so, with no subject.
 */
export async function teamStatus(db: Database, orgId: string, personId: string, now = new Date()) {
  const membership = await getMembership(db, personId, orgId);
  const team = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.builtin)))
    .orderBy(agents.createdAt)
    .limit(TEAM_MAX);
  const seen = team.filter((a) => seesAgentDetails(a, personId, membership));
  const ids = seen.map((a) => a.id);
  const since = new Date(now.getTime() - LATELY_MS).toISOString();
  const [statuses, works, runsNow, ended, tasks, approvals, proposals, questions] = await Promise.all([
    loadAgentStatuses(db, orgId, now, ids),
    liveWorksByAgent(db, orgId, ids),
    ids.length
      ? db
          .select({ agentId: agentRuns.agentId, channelId: agentRuns.channelId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, orgId),
              inArray(agentRuns.agentId, ids),
              inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
            ),
          )
      : [],
    ids.length
      ? rowsOf<{ agent_id: string; channel_id: string; done: number | string; failed: number | string }>(
          await db.execute(sql`select r.agent_id, r.channel_id, count(*) filter (where r.status = 'done') as done,
              count(*) filter (where r.status = 'failed') as failed from agent_runs r
            where r.org_id = ${orgId}::uuid and r.created_at >= ${since}::timestamptz
              and r.agent_id = any(${`{${ids.join(",")}}`}::uuid[]) and r.status in ('done', 'failed')
            group by r.agent_id, r.channel_id`),
        )
      : [],
    listIssues(db, { type: "person", userId: personId }, orgId, { limit: 200 }),
    listApprovals(db, personId, orgId, { status: "pending", limit: 200 }),
    proposalsWaitingFor(db, personId, orgId),
    ids.length
      ? db
          .select({ agentId: agentQuestions.agentId, channelId: agentQuestions.channelId })
          .from(agentQuestions)
          .where(
            and(
              eq(agentQuestions.orgId, orgId),
              inArray(agentQuestions.agentId, ids),
              eq(agentQuestions.status, "open"),
              gte(agentQuestions.createdAt, new Date(since)),
            ),
          )
      : [],
  ]);
  const places = [
    ...runsNow.map((r) => r.channelId),
    ...[...works.values()].flat().map((w) => w.channelId),
    ...ended.map((r) => r.channel_id),
    ...questions.map((q) => q.channelId),
  ];
  const reads = await readsOrMayJoin(db, orgId, personId, places);
  const named = reads.size
    ? await db
        .select({ id: channels.id, name: channels.name, kind: channels.kind })
        .from(channels)
        .where(and(eq(channels.orgId, orgId), inArray(channels.id, [...reads])))
    : [];
  const where = (id: string) => {
    const c = named.find((n) => n.id === id);
    return c?.kind === "channel" ? ` in #${c.name}` : "";
  };
  const handle = new Map(seen.map((a) => [a.id, a.handle]));
  const statusOf = new Map(statuses.map((s) => [s.agentId, s]));

  const working: string[] = [];
  const quiet: string[] = [];
  for (const a of seen) {
    const status = statusOf.get(a.id);
    const line = status?.status ?? null;
    const mine = works.get(a.id) ?? [];
    const here = [
      ...runsNow.filter((r) => r.agentId === a.id).map((r) => r.channelId),
      ...mine.map((w) => w.channelId),
    ];
    const unseen = here.some((id) => !reads.has(id));
    const named = line && !line.text && !line.subject && !line.second;
    if (unseen && !named) working.push(`- @${a.handle}: busy with something this person can't see`);
    else if (mine[0]) working.push(`- @${a.handle}: on "${clean(mine[0].title)}"${where(mine[0].channelId)}`);
    else if (line) working.push(`- @${a.handle}: ${clean(lineInEnglish(line) ?? "working")}`);
    else if (status?.presence === "busy") working.push(`- @${a.handle}: working`);
    else quiet.push(`@${a.handle}`);
  }

  const owner = (t: (typeof tasks)[number]) =>
    t.assignee?.type === "agent" ? ` (@${handle.get(t.assignee.id) ?? "an agent"})` : "";
  const task = (t: (typeof tasks)[number]) =>
    `- #${t.number} ${clean(t.title)}${owner(t)} ${appPageLink(orgId, `/issues/${t.number}`)}`;
  const open = tasks.filter((t) => ["todo", "in_progress", "in_review"].includes(t.status));
  const moved = (t: (typeof tasks)[number]) => new Date(t.updatedAt).getTime();
  const stuck = open.filter(
    (t) => t.assignee?.type === "agent" && t.status !== "todo" && now.getTime() - moved(t) > STUCK_MS,
  );
  const done = tasks.filter((t) => t.status === "done" && now.getTime() - moved(t) < LATELY_MS);

  const counts = (key: "done" | "failed") =>
    ended
      .filter((r) => Number(r[key]) > 0)
      .map((r) => {
        const seenHere = reads.has(r.channel_id);
        return `- @${handle.get(r.agent_id)}: ${r[key]}${seenHere ? where(r.channel_id) : " somewhere this person can't see"}`;
      });
  const waiting = approvals.filter((a) => a.canDecide);
  const asked = questions.filter((q) => reads.has(q.channelId));
  const needs = [
    waiting.length ? `- ${waiting.length} approvals: offer_approvals shows them` : "",
    proposals ? `- ${proposals} proposed changes on Aprovações` : "",
    asked.length ? `- ${asked.length} questions from agents, unanswered` : "",
  ].filter(Boolean);
  const hidden = team.length - seen.length;

  const section = (title: string, lines: string[]) => (lines.length ? `${title}\n${lines.join("\n")}` : "");
  return [
    "Tell it in one message with three short parts, in the person's language: done, in progress, needs you. Each line starts with the agent's name and links to the work. Leave out what has nothing.",
    section("Working now:", working),
    quiet.length ? `Quiet: ${quiet.join(", ")}.` : "",
    section(`Open tasks (${open.length}):`, open.slice(0, TASKS_LISTED).map(task)),
    section("Stuck for hours:", stuck.slice(0, TASKS_LISTED).map(task)),
    section("Tasks done today:", done.slice(0, TASKS_LISTED).map(task)),
    section("Runs finished today:", counts("done")),
    section("Runs that failed today:", counts("failed")),
    section("Waiting for this person:", needs),
    hidden > 0 ? `(${hidden} more agent${hidden > 1 ? "s" : ""} this person can't see.)` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * `team_status`, for the right hand alone (a supervisor later): the tool of "what's going on". In the core group, so
 * it is there on the first turn of any brain, and only in the person's own DM with it: in a channel, others read the
 * reply.
 */
export function createTeamStatusToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: TEAM_STATUS_TOOL,
    description:
      "What the team is doing now, for this person: each agent's work, open and stuck tasks, what finished or failed today, what waits for them.",
    scope: "",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => ({ title: "Check on the team" }),
    async execute(_input, ctx) {
      const person = await rightHandReader(ctx);
      if (!person) return { content: "Only in your private conversation with a person.", isError: true };
      return { content: await teamStatus(ctx.db, ctx.orgId, person) };
    },
  };
  return {
    name: "team-status",
    tools: async (ctx) => {
      const [row] = await ctx.db.select({ builtin: agents.builtin }).from(agents).where(eq(agents.id, ctx.agentId));
      return isRightHand(row) ? [tool] : [];
    },
  };
}
