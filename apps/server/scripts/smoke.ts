/**
 * Real-environment smoke check: `bun run smoke` (reads `.env`). Never part of
 * `bun test` (not a *.test.ts file, and it talks to real services).
 *
 * Needs DATABASE_URL and AGENTES_SECRET, plus ANTHROPIC_API_KEY (used as the
 * throwaway org's own key) or PLATFORM_ANTHROPIC_API_KEY. Optional:
 * ANTHROPIC_WORKSPACE_ID / PLATFORM_ANTHROPIC_WORKSPACE_ID for keys that
 * aren't scoped to a workspace.
 *
 * Steps: migrate → throwaway user, org, credential, agent and channel → post
 * an @mention → run the real worker loop until the streamed reply is saved →
 * print the reply and its usage record → delete the throwaway org and user.
 */
import {
  channelTopic,
  createLogEmailSender,
  createMemoryPresence,
  createMemoryPubSub,
  createMemoryRateLimiter,
  createPostgresSearchResolver,
  envPlatformCredentials,
} from "@agenteschat/adapters";
import { loadConfig } from "@agenteschat/config";
import { createDatabase, ensureMessagePartitions, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  createCredential,
  createLocalKeyWrapper,
  createOrganization,
  drainOutbox,
  enableCaches,
  postPersonMessage,
} from "@agenteschat/engine";
import { createAnthropicProvider } from "@agenteschat/providers";
import { buildEngine } from "../src/engine";

const config = loadConfig();
const orgKey = process.env.ANTHROPIC_API_KEY?.trim();
const orgWorkspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined;
if (!orgKey && !config.PLATFORM_ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY or PLATFORM_ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

const database = createDatabase({ url: config.DATABASE_URL, poolMax: 4 });
const started = Date.now();
const step = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

let orgId: string | undefined;
const userId = `smoke_${crypto.randomUUID().slice(0, 8)}`;
try {
  step("migrating");
  await database.migrate();
  await ensureMessagePartitions(database.db);
  const db = database.db;

  const keyWrapper = createLocalKeyWrapper(config.AGENTES_SECRET);
  const pubsub = createMemoryPubSub();
  const adapters = {
    search: createPostgresSearchResolver(db),
    pubsub,
    presence: createMemoryPresence(),
    rateLimiter: createMemoryRateLimiter(),
    keyWrapper,
    legacyKeyWrappers: [],
    email: createLogEmailSender(() => {}),
    platformCredentials: envPlatformCredentials({
      anthropic: { apiKey: config.PLATFORM_ANTHROPIC_API_KEY, workspaceId: config.PLATFORM_ANTHROPIC_WORKSPACE_ID },
    }),
  };
  enableCaches();
  let profile: unknown = null;
  const engine = buildEngine({
    onRunProfile: (p) => {
      profile = p;
    },
    db,
    config: { ...config, ROUTER_ENABLED: false },
    adapters,
    modelProviders: { anthropic: createAnthropicProvider() },
  });

  step("creating a throwaway org, user, agent and channel");
  await db.insert(schema.users).values({ id: userId, name: "Smoke", email: `${userId}@smoke.invalid` });
  const { organization, general } = await createOrganization(db, userId, {
    name: `smoke ${new Date().toISOString()}`,
    context: "This is an automated smoke test of agentes.chat.",
  });
  orgId = organization.id;
  const credential = orgKey
    ? await createCredential(db, keyWrapper, userId, orgId, {
        provider: "anthropic",
        label: "smoke",
        apiKey: orgKey,
        workspaceId: orgWorkspace,
      })
    : null;
  const agent = await createAgent(
    db,
    userId,
    orgId,
    {
      name: "Smoke",
      handle: "smoke",
      instructions: "Reply in one short sentence.",
      model: "claude-haiku-5-5",
      credentialId: credential?.id ?? null,
      monthlyBudgetNanoUsd: 50_000_000, // US$ 0.05
    },
    { model: "claude-haiku-5-5" },
  );
  await addChannelMember(db, userId, orgId, general.id, { agentId: agent.id });
  step(`using ${credential ? "the org's own key" : "the platform key"}${orgWorkspace ? " with a workspace id" : ""}`);

  let streamed = "";
  let firstDeltaAt = 0;
  const seen = new Map<string, number>();
  const postedAt = { t: 0 };
  pubsub.subscribe(channelTopic(general.id), (e: { type: string; text?: unknown }) => {
    seen.set(e.type, (seen.get(e.type) ?? 0) + 1);
    if (e.type === "agent.thinking" && !seen.has("thinking@")) {
      seen.set("thinking@", Date.now() - postedAt.t);
    }
    if (e.type === "agent.delta") {
      if (!firstDeltaAt) firstDeltaAt = Date.now();
      streamed += String(e.text);
      process.stdout.write(String(e.text));
    }
  });
  postedAt.t = Date.now();
  await postPersonMessage({ db, pubsub }, userId, orgId, general.id, { body: "@smoke say hello to the team" });

  step("running workers (real model call)");
  const deadline = Date.now() + 120_000;
  let run: typeof schema.agentRuns.$inferSelect | undefined;
  while (Date.now() < deadline) {
    await drainOutbox(db, engine.handlers);
    [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.orgId, orgId));
    if (run && (run.status === "done" || run.status === "failed")) break;
    await Bun.sleep(500);
  }
  process.stdout.write("\n");
  if (run?.status !== "done") throw new Error(`run did not finish: ${run?.status ?? "none"} ${run?.error ?? ""}`);

  const [reply] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, run.replyMessageId ?? ""));
  const usage = await db.select().from(schema.usageRecords).where(eq(schema.usageRecords.orgId, orgId));
  step("reply saved");
  console.log(
    JSON.stringify(
      {
        reply: reply?.body,
        streamedChars: streamed.length,
        postToThinkingMs: seen.get("thinking@") ?? null,
        postToFirstDeltaMs: firstDeltaAt ? firstDeltaAt - postedAt.t : null,
        events: Object.fromEntries([...seen].filter(([k]) => !k.endsWith("@"))),
      },
      null,
      2,
    ),
  );
  console.log("run profile:", JSON.stringify(profile, null, 2));
  console.log(
    JSON.stringify(
      usage.map((u) => ({
        kind: u.kind,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: u.costNanoUsd / 1e9,
        partial: u.partial,
      })),
      null,
      2,
    ),
  );
  step("smoke ok");
} catch (error) {
  console.error("smoke FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try {
    if (orgId) await database.db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await database.db.delete(schema.users).where(eq(schema.users.id, userId));
    step("throwaway org and user deleted");
  } catch (error) {
    console.error("cleanup failed:", error instanceof Error ? error.message : error);
  }
  await database.close();
}
