import {
  channelTopic,
  createMemoryPubSub,
  createPostgresSearchResolver,
  type KeyWrapper,
  noPlatformCredentials,
  type PlatformCredentials,
  type RealtimeEvent,
} from "@agenteschat/adapters";
import { type Database, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createFakeEmbeddings, createFakeProvider, type FakeProvider } from "@agenteschat/providers/testing";
import {
  addChannelMember,
  type ContextDeps,
  createAgent,
  createContextToolSource,
  createCredential,
  createJobHandlers,
  createLocalKeyWrapper,
  createModelGateway,
  createOrganization,
  createToolGateway,
  type MemberRole,
  type ToolSource,
} from "../src";

export const SECRET = "test-secret-".padEnd(48, "x");

export async function addUser(db: Database, name: string) {
  const id = `user_${name}_${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.users).values({ id, name, email: `${name}-${id.slice(-8)}@example.com` });
  return { id, name, email: `${name}-${id.slice(-8)}@example.com` };
}

export async function addMember(db: Database, orgId: string, role: MemberRole, name: string = role) {
  const user = await addUser(db, name);
  await db.insert(schema.organizationMembers).values({ orgId, userId: user.id, role });
  return user;
}

/**
 * A fresh database with one organization (owner `ana`), its `general`
 * channel, an Anthropic credential and one agent `@dev` in `general`.
 * Uses the fake provider and in-memory pub/sub: no network.
 */
export async function setup(
  options: {
    reply?: Parameters<typeof createFakeProvider>[0];
    budgetNanoUsd?: number | null;
    platform?: PlatformCredentials;
    /** Tool sources for the Tool Gateway (none = agents only chat). */
    toolSources?: ToolSource[];
    /** Add the built-in context tools (search_context, remember…) to the tool sources. */
    contextTools?: boolean;
    /** Fake embeddings (hybrid search). Off: full-text only, no embedding usage rows. */
    embeddings?: boolean;
  } = {},
) {
  const { db, close } = await createTestDatabase();
  const keyWrapper: KeyWrapper = createLocalKeyWrapper(SECRET);
  const owner = await addUser(db, "ana");
  const { organization: org, general } = await createOrganization(db, owner.id, {
    name: "Acme",
    context: "Acme builds rockets.",
  });
  const credential = await createCredential(db, keyWrapper, owner.id, org.id, {
    provider: "anthropic",
    label: "main",
    apiKey: "sk-ant-test-key-1234",
  });
  const agent = await createAgent(
    db,
    owner.id,
    org.id,
    {
      name: "Dev",
      handle: "dev",
      role: "Developer",
      instructions: "Answer briefly.",
      credentialId: credential.id,
      monthlyBudgetNanoUsd: options.budgetNanoUsd ?? null,
    },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(db, owner.id, org.id, general.id, { agentId: agent.id });

  const provider: FakeProvider = createFakeProvider(options.reply);
  const openaiProvider: FakeProvider = createFakeProvider(options.reply);
  const pubsub = createMemoryPubSub();
  const embeddings = createFakeEmbeddings();
  const gateway = createModelGateway({
    db,
    keyWrappers: [keyWrapper],
    providers: { anthropic: provider, openai: openaiProvider },
    platformCredentials: options.platform ?? noPlatformCredentials,
    embeddings: options.embeddings ? { provider: embeddings, apiKey: "test" } : undefined,
  });
  const search = createPostgresSearchResolver(db);
  const context: ContextDeps = {
    db,
    gateway,
    search,
    summaryModel: "claude-haiku-5-5",
    pubsub,
    reflect: { everyMessages: 1000, idleMinutes: 120, maxPerThread: 5 },
  };
  const sources = [...(options.contextTools ? [createContextToolSource(context)] : []), ...(options.toolSources ?? [])];
  const tools = sources.length > 0 ? createToolGateway({ sources }) : undefined;
  const jobDeps = {
    db,
    gateway,
    pubsub,
    maxOutputTokens: 1000,
    contextMessages: 30,
    maxHops: 3,
    deltaFlushMs: 0,
    tools,
    context,
    search,
  };
  const handlers = createJobHandlers(jobDeps);

  /** Records every event published to a channel. */
  const listen = (channelId: string) => {
    const events: RealtimeEvent[] = [];
    pubsub.subscribe(channelTopic(channelId), (e) => events.push(e));
    return events;
  };

  return {
    db,
    close,
    keyWrapper,
    owner,
    org,
    general,
    credential,
    agent,
    provider,
    openaiProvider,
    pubsub,
    gateway,
    tools,
    context,
    search,
    embeddings,
    handlers,
    jobDeps,
    listen,
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;
