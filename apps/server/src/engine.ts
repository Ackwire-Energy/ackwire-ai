import type { Adapters, S3Fetch, SandboxProvider } from "@agenteschat/adapters";
import { type Config, connectorOAuthApps, githubAppConfig } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import {
  type ArtifactDeps,
  agentScopeFromDb,
  CodexBrain,
  type ContextDeps,
  createArtifactToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createCalendarToolSource,
  createChatToolSource,
  createClaudeCodeBrain,
  createConnectorToolSource,
  createContextToolSource,
  createForumToolSource,
  createGitToolSource,
  createIssueToolSource,
  createJevJudge,
  createJobHandlers,
  createLlmJudge,
  createMachineHub,
  createMissionHooks,
  createMissionRunToolSource,
  createMissionToolSource,
  createModelGateway,
  createReactToolSource,
  createSandboxToolSource,
  createScheduleToolSource,
  createSkillToolSource,
  createToolGateway,
  createWikiToolSource,
  type GitProxyDeps,
  hubBrainLink,
  type Judge,
  type McpConnect,
  missionAllowRules,
  missionBranchPrefix,
  missionOfThread,
  notifyOwnerOnBudget,
  queueBudgetEmail,
  type ResolveHost,
  type RunExecutorDeps,
  resolveSummaryModel,
  type SandboxDeps,
  type ScheduleReader,
  type StorageDeps,
  type ToolSource,
  withJudgeFallback,
} from "@agenteschat/engine";
import { createVoyageEmbeddings, type EmbeddingProvider, type ModelProvider } from "@agenteschat/providers";

export interface EngineOptions {
  db: Database;
  config: Config;
  adapters: Adapters;
  modelProviders: Record<string, ModelProvider>;
  /** Tests: extra tool sources, in-process MCP, fake HTTP, fake embeddings. */
  toolSources?: ToolSource[];
  mcpConnect?: McpConnect;
  http?: typeof fetch;
  embeddings?: { provider: EmbeddingProvider; apiKey: string };
  deltaFlushMs?: number;
  /** Latency measurements from runs (logged by the server). */
  onTiming?(name: string, ms: number, attrs: Record<string, unknown>): void;
  /** Tests: fake TypeSafe transport. */
  jevFetch?: typeof fetch;
  /** Tests: a fake judge (no model calls for "is this a stop?" and the like). */
  judge?: Judge;
  /** Tests: a fake schedule reader (no model calls for "toda segunda às 9h" and the like). */
  schedules?: ScheduleReader;
  /** Tests: fake S3 server and DNS for org buckets. */
  s3Fetch?: S3Fetch;
  resolveHost?: ResolveHost;
  /** Per-run stage breakdown (debug log). */
  onRunProfile?: RunExecutorDeps["onRunProfile"];
  /** Tests: a fake sandbox provider (default: the adapters' one, if any). */
  sandbox?: SandboxProvider | null;
  /** Tests: a fake GitHub (git smart HTTP and REST) for the git proxy and tools. */
  github?: { gitUrl: string; apiUrl: string; fetch: typeof fetch };
  /** Tests: this process's replica id for the machine hub (default: random). */
  replicaId?: string;
}

/**
 * Wires the engine the same way for the server and the tests: Model Gateway
 * (budgets, embeddings), Tool Gateway (connectors + context tools + extra
 * sources), context deps (summaries, reflection), and the job handlers.
 */
