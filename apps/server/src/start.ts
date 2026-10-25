import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Adapters,
  createComposioClient,
  createComposioMailConnector,
  createDaytonaSandboxProvider,
  createDiskBlobStore,
  createExpoPushSender,
  createImapConnectionTester,
  createImapMailConnector,
  createImapPoller,
  createLogEmailSender,
  createMemoryPresence,
  createMemoryRateLimiter,
  createMillionSendSender,
  createPostgresBlobStore,
  createPostgresDatabaseDriver,
  createPostgresPubSub,
  createPostgresSearchResolver,
  createS3BlobStore,
  createSmtpEmailSender,
  type EmailSender,
  envPlatformCredentials,
  MAIL_PRESETS,
  type MailAdapters,
  postgresJsNotifier,
} from "@agenteschat/adapters";
import { type Config, ConfigError, loadConfig, redactConfig } from "@agenteschat/config";
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
  ensureMessagePartitions,
  MigrationMismatchError,
} from "@agenteschat/db";
import {
  adoptRestoredOperatorEvents,
  createLocalKeyWrapper,
  drainLocalRuns,
  enableCaches,
  enableOperatorEvents,
  isBlockedAddress,
  resolveHostDns,
  retireHostTokens,
} from "@agenteschat/engine";

import { type AgentesModule, type Edition, type ModuleContext, resolveAdapters } from "@agenteschat/modules";
import { createModelProviders } from "@agenteschat/providers";
import { createApp } from "./app";
import { appleTokenRevoker, createAuth } from "./auth";
import { buildEngine } from "./engine";
import { createLogger, type Logger } from "./logger";
import { OPERATOR_API_PREFIX, serveOperatorApi } from "./operator/app";
import { createMachineSockets } from "./realtime/machines";
import { createStreamSockets } from "./realtime/streams";
import { createRealtime, type SocketData } from "./realtime/ws";
import { startTelemetry } from "./telemetry";
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
 * Shared by the self-hosted entrypoint (`src/main.ts`) and any entrypoint
 * that adds public modules (ADR 0002); only `modules` differ.
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
  if (config.NODE_ENV === "production" && config.PUBLIC_URL === "http://localhost:3000") {
    log.warn(
      "PUBLIC_URL is http://localhost:3000 (the default): only a browser on this machine, at exactly that address, can sign in and save. Set PUBLIC_URL to the address people open (e.g. https://chat.example.com): sign-in cookies, the browser origin allowed to make changes (CSRF) and the links in emails all come from it, so from any other address sign-in and saving fail with bad_origin.",
    );
  }

  const database = createDatabase({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX });
  await prepareDatabase(database, log, config.RUN_MIGRATIONS_ON_BOOT);
  // Best effort: a replica that boots before the migrations ran (RUN_MIGRATIONS_ON_BOOT=false) still starts.
  await retireHostTokens(database.db, config.HOST_COMPUTER_TOKEN).then(
    (retired) =>
      retired > 0 && log.info("this server's computer: tokens of an earlier HOST_COMPUTER_TOKEN retired", { retired }),
    (error: unknown) => log.warn("couldn't check this server's computer's tokens", { error: String(error) }),
  );

  const defaults: Adapters = {
    search: createPostgresSearchResolver(database.db),
    pubsub: await createPostgresPubSub(postgresJsNotifier(database.client)),
    presence: createMemoryPresence(),
    rateLimiter: createMemoryRateLimiter(),
    keyWrapper: createLocalKeyWrapper(config.AGENTES_SECRET),
    legacyKeyWrappers: [],
    email: emailSender(config, log),
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
    // Phone app push (ADR 0035): only devices that registered get anything.
    push: createExpoPushSender({ accessToken: config.EXPO_ACCESS_TOKEN }),
    mail: mailAdapters(config),
    // People's Postgres databases for agents (ADR 0039): always on; every connection is checked and read-only.
    databases: createPostgresDatabaseDriver(),
  };
  log.info("platform file storage", { kind: defaults.platformBlobs.kind });
  log.info("transactional email", { sender: defaults.email.id });
  log.info("code sandbox", { provider: defaults.sandbox?.id ?? "off" });
  log.info("mail for agents", { composio: Boolean(defaults.mail?.composio), imap: Boolean(defaults.mail?.imap) });
  const base = { config, db: database.db, edition, version };
  const { adapters, modelProviders, overridden } = await resolveAdapters(
    modules,
    base,
    defaults,
    createModelProviders(),
  );
  if (overridden.length > 0) log.info("adapters overridden by modules", { overridden });
  const ctx: ModuleContext = { ...base, adapters };

  // Per-process caches for agent/org/channel config, scopes, connections, credential rows (30 s TTL).
  enableCaches();
  // The operator API's events feed records only while that API is on (ADR 0056).
  if (config.OPERATOR_API_TOKEN) {
    enableOperatorEvents();
    // Before the API serves a page: a caller restarting after a restore must find these rows first.
    const adopted = await adoptRestoredOperatorEvents(database.db);
    if (adopted > 0) log.info("operator events from a restored dump moved to the front of the feed", { adopted });
  }
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
    mail: { deps: engine.mail, pollSeconds: config.MAIL_POLL_SECONDS },
    browserLive: engine.browserLive,
    desktops: engine.desktops,
    log,
  });
  const telemetry = startTelemetry({ db: database.db, config, log });

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
        browserLive: engine.browserLive,
        streams: engine.streams,
        talker: engine.talker,
        router: engine.router,
        gitProxy: engine.sandbox.provider ? engine.gitProxy : undefined,
        appleRevoke: appleTokenRevoker(config),
      },
    },
    log,
    pingDatabase: database.ping,
    webDir: existsSync(webDir) ? webDir : undefined,
  });
  if (!existsSync(webDir)) log.warn("web app not found; serving API only", { webDir });

  const realtime = createRealtime({
    db: database.db,
    auth,
    config,
    log,
    ...adapters,
    machines: createMachineSockets(engine.machineHub),
    browserLive: engine.browserLive,
    streams: createStreamSockets({ db: database.db, auth, config, broker: engine.streams }),
  });
  const server = Bun.serve<SocketData>({
    hostname: config.HOST,
    port: config.PORT,
    // Bun's default (10 s) cuts a request still waiting on its answer: opening a site in an agent's
    // browser waits for the page, and a closed browser starts first (up to 90 s on the computer).
    idleTimeout: 120,
    fetch: (req, srv) => realtime.fetch(req, srv, (r) => app.fetch(r)),
    websocket: realtime.websocket,
  });
  log.info("listening", { url: `http://${config.HOST}:${config.PORT}` });
  const operator = serveOperatorApi({
    db: database.db,
    config,
    version,
    log,
    pubsub: adapters.pubsub,
    hub: engine.machineHub,
  });
  if (operator) {
    log.info("operator API listening", { url: `http://${config.HOST}:${operator.port}${OPERATOR_API_PREFIX}` });
  }

  for (const module of modules) await module.onStart?.(ctx);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    // No new jobs; HTTP stops taking requests (the new deploy serves them). Not awaited: the
    // promise resolves only once every socket is closed, and browser tabs never close theirs.
    workers.stop();
    telemetry.stop();
    void server.stop();
    void operator?.stop();
    // Runners reconnect to the next instance, and people's desktops and terminals open again there.
    await engine.machineHub.stop();
    engine.streams.stop();
    // Runs in progress get up to 20 s to finish; the rest are checkpointed and resume on the next instance.
    const interrupted = await drainLocalRuns(RUN_DRAIN_MS);
    if (interrupted.length > 0) log.info("runs handed back for the next instance", { runs: interrupted });
    // Browser tabs, left open so they saw those runs finish, reconnect to the next instance.
    await server.stop(true);
    for (const module of modules) await module.onStop?.();
    await adapters.pubsub.close?.();
    await database.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { server, config };
}

