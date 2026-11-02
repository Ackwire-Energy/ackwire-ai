import { and, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { feedingBrief, messageRoot, type RunAuthority, runAuthorityById } from "./authority";
import { isAgentOnlyDm } from "./dms";
import { routineCreatorOf } from "./requester";
import { isRoutineRoomKey } from "./routine-brief";

const { channels, messages } = schema;

/**
 * Whom a run in the agents' DM works for, as its reads there are keyed: the person behind it, else the creator of
 * the routine it runs for (`routine:<id>`: never their own person, so a routine's work and its creator's
 * consultations stay apart), else null (nobody).
 */
export const readerOf = (authority: RunAuthority): string | null => {
  if (authority.personId) return authority.personId;
  const creator = routineCreatorOf(authority);
  return creator ? `routine:${creator}` : null;
};

/** `readerOf` for the run that made a message (`messageRoot`). */
export async function readerOfMessage(db: Executor, orgId: string, messageId: string): Promise<string | null> {
  const root = await messageRoot(db, orgId, messageId);
  if (root.kind === "person") return root.personId;
  if (root.kind === "agent") return null;
  const creator = (await feedingBrief(db, orgId, root))?.creatorUserId;
  return creator ? `routine:${creator}` : null;
}

/** `readerOf` by run id; null without a run. */
export const readerOfRun = async (db: Executor, orgId: string, runId: string | null | undefined) =>
  runId ? readerOf(await runAuthorityById(db, orgId, runId)) : null;

/**
 * What a run in the agents' DM may read of that DM (ADR 0053 §9). Every person's consultations between two agents
 * land in the one DM, so explicit reads there (search hits, memories, summaries, past steps, files) keep only what
 * was made for the same reader as the run (`readerOf`), as its history does (`forSamePerson` in `context.ts`); a null
 * reader matches only what nobody is behind. Null when `channelId` is not an agents' DM (a routine's room has its own
 * rule). `readerOfCaller` is asked only for an agents' DM.
 */
export async function agentsDmReads(
  db: Executor,
  orgId: string,
  channelId: string,
  readerOfCaller: () => Promise<string | null>,
) {
  const [channel] = await db
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  if (!channel || !isAgentOnlyDm(channel) || isRoutineRoomKey(channel.dmKey)) return null;
  const reader = await readerOfCaller().catch(() => null);
  const people = new Map<string, Promise<string | null>>();
  const personOf = (messageId: string) => {
    let found = people.get(messageId);
    if (!found) {
      found = readerOfMessage(db, orgId, messageId);
      people.set(messageId, found);
    }
    return found;
  };
  const runs = new Map<string, Promise<string | null>>();
  const ofRun = async (runId: string) => {
    let found = runs.get(runId);
    if (!found) {
      found = readerOfRun(db, orgId, runId);
      runs.set(runId, found);
    }
    return (await found) === reader;
  };
  /** Every message exists and was made for the same person; none at all proves nothing. */
  const ofMessages = async (ids: string[]) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return false;
    const found = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), inArray(messages.id, unique)));
    if (found.length !== unique.length) return false;
    return (await Promise.all(unique.map(personOf))).every((p) => p === reader);
  };
  return {
    channelId,
    ofMessages,
    /** A memory or summary from this DM only when every message it came from was; one from elsewhere passes. */
    item: (item: { kind: string; channelIds: string[]; sourceIds: string[] }) =>
      item.channelIds.includes(channelId) ? ofMessages(item.sourceIds) : Promise.resolve(true),
    ofRun,
  };
}

export type AgentsDmReads = NonNullable<Awaited<ReturnType<typeof agentsDmReads>>>;