export function buildEngine(o: EngineOptions) {
  const { db, config, adapters } = o;
  const keyWrappers = [adapters.keyWrapper, ...adapters.legacyKeyWrappers];
  const embeddings =
    o.embeddings ??
    (config.EMBEDDINGS_PROVIDER === "voyage" && config.VOYAGE_API_KEY
      ? { provider: createVoyageEmbeddings({ model: config.EMBEDDING_MODEL }), apiKey: config.VOYAGE_API_KEY }
      : undefined);
  const gateway = createModelGateway({
    db,
    keyWrappers,
    providers: o.modelProviders,
    platformCredentials: adapters.platformCredentials,
    onBudgetThreshold: async (e) => {
      await notifyOwnerOnBudget(adapters.pubsub, db)(e);
      await queueBudgetEmail(db, config.PUBLIC_URL, e);
    },
    embeddings,
  });
  const context: ContextDeps = {
    db,
    gateway,
    search: adapters.search,
    summaryModel: config.SUMMARY_MODEL,
    cheapModels: { openai: config.OPENAI_CHEAP_MODEL },
    pubsub: adapters.pubsub,
    judge: o.judge,
    memoryJudgeOrgs: config.MEMORY_JUDGE_ORGS,
    schedules: o.schedules,
    reflect: {
      everyMessages: config.REFLECT_EVERY_MESSAGES,
      idleMinutes: config.REFLECT_IDLE_MINUTES,
      maxPerThread: config.REFLECT_MAX_PER_THREAD,
    },
  };
  // Semantic judgments (stop requests, hand-offs, permission changes): Jev when its platform key is
  // set, with the org's cheap model as fallback; the cheap model alone otherwise.
  if (!context.judge) {
    const llmJudge = createLlmJudge({ gateway, resolveModel: (orgId) => resolveSummaryModel(context, orgId) });
    context.judge = config.TYPESAFE_API_KEY
      ? withJudgeFallback(
          createJevJudge({
            apiKey: config.TYPESAFE_API_KEY,
            gateway,
            timeoutMs: config.JEV_TIMEOUT_MS,
            fetch: o.jevFetch,
          }),
          llmJudge,
        )
      : llmJudge;
  }
  const connectorDeps = {
    db,
    keyWrappers,
    oauthApps: connectorOAuthApps(config),
    publicUrl: config.PUBLIC_URL,
    http: o.http,
    connect: o.mcpConnect,
  };
  const storage: StorageDeps = {
    db,
    keyWrappers,
    platform: adapters.platformBlobs,
    fetch: o.s3Fetch,
    resolveHost: o.resolveHost,
  };
  const artifacts: ArtifactDeps = { db, blobs: createBlobStoreResolver(storage), pubsub: adapters.pubsub };
  // Code sandbox (D30): cloud computers only when a provider is configured (Daytona in the Cloud);
  // connected machines (ADR 0025) always, through the hub that holds their sockets.
  const sandboxProvider = o.sandbox !== undefined ? o.sandbox : (adapters.sandbox ?? null);
  const machineHub = createMachineHub({ db, pubsub: adapters.pubsub, replicaId: o.replicaId });
  const sandbox: SandboxDeps = {
    db,
    provider: sandboxProvider,
    machines: { hub: machineHub },
    pricing: {
      vcpuHourUsd: config.SANDBOX_PRICE_VCPU_HOUR_USD,
      memoryGibHourUsd: config.SANDBOX_PRICE_MEMORY_GIB_HOUR_USD,
      diskGibHourUsd: config.SANDBOX_PRICE_DISK_GIB_HOUR_USD,
    },
    autoStopMinutes: config.SANDBOX_AUTO_STOP_MINUTES,
    archiveAfterDays: config.SANDBOX_ARCHIVE_AFTER_DAYS,
    // Git through our proxy (D35): the computer never gets a GitHub token.
    git: { publicUrl: config.PUBLIC_URL, secret: config.AGENTES_SECRET },
    publicUrl: config.PUBLIC_URL,
  };
  // Missions (ADR 0029): their executors' MCP calls and reconnects come through the hub.
  const missionDeps = {
    pubsub: adapters.pubsub,
    hub: machineHub,
    artifacts,
    search: context,
    publicUrl: config.PUBLIC_URL,
    judge: context.judge,
  };
  const githubApp = githubAppConfig(config);
  const gitProxy: GitProxyDeps = {
    db,
    secret: config.AGENTES_SECRET,
    connectors: connectorDeps,
    upstream: o.github,
    app: githubApp,
  };
  const tools = createToolGateway({
    sources: [
      createAskUserToolSource(),
      createReactToolSource({ pubsub: adapters.pubsub }),
      createArtifactToolSource(artifacts),
      createChatToolSource({ pubsub: adapters.pubsub, artifacts }),
      createIssueToolSource({ db, pubsub: adapters.pubsub }),
      createSkillToolSource({ db, blobs: artifacts.blobs }),
      createCalendarToolSource({ db, pubsub: adapters.pubsub, publicUrl: config.PUBLIC_URL }),
      createScheduleToolSource({ pubsub: adapters.pubsub, context }),
      createForumToolSource({ pubsub: adapters.pubsub, artifacts }),
      createWikiToolSource({ pubsub: adapters.pubsub, search: context, artifacts }),
      createContextToolSource(context),
      createConnectorToolSource(connectorDeps),
      createMissionToolSource(missionDeps),
      // Computer-brain runs only (calls through the runner bridge): before the sandbox tools, so these
      // win a name clash (`start_task`) there.
      createMissionRunToolSource(missionDeps),
      createSandboxToolSource({
        ...sandbox,
        artifacts,
        skills: { blobs: artifacts.blobs },
        pubsub: adapters.pubsub,
      }),
      // Git through our proxy needs cloud computers (we never set up git on a person's machine).
      ...(sandboxProvider
        ? [
            createGitToolSource({
              sandbox,
              connectors: connectorDeps,
              app: githubApp,
              github: o.github ? { apiUrl: o.github.apiUrl, fetch: o.github.fetch } : undefined,
            }),
          ]
        : []),
      ...(o.toolSources ?? []),
    ],
  });
  // Mission tasks' tools and computer-brain runs' tools come through the hub's MCP bridge (ADR 0032).
  machineHub.setMissionHooks(createMissionHooks({ db, ...missionDeps, tools }));
  // Computer brains (ADR 0032): Claude Code and Codex on the agent's computer, through the hub. Each turn's
  // run tool token (issued by the engine) goes in `brain.turn.mcp.token`, so the runner bridge maps calls to the run.
  const agentScope = agentScopeFromDb(db);
  const brainLink = hubBrainLink({ hub: machineHub, pubsub: adapters.pubsub });
  /** A mission run's command policy (plan before Start, work after; its branches and allowed commands). */
  const missionPermissions = async (turn: { orgId: string; agentId: string; threadRootId: string | null }) => {
    if (!turn.threadRootId) return undefined;
    const mission = await missionOfThread(db, turn.orgId, turn.threadRootId).catch(() => null);
    if (!mission || mission.agentId !== turn.agentId) return undefined;
    return {
      mode: mission.status === "proposed" ? ("plan" as const) : ("work" as const),
      branchPrefix: missionBranchPrefix(mission.id),
      allow: await missionAllowRules(db, mission.id),
    };
  };
  const brains: RunExecutorDeps["brains"] = {
    claude_code: (_agent, _run, setup) =>
      createClaudeCodeBrain({
        hub: machineHub,
        pubsub: adapters.pubsub,
        agentScope,
        mcpToken: () => setup.mcpToken(),
        permissions: missionPermissions,
      }),
    codex: (_agent, _run, setup) =>
      new CodexBrain({ link: brainLink, mcp: async () => ({ token: setup.mcpToken() }), agent: agentScope }),
  };
  const handlers = createJobHandlers({
    db,
    gateway,
    pubsub: adapters.pubsub,
    tools,
    context,
    search: adapters.search,
    email: adapters.email,
    storage,
    artifacts,
    sandbox,
    maxToolTurns: config.AGENT_MAX_TOOL_TURNS,
    brains,
    machines: machineHub,
    maxOutputTokens: config.AGENT_MAX_OUTPUT_TOKENS,
    contextMessages: config.AGENT_CONTEXT_MESSAGES,
    maxHops: config.AGENT_MAX_HOPS,
    deltaFlushMs: o.deltaFlushMs,
    onTiming: o.onTiming,
    onRunProfile: o.onRunProfile,
    router: {
      enabled: config.ROUTER_ENABLED,
      model: config.ROUTER_MODEL,
      cheapModels: { openai: config.OPENAI_CHEAP_MODEL },
      minScore: config.ROUTER_MIN_SCORE,
      mentionThreshold: config.ROUTER_MENTION_THRESHOLD,
      // Jev is the default when its (platform) key is set, unless ROUTER_STRATEGY=llm.
      ...(config.TYPESAFE_API_KEY && (config.ROUTER_STRATEGY ?? "jev") === "jev"
        ? { jev: { apiKey: config.TYPESAFE_API_KEY, timeoutMs: config.JEV_TIMEOUT_MS, fetch: o.jevFetch } }
        : {}),
    },
  });
  return { gateway, tools, context, handlers, connectorDeps, storage, artifacts, sandbox, gitProxy, machineHub };
}

export type Engine = ReturnType<typeof buildEngine>;
