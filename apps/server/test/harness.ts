import {
  type Adapters,
  createFakeEmailSender,
  createFakePushSender,
  createMemoryBlobStore,
  createMemoryPresence,
  createMemoryPubSub,
  createMemoryRateLimiter,
  createPostgresSearchResolver,
  type DatabaseDriver,
  type HumanCheck,
  type MailAdapters,
  noPlatformCredentials,
  type S3Fetch,
  type SandboxProvider,
} from "@agenteschat/adapters";
import { testConfig } from "@agenteschat/config";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  createFakeJudge,
  createFakeScheduleReader,
  createLocalKeyWrapper,
  drainOutbox,
  type EmailArt,
  type FakeScheduleAnswers,
  type McpConnect,
  type ResolveHost,
  type ToolSource,
} from "@agenteschat/engine";
import { PROVIDER_IDS } from "@agenteschat/providers";
import { createFakeEmbeddings, createFakeProvider } from "@agenteschat/providers/testing";
import { createApp } from "../src/app";
import { type AppleTokenRevoker, createAuth } from "../src/auth";
import { buildEngine } from "../src/engine";
import { createLogger } from "../src/logger";
import { createMachineSockets } from "../src/realtime/machines";
import { createStreamSockets } from "../src/realtime/streams";
import { createRealtime, type SocketData } from "../src/realtime/ws";

export const ORIGIN = "http://localhost:3000";

const WORKDAYS = ["MO", "TU", "WE", "TH", "FR"];
/** What the fake schedule reader answers for the phrases these tests write (a lookup table, not a parser). */
export const TEST_SCHEDULES: FakeScheduleAnswers = {
  "dias úteis às 9h": { rule: { freq: "weekly", byWeekday: WORKDAYS, times: ["09:00"] } },
  "a cada 2 semanas na segunda e quarta às 9h": {
    rule: { freq: "weekly", interval: 2, byWeekday: ["MO", "WE"], times: ["09:00"] },
  },
};

/**
 * The whole server wired like `start.ts`, but on PGlite, in-memory adapters
 * and the fake model provider. No `.env`, no network.
 */
