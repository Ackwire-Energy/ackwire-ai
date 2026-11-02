import { and, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { personOfMessage, runAuthorityById } from "./authority";
import { isAgentOnlyDm } from "./dms";
import { isRoutineRoomKey } from "./routine-brief";

const { channels, messages } = schema;

/**
 * What a run in the agents' DM may read of that DM (ADR 0053 §9). Every person's consultations between two agents
 * land in the one DM, so explicit reads there (search hits, memories, summaries, past steps, files) keep only what
 * was made for the same person as the run, as its history does (`forSamePerson` in `context.ts`); null `personId`
 * matches only what nobody is behind. Null when `channelId` is not an agents' DM (a routine's room has its own rule).
 */
export async function agentsDmReads(db: Executor, orgId: string, channelId: string, personId: string | null) {
  const [channel] = await db
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  if (!channel || !isAgentOnlyDm(channel) || isRoutineRoomKey(channel.dmKey)) return null;
  const people = new Map<string, Promise<string | null>>();
  const personOf = (messageId: string) => {
    let found = people.get(messageId);
    if (!found) {
      found = personOfMessage(db, orgId, messageId);
      people.set(messageId, found);
    }
    return found;
  };
  const runs = new Map<string, Promise<string | null>>();
  const ofRun = async (runId: string) => {
    let found = runs.get(runId);
    if (!found) {
      found = runAuthorityById(db, orgId, runId).then((a) => a.personId);
      runs.set(runId, found);
    }
    return (await found) === personId;
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
    return (await Promise.all(unique.map(personOf))).every((p) => p === personId);
  };
  return {
    channelId,
    ofMessages,
    /** A memory or summary from this DM only when every message it came from was; one from elsewhere passes. */
    item: (item: { channelIds: string[]; sourceIds: string[] }) =>
      item.channelIds.includes(channelId) ? ofMessages(item.sourceIds) : Promise.resolve(true),
    ofRun,
  };
}

export type AgentsDmReads = NonNullable<Awaited<ReturnType<typeof agentsDmReads>>>;