/**
 * The database steps of boot, shared with `main.ts migrate`: pending
 * migrations (unless `migrate` is false), then the upcoming `messages`
 * partitions. Exits 1 when the database's migrations don't match this build.
 */
export async function prepareDatabase(database: DatabaseHandle, log: Logger, migrate = true) {
  if (migrate) {
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
}

/** MillionSend (or another Resend-compatible API) when keyed, else SMTP when `SMTP_URL` is set, else only the log. */
function emailSender(config: Config, log: Logger): EmailSender {
  // The Cloud (PUBLIC_URL https://agentes.chat) sends as ola@agentes.chat.
  const from = config.EMAIL_FROM ?? `agentes <ola@${new URL(config.PUBLIC_URL).hostname}>`;
  const replyTo = config.EMAIL_REPLY_TO;
  if (config.MILLIONSEND_API_KEY) {
    return createMillionSendSender({
      apiKey: config.MILLIONSEND_API_KEY,
      baseURL: config.MILLIONSEND_API_URL,
      from,
      replyTo,
    });
  }
  if (config.SMTP_URL) return createSmtpEmailSender({ url: config.SMTP_URL, from, replyTo });
  return createLogEmailSender((line, data) => log.info(line, data));
}

/** Our bucket (S3_*) when configured, else a folder on this server (FILES_DIR), else Postgres. */
function platformBlobStore(config: Config, db: Database) {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = config;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    return config.FILES_DIR ? createDiskBlobStore(config.FILES_DIR) : createPostgresBlobStore(db);
  }
  return createS3BlobStore({
    endpoint: S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    pathStyle: config.S3_PATH_STYLE,
  });
}

/** People's mailboxes for agents (ADR 0038): Gmail/Outlook through Composio when keyed, IMAP unless turned off. */
function mailAdapters(config: Config): MailAdapters {
  const composio = config.COMPOSIO_API_KEY
    ? createComposioClient({
        apiKey: config.COMPOSIO_API_KEY,
        webhookSecret: config.COMPOSIO_WEBHOOK_SECRET,
        gmailAuthConfigId: config.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
        outlookAuthConfigId: config.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID,
      })
    : null;
  // A mail server named by a person never resolves to our network (private, loopback, metadata).
  const checkHost = async (host: string) => {
    const addresses = await resolveHostDns(host);
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new Error("blocked host");
  };
  const imapOptions = { checkHost };
  return {
    composio: composio ? { client: composio, connector: createComposioMailConnector(composio) } : null,
    imap: config.MAIL_IMAP_ENABLED
      ? {
          connector: createImapMailConnector(imapOptions),
          poller: createImapPoller(imapOptions),
          tester: createImapConnectionTester(imapOptions),
          presets: MAIL_PRESETS,
        }
      : null,
  };
}