export async function createTestServer(
  options: {
    env?: Record<string, string>;
    reply?: Parameters<typeof createFakeProvider>[0];
    toolSources?: ToolSource[];
    /** In-process MCP servers for the connector tool source. */
    mcpConnect?: McpConnect;
    /** Fake outbound HTTP (OAuth token endpoints). */
    http?: typeof fetch;
    /** Use fake embeddings (hybrid search). Off by default: full-text only, and no embedding usage rows. */
    embeddings?: boolean;
    /** Fake S3 server and DNS for org buckets. */
    s3Fetch?: S3Fetch;
    resolveHost?: ResolveHost;
    /** Fake code sandbox (off by default). */
    sandbox?: SandboxProvider;
    /** Fake GitHub (git smart HTTP and REST) for the git proxy. */
    github?: { gitUrl: string; apiUrl: string; fetch: typeof fetch };
    /** Answers of the fake judge (judge.ts). Default: every Noul 0. */
    judge?: Parameters<typeof createFakeJudge>[0];
    /** The fake schedule reader's table (phrase → answer), on top of `TEST_SCHEDULES`. */
    schedules?: FakeScheduleAnswers;
    /** Fake Apple token revocation (account deletion). */
    appleRevoke?: AppleTokenRevoker;
    /** Fake GitHub for the desktop app's releases. */
    desktopFetch?: typeof fetch;
    /** Fake mail adapters (Composio, IMAP); absent = no email connectors. */
    mail?: MailAdapters;
    /** Fake database driver (ADR 0039); absent = no database connector. */
    databases?: DatabaseDriver;
    /** Where emails get their pictures; absent = linked from `PUBLIC_URL`. */
    emailArt?: EmailArt;
    /** The bot check (Turnstile with a fake `fetch`); absent = none, as without its keys. */
    humanCheck?: HumanCheck;
  } = {},
) {
  const { db, close } = await createTestDatabase();
  const config = testConfig({
    PUBLIC_URL: ORIGIN,
    AGENT_MAX_OUTPUT_TOKENS: "1000",
    ...options.env,
  });
  const log = createLogger("error");
  const email = createFakeEmailSender();
  const push = createFakePushSender();
  const platformBlobs = createMemoryBlobStore();
  const adapters: Adapters = {
    search: createPostgresSearchResolver(db),
    pubsub: createMemoryPubSub(),
    presence: createMemoryPresence(),
    rateLimiter: createMemoryRateLimiter(),
    keyWrapper: createLocalKeyWrapper(config.AGENTES_SECRET),
    legacyKeyWrappers: [],
    platformCredentials: noPlatformCredentials,
    email,
    platformBlobs,
    push,
    ...(options.mail ? { mail: options.mail } : {}),
    databases: options.databases ?? null,
    humanCheck: options.humanCheck ?? null,
  };
  const provider = createFakeProvider(options.reply);
  const embeddings = createFakeEmbeddings();
  const engine = buildEngine({
    db,
    config,
    adapters,
    modelProviders: Object.fromEntries(PROVIDER_IDS.map((id) => [id, provider])),
    toolSources: options.toolSources,
    mcpConnect: options.mcpConnect,
    http: options.http,
    embeddings: options.embeddings ? { provider: embeddings, apiKey: "test" } : undefined,
    deltaFlushMs: 0,
    s3Fetch: options.s3Fetch,
    resolveHost: options.resolveHost,
    sandbox: options.sandbox ?? null,
    github: options.github,
    judge: createFakeJudge(options.judge),
    schedules: createFakeScheduleReader({ ...TEST_SCHEDULES, ...options.schedules }),
    toolsOnDemand: false,
    emailArt: options.emailArt,
  });
  const { handlers } = engine;
  const auth = createAuth({
    db,
    config,
    log,
    emailDelivers: true,
    rateLimiter: adapters.rateLimiter,
    humanCheck: adapters.humanCheck,
  });
  const app = createApp({
    edition: "selfhost",
    version: "test",
    modules: [],
    pingDatabase: async () => {},
    services: {
      db,
      auth,
      config,
      adapters,
      extras: {
        http: options.http,
        mcpConnect: options.mcpConnect,
        resolveHost: options.resolveHost,
        embed: engine.gateway.embed,
        storage: engine.storage,
        artifacts: engine.artifacts,
        context: engine.context,
        sandbox: engine.sandbox,
        gitProxy: engine.sandbox.provider ? engine.gitProxy : undefined,
        appleRevoke: options.appleRevoke,
        desktopFetch: options.desktopFetch,
        browserLive: engine.browserLive,
        router: engine.router,
        streams: engine.streams,
      },
    },
    log,
  });
  const realtime = createRealtime({
    db,
    auth,
    config,
    log,
    ...adapters,
    machines: createMachineSockets(engine.machineHub),
    browserLive: engine.browserLive,
    streams: createStreamSockets({ db, auth, config, broker: engine.streams }),
  });
  return {
    db,
    close: async () => {
      await engine.machineHub.stop();
      engine.streams.stop();
      await close();
    },
    config,
    adapters,
    provider,
    embeddings,
    email,
    push,
    platformBlobs,
    engine,
    app,
    auth,
    realtime,
    drain: () => drainOutbox(db, handlers),
  };
}

export type TestServer = Awaited<ReturnType<typeof createTestServer>>;

/** Starts a real Bun server on a random port (needed for WebSocket tests). */
export function listen(t: TestServer) {
  return Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => t.realtime.fetch(req, srv, (r) => t.app.fetch(r)),
    websocket: t.realtime.websocket,
  });
}

