import {
  channelTopic,
  createFakeS3,
  createMemoryBlobStore,
  createMemoryPubSub,
  createPostgresSearchResolver,
  type KeyWrapper,
  noPlatformCredentials,
  type PlatformCredentials,
  type RealtimeEvent,
  type SandboxProvider,
} from "@agenteschat/adapters";
import { type Database, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createFakeEmbeddings, createFakeProvider, type FakeProvider } from "@agenteschat/providers/testing";
import {
  type ArtifactDeps,
  addChannelMember,
  type ContextDeps,
  createAgent,
  createArtifactToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createCalendarToolSource,
  createContextToolSource,
  createCredential,
  createIssueToolSource,
  createJobHandlers,
  createLocalKeyWrapper,
  createModelGateway,
  createOrganization,
  createSandboxToolSource,
  createScheduleToolSource,
  createSkillToolSource,
  createToolGateway,
  type MemberRole,
  type SandboxDeps,
  type StorageDeps,
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
    /** Add the built-in `ask_user` tool. */
    askUser?: boolean;
    /** Add the Drive tools (create_artifact…). Storage is always wired (memory platform store, fake S3). */
    artifactTools?: boolean;
    /** Add the issue tools (create_issue, comment_issue…). */
    issueTools?: boolean;
    /** Add the calendar tools (list_events, find_free_time, propose_event). */
    calendarTools?: boolean;
    /** Add the skill tools (load_skill, read_skill_file). */
    skillTools?: boolean;
    /** Fake embeddings (hybrid search). Off: full-text only, no embedding usage rows. */
    embeddings?: boolean;
    /** Add the scheduling tools (schedule_reminder, create_routine…). */
    scheduleTools?: boolean;
    /** Add the sandbox tools with this (fake) provider. */
    sandbox?: SandboxProvider;
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
  // Platform storage in memory; org buckets on a fake S3 server at s3.example.com (DNS faked: public IP).
  const platformBlobs = createMemoryBlobStore();
  const s3 = createFakeS3({
    host: "s3.example.com",
    region: "us-east-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret-test-key-123456",
    buckets: ["acme-files", "acme-new"],
  });
  const storage: StorageDeps = {
    db,
    keyWrappers: [keyWrapper],
    platform: platformBlobs,
    fetch: s3.fetch,
    resolveHost: async (host) => (host.endsWith("example.com") ? ["93.184.216.34"] : ["10.0.0.5"]),
  };
  const artifactDeps: ArtifactDeps = { db, blobs: createBlobStoreResolver(storage), pubsub };
  const sandboxDeps: SandboxDeps | null = options.sandbox
    ? {
        db,
        provider: options.sandbox,
        pricing: { vcpuHourUsd: 0.0504, memoryGibHourUsd: 0.0162, diskGibHourUsd: 0.000108 },
        autoStopMinutes: 10,
        archiveAfterDays: 7,
      }
    : null;
  const sources = [
    ...(options.askUser ? [createAskUserToolSource()] : []),
    ...(options.artifactTools ? [createArtifactToolSource(artifactDeps)] : []),
    ...(options.issueTools ? [createIssueToolSource({ db, pubsub })] : []),
    ...(options.calendarTools ? [createCalendarToolSource({ db, pubsub })] : []),
    ...(options.skillTools ? [createSkillToolSource({ db, blobs: artifactDeps.blobs })] : []),
    ...(options.contextTools ? [createContextToolSource(context)] : []),
    ...(options.scheduleTools ? [createScheduleToolSource({ pubsub, context })] : []),
    ...(sandboxDeps
      ? [createSandboxToolSource({ ...sandboxDeps, artifacts: artifactDeps, skills: { blobs: artifactDeps.blobs } })]
      : []),
    ...(options.toolSources ?? []),
  ];
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
    storage,
    sandbox: sandboxDeps,
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
    platformBlobs,
    s3,
    storage,
    artifactDeps,
    sandboxDeps,
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;
