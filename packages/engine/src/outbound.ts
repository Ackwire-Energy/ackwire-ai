import { foldText, type OutboundCode, outboundUrlProblem, urlCopiesPrivateText, urlsIn } from "@agenteschat/adapters";
import { and, desc, eq, gt, inArray, isNull, not, or, schema, sql } from "@agenteschat/db";
import type { ToolContext, ToolOutput } from "./tools/types";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "./web-tools";

const THREAD_LIMIT = 500;
const CHANNEL_LIMIT = 50;
const CACHED_RUNS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunReads {
  seq: number;
  seen: Set<string>;
  privateText: string[];
  names: Map<string, string>;
}

/** Per run, what its steps added so far: each check reads only the steps since the last one. */
const cache = new Map<string, RunReads>();

/**
 * `outboundUrlProblem` with what this run knows (ADR 0117): `seen` is every address in the conversation (the
 * thread, the channel's latest messages) and in this run's tool results; `privateText` every tool result of the
 * run except the public web's. Null: the agent may open it.
 */
export async function checkOutboundUrl(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "channelId" | "threadRootId" | "triggerMessageId">,
  url: string,
): Promise<{ code: OutboundCode; message: string } | null> {
  const reads = await runReads(ctx);
  const seen = reads.seen;
  // The cheap checks first: a plain address needs no conversation.
  if (!outboundUrlProblem(url, { privateText: reads.privateText })) return null;
  for (const u of await conversationUrls(ctx)) seen.add(u);
  return outboundUrlProblem(url, { seen: (u) => seen.has(u), privateText: reads.privateText });
}

/** `checkOutboundUrl` as a tool's refusal (its code in `data.code`, final for the continuation), null to go on. */
export async function outboundRefusal(
  ctx: Parameters<typeof checkOutboundUrl>[0],
  url: string,
): Promise<ToolOutput | null> {
  const problem = await checkOutboundUrl(ctx, url);
  return problem ? { content: problem.message, isError: true, data: { code: problem.code, url } } : null;
}

const emptyReads = (): RunReads => ({ seq: -1, seen: new Set(), privateText: [], names: new Map() });

function cachedReads(runId: string): RunReads {
  let reads = cache.get(runId);
  if (!reads) {
    reads = emptyReads();
    if (cache.size >= CACHED_RUNS) cache.delete(cache.keys().next().value as string);
    cache.set(runId, reads);
  }
  return reads;
}

/**
 * One tool result into what the run read. A private result's address that copies text the run read before is no
 * seen address: the agent made it (printed by run_code, echoed by any tool), so it gets the full check.
 */
function addResult(reads: RunReads, tool: string, content: string) {
  const web = tool === WEB_SEARCH_TOOL || tool === WEB_FETCH_TOOL;
  for (const u of urlsIn(content)) {
    if (web || reads.seen.has(u) || !urlCopiesPrivateText(u, reads.privateText)) reads.seen.add(u);
  }
  // The public web's results are no private text.
  if (!web) reads.privateText.push(foldText(content));
}

/**
 * A tool's whole output, as the model got it: run steps keep only its first 4000 characters, and the check must
 * see all of it. Called by the gateway for each result of a stored run.
 */
export function recordRead(runId: string, tool: string, content: string) {
  if (UUID.test(runId)) addResult(cachedReads(runId), tool, content);
}

async function runReads(ctx: Pick<ToolContext, "db" | "orgId" | "runId">): Promise<RunReads> {
  // A call outside a stored run (a test's bare context) has no reads.
  if (!UUID.test(ctx.runId)) return emptyReads();
  const reads = cachedReads(ctx.runId);
  const steps = await ctx.db
    .select({ seq: schema.agentRunSteps.seq, kind: schema.agentRunSteps.kind, data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, ctx.orgId),
        eq(schema.agentRunSteps.runId, ctx.runId),
        inArray(schema.agentRunSteps.kind, ["tool_call", "tool_result"]),
        gt(schema.agentRunSteps.seq, reads.seq),
      ),
    )
    .orderBy(schema.agentRunSteps.seq);
  for (const { seq, kind, data } of steps) {
    reads.seq = Math.max(reads.seq, seq);
    const id = typeof data.toolUseId === "string" ? data.toolUseId : "";
    const name = typeof data.name === "string" ? data.name : "";
    if (kind === "tool_call") {
      if (id) reads.names.set(id, name);
      continue;
    }
    addResult(reads, reads.names.get(id) ?? name, String(data.content ?? ""));
  }
  return reads;
}

/**
 * Addresses people and agents wrote where this run answers: its thread, and the channel's latest messages. What
 * this agent posted since the run started is left out: an address it posted itself is no seen address.
 */
async function conversationUrls(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "channelId" | "threadRootId" | "triggerMessageId">,
): Promise<string[]> {
  const m = schema.messages;
  const ids = [ctx.threadRootId, ctx.triggerMessageId].filter((id) => UUID.test(id));
  if (!UUID.test(ctx.channelId)) return [];
  const own = UUID.test(ctx.runId)
    ? sql`(${m.authorAgentId} is not distinct from ${ctx.agentId} and ${m.createdAt} >= (select ${schema.agentRuns.createdAt} from ${schema.agentRuns} where ${schema.agentRuns.id} = ${ctx.runId}))`
    : sql`false`;
  const scope = and(eq(m.orgId, ctx.orgId), eq(m.channelId, ctx.channelId), isNull(m.deletedAt), not(own));
  const [thread, recent] = await Promise.all([
    ctx.db
      .select({ body: m.body })
      .from(m)
      .where(and(scope, ids.length > 0 ? or(inArray(m.threadId, ids), inArray(m.id, ids)) : sql`false`))
      .orderBy(desc(m.createdAt))
      .limit(THREAD_LIMIT),
    ctx.db
      .select({ body: m.body })
      .from(m)
      .where(and(scope, isNull(m.threadId)))
      .orderBy(desc(m.createdAt))
      .limit(CHANNEL_LIMIT),
  ]);
  return [...thread, ...recent].flatMap((r) => urlsIn(r.body));
}