/** A WebSocket upgrade's HTTP status, for refused connections (a plain request with the upgrade headers). */
export async function upgradeStatus(url: string, headers: Record<string, string>) {
  const res = await fetch(url.replace("ws://", "http://"), {
    headers: {
      ...headers,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
  return res.status;
}

/** Minimal browser over `app.request`: keeps cookies and sends our Origin. */
export function browser(t: TestServer) {
  let cookie = "";
  const request = async (
    path: string,
    init: { method?: string; json?: unknown; origin?: string | null; headers?: Record<string, string> } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const res = await t.app.request(path, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      if (!pair) continue;
      const [name] = pair.split("=");
      const rest = cookie
        .split("; ")
        .filter((p) => p && !p.startsWith(`${name}=`))
        .join("; ");
      cookie = [rest, pair].filter(Boolean).join("; ");
    }
    return res;
  };
  return Object.assign(request, { cookie: () => cookie });
}

export type Browser = ReturnType<typeof browser>;

export async function signUp(b: Browser, email: string) {
  const res = await b("/api/auth/sign-up/email", {
    json: { email, password: "correct horse battery", name: email.split("@")[0] },
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return res;
}

/**
 * Someone joins `orgId` the way people do (ADR 0068): `admin` invites the address by email, a new browser signs
 * up with it (the invitation opens sign-up on this closed server) and accepts. `as`: an account already signed in
 * with that address accepts instead.
 */
export async function joinByInvitation(
  t: TestServer,
  admin: Browser,
  orgId: string,
  email: string,
  options: { role?: "member" | "admin"; as?: Browser } = {},
) {
  const invited = await admin(`/api/app/organizations/${orgId}/invitations`, {
    json: { email, role: options.role ?? "member" },
  });
  if (invited.status !== 201) throw new Error(`invite failed: ${invited.status} ${await invited.text()}`);
  const token = ((await invited.json()) as { url: string }).url.split("/invite/")[1] ?? "";
  const b = options.as ?? browser(t);
  if (!options.as) await signUp(b, email);
  const accepted = await b(`/api/app/invitations/${token}/accept`, { json: {} });
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${await accepted.text()}`);
  return b;
}

/**
 * Connects a computer over HTTP the way the runner and the site do (ADR 0036
 * §5): the computer asks for a code, a member confirms it through `orgApi`
 * (their `/api/app/organizations/{orgId}` calls), the computer polls for
 * its token.
 */
export async function pairComputer(
  t: TestServer,
  orgApi: (path: string, init?: Parameters<Browser>[1]) => Promise<Response>,
  computer: Record<string, unknown>,
  options: { name?: string; ip?: string } = {},
) {
  const runner = (path: string, body: unknown) =>
    t.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": options.ip ?? "203.0.113.9" },
      body: JSON.stringify(body),
    });
  const started = await runner("/api/machines/device", { name: options.name ?? "MacBook", ...computer });
  if (started.status !== 200) throw new Error(`device start failed: ${started.status} ${await started.text()}`);
  const { deviceCode, userCode } = (await started.json()) as { deviceCode: string; userCode: string };
  const confirmed = await orgApi(`/machines/device/${userCode}/confirm`, {
    json: options.name ? { name: options.name } : {},
  });
  if (confirmed.status !== 201) throw new Error(`confirm failed: ${confirmed.status} ${await confirmed.text()}`);
  const token = await runner("/api/machines/device/token", { deviceCode });
  if (token.status !== 200) throw new Error(`token failed: ${token.status} ${await token.text()}`);
  return (await token.json()) as { machineId: string; token: string; name: string; org: { id: string; name: string } };
}

/** Owner with an organization, a credential and an agent `@dev` in #general (a fixed model, not Automático). */
export async function seedOrg(b: Browser) {
  const created = (await (
    await b("/api/app/organizations", { json: { name: "Acme", context: "Acme builds rockets." } })
  ).json()) as {
    organization: { id: string };
    generalChannelId: string;
  };
  const orgId = created.organization.id;
  const credential = (await (
    await b(`/api/app/organizations/${orgId}/credentials`, {
      json: { provider: "anthropic", label: "main", apiKey: "sk-ant-api-secret-9876" },
    })
  ).json()) as { id: string };
  const agent = (await (
    await b(`/api/app/organizations/${orgId}/agents`, {
      json: {
        name: "Dev",
        handle: "dev",
        model: "claude-sonnet-5-5",
        credentialId: credential.id,
        monthlyBudgetUsd: 50,
      },
    })
  ).json()) as { id: string };
  await b(`/api/app/organizations/${orgId}/channels/${created.generalChannelId}/members`, {
    json: { agentId: agent.id },
  });
  return { orgId, channelId: created.generalChannelId, credentialId: credential.id, agentId: agent.id };
}
