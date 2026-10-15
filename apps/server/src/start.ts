import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Adapters,
  createDaytonaSandboxProvider,
  createLogEmailSender,
  createMemoryPresence,
  createMemoryRateLimiter,
  createMillionSendSender,
  createPostgresBlobStore,
  createPostgresPubSub,
  createPostgresSearchResolver,
  createS3BlobStore,
  envPlatformCredentials,
  postgresJsNotifier,
} from "@agenteschat/adapters";
import { type Config, ConfigError, loadConfig, redactConfig } from "@agenteschat/config";
import { createDatabase, type Database, ensureMessagePartitions, MigrationMismatchError } from "@agenteschat/db";
import { createLocalKeyWrapper, drainLocalRuns, enableCaches } from "@agenteschat/engine";

import { type AgentesModule, type Edition, type ModuleContext, resolveAdapters } from "@agenteschat/modules";
import { createAnthropicProvider, createOpenAIProvider } from "@agenteschat/providers";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { buildEngine } from "./engine";
import { createLogger } from "./logger";
import { createRealtime, type SocketData } from "./realtime/ws";
import { version } from "./version";
import { startWorkers } from "./workers";

/** On SIGTERM, how long runs in progress get to finish before they are handed to the next instance. */
const RUN_DRAIN_MS = 20_000;

export interface StartOptions {
  edition: Edition;
  modules?: AgentesModule[];
}

/**
 * Boots an agentes.chat server: config → database → migrations → adapters
 * (core defaults, then module overrides) → HTTP + WebSocket → workers.
 * Shared by the self-hosted entrypoint (`src/main.ts`) and the Cloud
 * entrypoint in the private `agentes-chat-cloud` repo; only `modules` differ.
 */
export async function startServer({ edition, modules = [] }: StartOptions) {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}\n\nCopy .env.example to .env and fill in the required values.`);
      process.exit(1);
    }
    throw error;
  }

  const log = createLogger(config.LOG_LEVEL);
  log.info("starting agentes.chat", { version, edition, config: redactConfig(config) });

  const database = createDatabase({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX });
  if (config.RUN_MIGRATIONS_ON_BOOT) {
    log.info("applying database migrations");
    try {
      await database.migrate();
    } catch (error) {
      if (error instanceof MigrationMismatchError) {
        // Never re-run or skip a changed migration against a real database.
        log.error("refusing to migrate: the database's migrations don't match this build", { reason: error.message });
        process.exit(1);
      }
      throw error;
    }
  }
  await ensureMessagePartitions(database.db);

  const defaults: Adapters = {
    search: createPostgresSearchResolver(database.db),
    pubsub: await createPostgresPubSub(postgresJsNotifier(database.client)),
    presence: createMemoryPresence(),
    rateLimiter: createMemoryRateLimiter(),
    keyWrapper: createLocalKeyWrapper(config.AGENTES_SECRET),
    legacyKeyWrappers: [],
    email: config.MILLIONSEND_API_KEY
      ? createMillionSendSender({
          apiKey: config.MILLIONSEND_API_KEY,
          from: config.EMAIL_FROM,
          replyTo: config.EMAIL_REPLY_TO,
        })
      : createLogEmailSender((line, data) => log.info(line, data)),
    platformCredentials: envPlatformCredentials({
      anthropic: { apiKey: config.PLATFORM_ANTHROPIC_API_KEY, workspaceId: config.PLATFORM_ANTHROPIC_WORKSPACE_ID },
    }),
    platformBlobs: platformBlobStore(config, database.db),
    sandbox: config.DAYTONA_API_KEY
      ? createDaytonaSandboxProvider({
          apiKey: config.DAYTONA_API_KEY,
          apiUrl: config.DAYTONA_API_URL,
          target: config.DAYTONA_TARGET,
          snapshot: config.SANDBOX_SNAPSHOT,
        })
      : null,
  };
  log.info("platform file storage", { kind: defaults.platformBlobs.kind });
  log.info("code sandbox", { provider: defaults.sandbox?.id ?? "off" });
  const base = { config, db: database.db, edition, version };
  const { adapters, modelProviders, overridden } = await resolveAdapters(modules, base, defaults, {
    anthropic: createAnthropicProvider(),
    openai: createOpenAIProvider(),
  });
  if (overridden.length > 0) log.info("adapters overridden by modules", { overridden });
  const ctx: ModuleContext = { ...base, adapters };

  // Per-process caches for agent/org/channel config, scopes, connections, credential rows (30 s TTL).
  enableCaches();
  const engine = buildEngine({
    db: database.db,
    config,
    adapters,
    modelProviders,
    onTiming: (name, ms, attrs) => log.info("latency", { metric: name, ms, ...attrs }),
    onRunProfile: (p) => log.debug("run profile", p),
  });
  const workers = startWorkers({
    db: database.db,
    handlers: engine.handlers,
    pubsub: adapters.pubsub,
    context: engine.context,
    artifacts: engine.artifacts,
    approvalDigest: { publicUrl: config.PUBLIC_URL, afterHours: config.APPROVAL_REMINDER_HOURS },
    log,
  });

  const auth = createAuth({ db: database.db, config, log, emailDelivers: adapters.email.delivers });
  const webDir = resolve(config.WEB_DIR);
  const app = createApp({
    edition,
    version,
    modules,
    moduleContext: ctx,
    services: {
      db: database.db,
      auth,
      config,
      adapters,
      wakeWorkers: workers.wakeAll,
      extras: {
        embed: engine.gateway.embed,
        storage: engine.storage,
        artifacts: engine.artifacts,
        context: engine.context,
        sandbox: engine.sandbox,
        gitProxy: engine.sandbox ? engine.gitProxy : undefined,
      },
    },
    log,
    pingDatabase: database.ping,
    webDir: existsSync(webDir) ? webDir : undefined,
  });
  if (!existsSync(webDir)) log.warn("web app not found; serving API only", { webDir });

  const realtime = createRealtime({ db: database.db, auth, config, log, ...adapters });
  const server = Bun.serve<SocketData>({
    hostname: config.HOST,
    port: config.PORT,
    fetch: (req, srv) => (new URL(req.url).pathname === realtime.path ? realtime.upgrade(req, srv) : app.fetch(req)),
    websocket: realtime.websocket,
  });
  log.info("listening", { url: `http://${config.HOST}:${config.PORT}` });

  for (const module of modules) await module.onStart?.(ctx);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    // No new jobs; HTTP stops taking requests (the new deploy serves them).
    workers.stop();
    await server.stop();
    // Runs in progress get up to 20 s to finish; the rest are checkpointed and resume on the next instance.
    const interrupted = await drainLocalRuns(RUN_DRAIN_MS);
    if (interrupted.length > 0) log.info("runs handed back for the next instance", { runs: interrupted });
    for (const module of modules) await module.onStop?.();
    await adapters.pubsub.close?.();
    await database.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { server, config };
}

/** Our bucket (S3_*) when configured, else Postgres. */
function platformBlobStore(config: Config, db: Database) {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = config;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return createPostgresBlobStore(db);
  return createS3BlobStore({
    endpoint: S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    pathStyle: false,
  });
}
