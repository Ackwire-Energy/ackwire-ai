import {
  type Adapters,
  createFakeEmailSender,
  createFakePushSender,
  createMemoryBlobStore,
  createMemoryPresence,
  createMemoryPubSub,
  createMemoryRateLimiter,
  createPostgresSearchResolver,
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
  type FakeScheduleAnswers,
  type McpConnect,
  type ResolveHost,
  type ToolSource,
} from "@agenteschat/engine";
import { createFakeEmbeddings, createFakeProvider } from "@agenteschat/providers/testing";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import { buildEngine } from "../src/engine";
import { createLogger } from "../src/logger";
import { createMachineSockets } from "../src/realtime/machines";
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
  } = {},
) {
  const { db, close } = await createTestDatabase();
  // Memory by meaning is on by default in production; tests opt in with env (the fake judge answers nothing).
  const config = testConfig({
    PUBLIC_URL: ORIGIN,
    AGENT_MAX_OUTPUT_TOKENS: "1000",
    MEMORY_JUDGE_ORGS: "",
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
  };
  const provider = createFakeProvider(options.reply);
  const embeddings = createFakeEmbeddings();
  const engine = buildEngine({
    db,
    config,
    adapters,
    modelProviders: { anthropic: provider, openai: provider },
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
  });
  const { handlers } = engine;
  const auth = createAuth({ db, config, log, emailDelivers: true });
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
  });
  return {
    db,
    close: async () => {
      await engine.machineHub.stop();
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

export async function signUp(b: Browser, email: string, options: { inviteToken?: string } = {}) {
  const res = await b("/api/auth/sign-up/email", {
    json: { email, password: "correct horse battery", name: email.split("@")[0] },
    headers: options.inviteToken ? { "x-invite-token": options.inviteToken } : undefined,
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return res;
}

/** Owner with an organization, a credential and an agent `@dev` in #general. */
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
      json: { name: "Dev", handle: "dev", credentialId: credential.id, monthlyBudgetUsd: 50 },
    })
  ).json()) as { id: string };
  await b(`/api/app/organizations/${orgId}/channels/${created.generalChannelId}/members`, {
    json: { agentId: agent.id },
  });
  return { orgId, channelId: created.generalChannelId, credentialId: credential.id, agentId: agent.id };
}
