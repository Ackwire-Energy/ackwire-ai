import { and, desc, type Executor, eq, inArray, schema } from "@agenteschat/db";

const { issues, issueActivity, users, agents } = schema;

/**
 * "Ask Ada to implement": the work conversation lives in the
 * requester's DM with the agent, as a thread whose root is a compact card
 * (`meta.issueWork`). The agent's instructions never show in the chat: they
 * are built from the issue at run time (`issueWorkBrief`) for every run in
 * that thread. Where the issue came from a channel message, that conversation
 * gets one discreet line (`meta.issueTaken`).
 */
export interface IssueWorkMeta {
  issueId: string;
  number: number;
  title: string;
  agentId: string;
}

/** `meta.issueWork` (the root card of an issue's work thread) or `meta.issueTaken` (the line where it came from). */
export function issueWorkOf(
  meta: Record<string, unknown> | null | undefined,
  key: "issueWork" | "issueTaken" = "issueWork",
) {
  const v = meta?.[key] as Partial<IssueWorkMeta> | undefined;
  if (!v || typeof v !== "object") return null;
  if (typeof v.issueId !== "string" || typeof v.number !== "number" || typeof v.title !== "string") return null;
  return {
    issueId: v.issueId,
    number: v.number,
    title: v.title,
    agentId: typeof v.agentId === "string" ? v.agentId : "",
  };
}

/** Comments read back to the agent at most (newest; older ones are on the issue). */
const COMMENTS_SHOWN = 10;
const COMMENT_CHARS = 1_500;

/**
 * The task block of a run in an issue's work thread, read from the issue now
 * (description, criteria and their state, PRs, the latest comments), so each
 * turn sees what the team wrote on the issue since the last one.
 */
export async function issueWorkBrief(db: Executor, orgId: string, issueId: string): Promise<string | null> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)));
  if (!issue) return null;
  const comments = (
    await db
      .select()
      .from(issueActivity)
      .where(and(eq(issueActivity.issueId, issue.id), eq(issueActivity.kind, "comment")))
      .orderBy(desc(issueActivity.createdAt))
      .limit(COMMENTS_SHOWN)
  ).reverse();
  const personIds = [...new Set(comments.filter((c) => c.authorType === "person").map((c) => c.authorId))];
  const agentIds = [...new Set(comments.filter((c) => c.authorType === "agent").map((c) => c.authorId))];
  const [people, bots] = await Promise.all([
    personIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds))
      : [],
    agentIds.length
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [],
  ]);
  const names = new Map([...people, ...bots].map((r) => [r.id, r.name]));
  const criteria = issue.criteria.map((c, i) => `${i + 1}. [${c.done ? "x" : " "}] ${c.text}`).join("\n");
  const prs = issue.pullRequests.map((p) => `- #${p.number} ${p.url}`).join("\n");
  const lines = comments
    .filter((c) => c.text.trim())
    .map(
      (c) =>
        `- ${names.get(c.authorId) ?? (c.authorType === "agent" ? "an agent" : "someone")} (${c.createdAt.toISOString().slice(0, 16).replace("T", " ")}): ${c.text.trim().slice(0, COMMENT_CHARS)}`,
    );
  return [
    `# Your task: issue #${issue.number}`,
    `The person in this conversation asked you to implement issue #${issue.number} "${issue.title}" (status: ${issue.status}).`,
    issue.description.trim() ? `## Description\n${issue.description.trim()}` : "",
    criteria ? `## Acceptance criteria\n${criteria}` : "",
    prs ? `## Pull requests linked\n${prs}` : "",
    lines.length ? `## Latest comments on the issue\n${lines.join("\n")}` : "",
    [
      "## How to work on it",
      "- This conversation is private between you and the person who asked. The rest of the team follows the work on the issue itself, so post progress there: a short comment with `comment_issue` when you start, at each real step and when you finish.",
      `- Refer to the issue as #${issue.number} in your tools. Check each criterion you meet with \`update_issue\` (\`done_criteria\`), and link the pull request with \`update_issue\`. The issue's status follows your work on its own: don't set it yourself.`,
      "- Comments people leave on the issue show above on your next turns: take them into account.",
      "- Sensitive actions (merge, deploy, rollback) still need a person's approval.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
