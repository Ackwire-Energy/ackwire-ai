import type { Adapters, BrainTurnRequest, S3Fetch, SandboxProvider } from "@agenteschat/adapters";
import { type Config, connectorOAuthApps, githubAppConfig } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import {
  type ArtifactDeps,
  agentScopeFromDb,
  authorizeStream,
  type BrainTurn,
  CodexBrain,
  type ContextDeps,
  computerTurnProfile,
  createArtifactToolSource,
  createAskAgentToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createBrowserHandoffToolSource,
  createBrowserLive,
  createBrowserToolSource,
  createCalendarToolSource,
  createChatToolSource,
  createClaudeCodeBrain,
  createConnectorToolSource,
  createContextToolSource,
  createDatabaseToolSource,
  createDesktopControl,
  createDesktopToolSource,
  createFindAgentToolSource,
  createForumToolSource,
  createGitToolSource,
  createHandOffToolSource,
  createIssueToolSource,
  createJevJudge,
  createJobHandlers,
  createLlmJudge,
  createMachineHub,
  createMailToolSource,
  createMissionHooks,
  createMissionRunToolSource,
  createMissionToolSource,
  createModelGateway,
  createPassToolSource,
  createPermissionToolSource,
  createReactToolSource,
  createSandboxToolSource,
  createScheduleToolSource,
  createSkillToolSource,
  createStreamBroker,
  createTalker,
  createToolGateway,
  createWikiToolSource,
  createWorkspaceToolSource,
  type GitProxyDeps,
  hubBrainLink,
  type Judge,
  type MailDeps,
  type McpConnect,
  missionTurnPermissions,
  notifyOwnerOnBudget,
  prepareAgentCode,
  queueBudgetEmail,
  type ResolveHost,
  type RunExecutorDeps,
  recheckStream,
  resolveSummaryModel,
  type SandboxDeps,
  type ScheduleReader,
  type StorageDeps,
  standingJudge,
  streamClosed,
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
  /** Tools on demand (ADR 0043; default on). Tests turn it off: every granted tool is listed. */
  toolsOnDemand?: boolean;
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
            visionModel: config.JEV_VISION_MODEL,
            fetch: o.jevFetch,
          }),
          llmJudge,
        )
      : llmJudge;
  }
  // Nothing is judged for a workspace on hold or suspended: Jev bills the server, not the workspace.
  context.judge = standingJudge(db, context.judge);
  // The agents' conversation layer: a fast reply on the org's cheap model while a task works or waits.
  const talker = createTalker({
    db,
    pubsub: adapters.pubsub,
    gateway,
    resolveModel: (orgId) => resolveSummaryModel(context, orgId),
  });
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
  // Code sandbox (ADR 0021): cloud computers only when a provider is configured (Daytona in the Cloud);
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
    // Git through our proxy (ADR 0024): the computer never gets a GitHub token.
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
      // Missing something a request needs: ask for it (an approval card) instead of failing.
      createPermissionToolSource(),
      // The agent browser asks a person for help (ADR 0040 §6).
      createBrowserHandoffToolSource({ pubsub: adapters.pubsub, machines: { hub: machineHub } }),
      createAskAgentToolSource({ pubsub: adapters.pubsub }),
      createFindAgentToolSource(),
      createReactToolSource({ pubsub: adapters.pubsub }),
      // Background runs (routines) speak only through it.
      createHandOffToolSource({ pubsub: adapters.pubsub }),
      // Runs nobody called by name may stay quiet (reply-policy.ts): listed only for them.
      createPassToolSource(),
      createArtifactToolSource(artifacts),
      createChatToolSource({ pubsub: adapters.pubsub, artifacts }),
      createWorkspaceToolSource({ pubsub: adapters.pubsub }),
      createIssueToolSource({ db, pubsub: adapters.pubsub }),
      createSkillToolSource({ db, blobs: artifacts.blobs }),
      createCalendarToolSource({ db, pubsub: adapters.pubsub, publicUrl: config.PUBLIC_URL }),
      createScheduleToolSource({ pubsub: adapters.pubsub, context, mail: adapters.mail }),
      createForumToolSource({ pubsub: adapters.pubsub, artifacts }),
      createWikiToolSource({ pubsub: adapters.pubsub, search: context, artifacts }),
      createContextToolSource(context),
      createConnectorToolSource(connectorDeps),
      // People's mailboxes (ADR 0038): only when the server has a mail path (Composio, IMAP).
      createMailToolSource({
        keyWrappers,
        mail: adapters.mail,
        publicUrl: config.PUBLIC_URL,
        resolveHost: o.resolveHost,
        artifacts,
      }),
      // People's Postgres databases (ADR 0039): read-only queries, when the server has a driver.
      createDatabaseToolSource({ keyWrappers, databases: adapters.databases, resolveHost: o.resolveHost }),
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
      // The agent's own browser on its connected computer (ADR 0040): `browser:use`, when the machine serves it.
      // Targets in words, checks and finds go to the judge (ADR 0054); screenshots only to Jev's vision model.
      createBrowserToolSource({
        machines: { hub: machineHub },
        pubsub: adapters.pubsub,
        judge: context.judge,
        vision: Boolean(config.TYPESAFE_API_KEY) && !o.judge,
      }),
      // The agent's own desktop (ADR 0060): `desktop:use` with Run code, when its computer serves desktop use.
      createDesktopToolSource({
        machines: { hub: machineHub },
        pubsub: adapters.pubsub,
        judge: context.judge,
        vision: Boolean(config.TYPESAFE_API_KEY) && !o.judge,
      }),
      // Git through our proxy: cloud computers, and connected machines through the runner's `git.sync`
      // (only our credential reaches the machine; nothing global changes there).
      createGitToolSource({
        sandbox,
        connectors: connectorDeps,
        app: githubApp,
        github: o.github ? { apiUrl: o.github.apiUrl, fetch: o.github.fetch } : undefined,
        pubsub: adapters.pubsub,
      }),
      ...(o.toolSources ?? []),
    ],
  });
  // Mission tasks' tools and computer-brain runs' tools come through the hub's MCP bridge (ADR 0032).
  machineHub.setMissionHooks(createMissionHooks({ db, ...missionDeps, tools }));
  // The agent browser's live view (ADR 0040 §7): the runner's frames go to viewers in memory.
  const browserLive = createBrowserLive({ db, pubsub: adapters.pubsub, hub: machineHub });
  machineHub.setBrowserHooks(browserLive.hubHooks);
  // Agents' desktops and terminals (ADR 0058): each person's stream paired with the runner's data socket for it,
  // its access checked again while open; control changing hands closes the views it hides.
  const streams = createStreamBroker({
    db,
    hub: machineHub,
    authorize: (input) => authorizeStream({ db, hub: machineHub, rateLimiter: adapters.rateLimiter }, input),
    recheck: (stream) => recheckStream(db, stream),
    onClosed: (stream) => streamClosed(db, stream),
  });
  const desktops = createDesktopControl({ db, pubsub: adapters.pubsub, hub: machineHub, streams });
  // Computer brains (ADR 0032): Claude Code and Codex on the agent's computer, through the hub. Each turn's
  // run tool token (issued by the engine) goes in `brain.turn.mcp.token`, so the runner bridge maps calls to the run.
  const agentScope = agentScopeFromDb(db);
  const brainLink = hubBrainLink({ hub: machineHub, pubsub: adapters.pubsub });
  /**
   * A computer turn's permission profile (ADR 0053 §3), the same for Claude Code and Codex: a mission run
   * keeps its own (plan before Start, while a write item is live and for a run news from a routine or
   * another agent woke there, work otherwise; ADR 0044); any other
   * run follows who is behind it, read again every turn (`computerTurnProfile`: `plan` for a routine that
   * only reads and for unattended runs, `work` for an `act` routine and a person's run). Its own branches
   * are agentes/<handle>/… (what the git proxy accepts).
   */
  const turnPermissions = async (turn: BrainTurn): Promise<BrainTurnRequest["permissions"]> =>
    (await missionTurnPermissions(db, turn)) ?? {
      mode: await computerTurnProfile(db, turn),
      branchPrefix: `agentes/${(await agentScope(turn)).handle}/`,
    };
  // Before a chat turn on a connected machine: the agent's checkouts updated through the git proxy, the turn
  // started in the repository it is about, and the "# Your code" block (ADR 0024 addendum).
  const prepareCode = (turn: Parameters<typeof prepareAgentCode>[1], signal: AbortSignal) =>
    prepareAgentCode(
      { db, hub: machineHub, git: { publicUrl: config.PUBLIC_URL, secret: config.AGENTES_SECRET } },
      turn,
      {
        signal,
      },
    );
  // A background run (a routine's) keeps no computer process alive after its turn.
  const brains: RunExecutorDeps["brains"] = {
    claude_code: (_agent, run, setup) =>
      createClaudeCodeBrain({
        hub: machineHub,
        pubsub: adapters.pubsub,
        agentScope,
        mcpToken: () => setup.mcpToken(),
        permissions: turnPermissions,
        keepAlive: !run.background,
        prepare: prepareCode,
      }),
    codex: (_agent, run, setup) =>
      new CodexBrain({
        link: brainLink,
        mcp: async () => ({ token: setup.mcpToken() }),
        agent: agentScope,
        permissions: turnPermissions,
        keepAlive: !run.background,
        prepare: prepareCode,
      }),
  };
  const handlers = createJobHandlers({
    db,
    gateway,
    pubsub: adapters.pubsub,
    tools,
    context,
    search: adapters.search,
    email: adapters.email,
    push: adapters.push,
    storage,
    artifacts,
    sandbox,
    maxToolTurns: config.AGENT_MAX_TOOL_TURNS,
    // Tools on demand (ADR 0043): each run lists what the judge expects it to need; the rest behind `find_tools`.
    toolsOnDemand: o.toolsOnDemand ?? true,
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
  // Mail accounts, inbound mail and polling (routes and workers).
  const mail: MailDeps = {
    db,
    keyWrappers,
    mail: adapters.mail,
    publicUrl: config.PUBLIC_URL,
    resolveHost: o.resolveHost,
  };
  return {
    gateway,
    tools,
    context,
    handlers,
    connectorDeps,
    storage,
    artifacts,
    sandbox,
    gitProxy,
    machineHub,
    browserLive,
    streams,
    desktops,
    mail,
    talker,
  };
}

export type Engine = ReturnType<typeof buildEngine>;
