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
import { type Database, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createFakeEmbeddings, createFakeProvider, type FakeProvider } from "@agenteschat/providers/testing";
import {
  type ArtifactDeps,
  addChannelMember,
  type ContextDeps,
  createAgent,
  createArtifactToolSource,
  createAskAgentToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createCalendarToolSource,
  createChatToolSource,
  createContextToolSource,
  createCredential,
  createFakeJudge,
  createFakeScheduleReader,
  createFindAgentToolSource,
  createForumToolSource,
  createIssueToolSource,
  createJobHandlers,
  createLocalKeyWrapper,
  createMachineHub,
  createMissionHooks,
  createMissionToolSource,
  createModelGateway,
  createOrganization,
  createPermissionToolSource,
  createReactToolSource,
  createSandboxToolSource,
  createScheduleToolSource,
  createSkillToolSource,
  createToolGateway,
  createWikiToolSource,
  type FakeScheduleAnswer,
  type FakeScheduleAnswers,
  localDateTimeOf,
  type MemberRole,
  type SandboxDeps,
  type StorageDeps,
  type ToolSource,
  zonedParts,
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

const WORKDAYS = ["MO", "TU", "WE", "TH", "FR"];
/** "YYYY-MM-DDTHH:mm" `days` after today at `time`, in the question's zone (date math, not language). */
const dayAt =
  (days: number, time: string) =>
  ({ timezone, now }: { timezone: string; now: Date }): FakeScheduleAnswer => {
    const p = zonedParts(now, timezone);
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return { at: `${d.toISOString().slice(0, 10)}T${time}` };
  };
/** `minutes` from now, in the question's zone. */
const inMinutes =
  (minutes: number) =>
  ({ timezone, now }: { timezone: string; now: Date }): FakeScheduleAnswer => ({
    at: localDateTimeOf(new Date(now.getTime() + minutes * 60_000), timezone),
  });

/**
 * What the fake schedule reader answers for the phrases these tests write:
 * a lookup table standing in for the model, not a parser.
 */
export const TEST_SCHEDULES: FakeScheduleAnswers = {
  "todo dia às 8h": { rule: { freq: "daily", times: ["08:00"] } },
  "todo dia às 9h": { rule: { freq: "daily", times: ["09:00"] } },
  "todo dia às 18h": { rule: { freq: "daily", times: ["18:00"] } },
  "dias úteis às 9h": { rule: { freq: "weekly", byWeekday: WORKDAYS, times: ["09:00"] } },
  "toda segunda às 9h": { rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"] } },
  "toda segunda às 10h": { rule: { freq: "weekly", byWeekday: ["MO"], times: ["10:00"] } },
  "toda sexta às 17h": { rule: { freq: "weekly", byWeekday: ["FR"], times: ["17:00"] } },
  "a cada hora": { rule: { freq: "hourly", times: ["00:00"] } },
  "amanhã às 9h": dayAt(1, "09:00"),
  "amanhã às 10h": dayAt(1, "10:00"),
  "em 2 horas": inMinutes(120),
  amanhã: { error: "time_missing" },
};

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
    /** Add the built-in `request_permission` tool. */
    permissionTools?: boolean;
    /** Add the built-in `ask_agent` tool. */
    askAgent?: boolean;
    /** Add the built-in `react` tool. */
    react?: boolean;
    /** Add the Drive tools (create_artifact…). Storage is always wired (memory platform store, fake S3). */
    artifactTools?: boolean;
    chatTools?: boolean;
    /** Add the issue tools (create_issue, comment_issue…). */
    issueTools?: boolean;
    /** Add the calendar tools (list_events, find_free_time, propose_event). */
    calendarTools?: boolean;
    /** Add the skill tools (load_skill, read_skill_file). */
    skillTools?: boolean;
    /** Fake embeddings (hybrid search). Off: full-text only, no embedding usage rows. */
    embeddings?: boolean;
    /** Add the forum tools (open_forum_topic, post_in_forum, read_forum_topic). */
    forumTools?: boolean;
    /** Add the scheduling tools (schedule_reminder, create_routine…). */
    scheduleTools?: boolean;
    /** Add the wiki tools (search_wiki, read_wiki_page, create_wiki_page…). */
    wikiTools?: boolean;
    /** Add the sandbox tools with this (fake) provider. */
    sandbox?: SandboxProvider;
    /** Add the sandbox tools with connected machines (a machine hub on this db; with or without `sandbox`). */
    machines?: boolean;
    /** With `machines`: the mission tools (propose_mission and, in a mission thread, its tools). The hub's mission hooks are always set. */
    missionTools?: boolean;
    /** Answers of the fake judge (judge.ts): by judgment kind and question id. Default: every Noul 0. */
    judge?: Parameters<typeof createFakeJudge>[0];
    /** The fake schedule reader's table (phrase → answer), on top of `TEST_SCHEDULES`. */
    schedules?: FakeScheduleAnswers;
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
  // New agents get their computer by default (D61); tests that use it grant it themselves.
  await db
    .delete(schema.agentScopes)
    .where(
      sql`${schema.agentScopes.agentId} = ${agent.id} and ${schema.agentScopes.scope} in ('sandbox:run', 'browser:use')`,
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
    judge: createFakeJudge(options.judge),
    schedules: createFakeScheduleReader({ ...TEST_SCHEDULES, ...options.schedules }),
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
  const machineHub = options.machines ? createMachineHub({ db, pubsub, replicaId: "replica-a" }) : null;
  const sandboxDeps: SandboxDeps | null =
    options.sandbox || machineHub
      ? {
          db,
          provider: options.sandbox ?? null,
          machines: machineHub ? { hub: machineHub } : null,
          pricing: { vcpuHourUsd: 0.0504, memoryGibHourUsd: 0.0162, diskGibHourUsd: 0.000108 },
          autoStopMinutes: 10,
          archiveAfterDays: 7,
          ...(machineHub ? { publicUrl: "http://localhost:3000" } : {}),
        }
      : null;
  const missionDeps = {
    pubsub,
    hub: machineHub,
    artifacts: artifactDeps,
    search: context,
    publicUrl: "http://localhost:3000",
    judge: context.judge,
  };
  const sources = [
    ...(options.missionTools && machineHub ? [createMissionToolSource(missionDeps)] : []),
    ...(options.askUser ? [createAskUserToolSource()] : []),
    ...(options.permissionTools ? [createPermissionToolSource()] : []),
    ...(options.askAgent ? [createAskAgentToolSource({ pubsub }), createFindAgentToolSource()] : []),
    ...(options.react ? [createReactToolSource({ pubsub })] : []),
    ...(options.artifactTools ? [createArtifactToolSource(artifactDeps)] : []),
    ...(options.chatTools ? [createChatToolSource({ pubsub, artifacts: artifactDeps })] : []),
    ...(options.issueTools ? [createIssueToolSource({ db, pubsub })] : []),
    ...(options.calendarTools ? [createCalendarToolSource({ db, pubsub })] : []),
    ...(options.skillTools ? [createSkillToolSource({ db, blobs: artifactDeps.blobs })] : []),
    ...(options.contextTools ? [createContextToolSource(context)] : []),
    ...(options.scheduleTools ? [createScheduleToolSource({ pubsub, context })] : []),
    ...(options.forumTools ? [createForumToolSource({ pubsub, artifacts: artifactDeps })] : []),
    ...(options.wikiTools ? [createWikiToolSource({ pubsub, search: context, artifacts: artifactDeps })] : []),
    ...(sandboxDeps
      ? [
          createSandboxToolSource({
            ...sandboxDeps,
            artifacts: artifactDeps,
            skills: { blobs: artifactDeps.blobs },
            pubsub,
          }),
        ]
      : []),
    ...(options.toolSources ?? []),
  ];
  const tools = sources.length > 0 ? createToolGateway({ sources }) : undefined;
  machineHub?.setMissionHooks(createMissionHooks({ db, ...missionDeps, tools }));
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
    artifacts: artifactDeps,
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
    machineHub,
    missionDeps: { db, ...missionDeps },
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;
