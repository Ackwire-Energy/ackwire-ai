import type { Adapters, S3Fetch } from "@agenteschat/adapters";
import { type Config, connectorOAuthApps } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import {
  type ArtifactDeps,
  type ContextDeps,
  createArtifactToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createCalendarToolSource,
  createConnectorToolSource,
  createContextToolSource,
  createIssueToolSource,
  createJobHandlers,
  createModelGateway,
  createToolGateway,
  type McpConnect,
  notifyOwnerOnBudget,
  queueBudgetEmail,
  type ResolveHost,
  type RunExecutorDeps,
  type StorageDeps,
  type ToolSource,
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
  /** Tests: fake S3 server and DNS for org buckets. */
  s3Fetch?: S3Fetch;
  resolveHost?: ResolveHost;
  /** Per-run stage breakdown (debug log). */
  onRunProfile?: RunExecutorDeps["onRunProfile"];
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
    reflect: {
      everyMessages: config.REFLECT_EVERY_MESSAGES,
      idleMinutes: config.REFLECT_IDLE_MINUTES,
      maxPerThread: config.REFLECT_MAX_PER_THREAD,
    },
  };
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
  const tools = createToolGateway({
    sources: [
      createAskUserToolSource(),
      createArtifactToolSource(artifacts),
      createIssueToolSource({ db, pubsub: adapters.pubsub }),
      createCalendarToolSource({ db, pubsub: adapters.pubsub, publicUrl: config.PUBLIC_URL }),
      createContextToolSource(context),
      createConnectorToolSource(connectorDeps),
      ...(o.toolSources ?? []),
    ],
  });
  const handlers = createJobHandlers({
    db,
    gateway,
    pubsub: adapters.pubsub,
    tools,
    context,
    search: adapters.search,
    email: adapters.email,
    storage,
    maxToolTurns: config.AGENT_MAX_TOOL_TURNS,
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
  return { gateway, tools, context, handlers, connectorDeps, storage, artifacts };
}

export type Engine = ReturnType<typeof buildEngine>;
