import { afterEach, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createAnthropicProvider, type ModelRequest, systemText } from "@agenteschat/providers";
import {
  createAgent,
  createJobHandlers,
  drainOutbox,
  getMessage,
  historyStart,
  type Message,
  openDm,
  postPersonMessage,
  toTurns,
} from "../src";
import { TYPING_GRACE_MS, waitForBurst } from "../src/burst";
import { type Fixture, setup } from "./fixtures";

/** Token-trim items B3, B5, B8–B11 (docs/backend-progress.md): the model reads less, or reads it from the cache. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const agentCalls = (fx: Fixture) =>
  fx.provider.calls.map((c) => c.request).filter((r) => (r.tools?.length ?? 0) > 0 && r.maxTokens > 0);
const names = (r: ModelRequest) => (r.tools ?? []).map((t) => t.name);

/** The Anthropic request body a captured request becomes (the transport refuses after reading it: no network). */
async function anthropicBody(request: ModelRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    throw new Error("captured");
  }) as unknown as typeof fetch;
  await createAnthropicProvider({ fetch: fetcher, maxRetries: 0 })
    .stream(request, { apiKey: "k", onDelta: () => {} })
    .catch(() => {});
  return body;
}

test("B3: rarely used conversation tools wait behind find_tools; the team block and the everyday ones stay", async () => {
  f = await setup({
    toolsOnDemand: true,
    contextTools: true,
    askAgent: true,
    mediaTools: true,
    followUps: true,
    react: true,
    askUser: true,
    reply: () => ({ chunks: ["ok"] }),
  });
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "DevOps", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, f.handlers);
  const [request] = agentCalls(f);
  if (!request) throw new Error("no call");
  const listed = names(request);
  for (const rare of ["send_sticker", "cancel_follow_up", "find_agent", "propose_instruction_change"])
    expect(listed).not.toContain(rare);
  for (const kept of ["react", "ask_user", "ask_agent", "follow_up", "remember", "find_tools"])
    expect(listed).toContain(kept);
  const system = systemText(request.system);
  expect(system).toContain("# Your team");
  expect(system).toContain("Use `find_agent` to see who knows or can do something");
  expect(system).toContain("- On demand: More of the conversation");
});

test("B5: two agents of a workspace send the same bytes up to the organization's breakpoint", async () => {
  f = await setup({ contextTools: true, react: true, askUser: true, reply: () => ({ chunks: ["ok"] }) });
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "DevOps", instructions: "Keep it up.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  // Each one's first message in its DM: no history yet, so the organization's breakpoint is sent (with history the
  // fourth breakpoint goes to it, and the lookback still finds the organization's).
  for (const agentId of [f.agent.id, ops.id]) {
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "oi" });
    await drainOutbox(f.db, f.handlers);
  }
  const [dev, op] = agentCalls(f);
  if (!dev || !op) throw new Error("two calls expected");
  const shared = (body: Record<string, unknown>) => {
    const system = body.system as Record<string, unknown>[];
    const at = system.findIndex((b) => b.cache_control);
    expect(String(system[at]?.text)).toStartWith('You work in "Acme"');
    return JSON.stringify([body.tools, system.slice(0, at + 1)]);
  };
  const [a, b] = await Promise.all([anthropicBody(dev), anthropicBody(op)]);
  expect(shared(b)).toBe(shared(a));
  // The agents' own blocks differ after it.
  expect(JSON.stringify(b.system)).not.toBe(JSON.stringify(a.system));
});

test("B8: the per-turn notes follow the history, and the next run reads this run's history from the cache", async () => {
  f = await setup({ contextTools: true, react: true, reply: () => ({ chunks: ["Oi!"] }) });
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  for (const body of ["oi", "tudo bem?"]) {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body });
    await drainOutbox(f.db, f.handlers);
  }
  const [first, second] = agentCalls(f);
  if (!first || !second) throw new Error("two calls expected");
  const [a, b] = await Promise.all([anthropicBody(first), anthropicBody(second)]);
  for (const body of [a, b]) {
    const system = JSON.stringify(body.system);
    expect(system).not.toContain("# Now");
    expect(system).not.toContain("# Where you are");
    const last = (body.messages as { content: { text?: string }[] }[]).at(-1)?.content.at(-1)?.text;
    expect(last).toStartWith("# This turn\n\nWhat is true now, for this turn");
    expect(last).toContain("## Now\n");
  }
  // The second run: the history before its trigger is the first run's, its trigger's text a cache point.
  const messages = (body: Record<string, unknown>) => body.messages as { role: string; content: unknown }[];
  const trigger = messages(b).at(-1)?.content as Record<string, unknown>[];
  // With the prompt's hour: a message after a pause still reads the conversation.
  expect(trigger[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  const firstTrigger = messages(a)[0]?.content as Record<string, unknown>[];
  expect(firstTrigger[0]?.cache_control).toBeUndefined();
  expect(messages(b)[0]?.content).toBe(firstTrigger[0]?.text as string);
  // Tools, the stable tools' mark, one system mark (the history's takes the other), the automatic one: 4.
  expect((b.system as Record<string, unknown>[]).filter((s) => s.cache_control)).toHaveLength(1);
});

test("B8: a cut history starts at an anchor that stays while the window slides", () => {
  const ids = Array.from(
    { length: 60 },
    (_, i) => `00000000-0000-7000-8000-${(i * 7919).toString(16).padStart(12, "0")}`,
  );
  const starts = Array.from({ length: 30 }, (_, k) => {
    const window = ids.slice(k, k + 30);
    return window[historyStart(window)];
  });
  // The same first message for several windows in a row, not a new one every time.
  const changes = starts.filter((id, i) => i > 0 && id !== starts[i - 1]).length;
  expect(changes).toBeLessThan(15);
  for (const [k, id] of starts.entries()) expect(ids.indexOf(id as string) - k).toBeLessThan(12);
});

test("B9: long messages before the last eight read cut, with the id expand reopens them by", async () => {
  const at = Date.now() - 60_000;
  const long = "relatório ".repeat(400);
  const history = Array.from(
    { length: 12 },
    (_, i) =>
      ({
        id: `00000000-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`,
        authorType: "person",
        authorUserId: "u1",
        authorAgentId: null,
        body: i === 1 || i === 10 ? long : `m${i}`,
        meta: {},
        createdAt: new Date(at + i * 1000),
      }) as unknown as Message,
  );
  const names = new Map([["u1", "Ana"]]);
  const text = JSON.stringify(toTurns(history, "agent", names, history.at(-1)?.id, { cutOld: true }));
  expect(text).toContain(`more characters; expand ${history[1]?.id} reopens it`);
  // In the last eight: whole.
  expect(text).not.toContain(`expand ${history[10]?.id}`);
  expect(text.split(long).length - 1).toBe(1);
  // Without expand, nothing is cut.
  expect(JSON.stringify(toTurns(history, "agent", names, history.at(-1)?.id))).not.toContain("reopens it");

  f = await setup({
    contextTools: true,
    reply: (_r, n) =>
      n === 1 ? { chunks: [], toolUses: [{ name: "expand", input: { item_id: posted.id } }] } : { chunks: ["ok"] },
  });
  const posted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: long,
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev resume" });
  await drainOutbox(f.db, f.handlers);
  const results = (f.provider.calls.at(-1)?.request.messages ?? [])
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .flatMap((b) => (b.type === "tool_result" ? [b.content] : []));
  expect(results).toEqual([long.trim()]);
});

test("B10: during the quiet window the first call's prompt is pre-warmed: the same request with no output", async () => {
  f = await setup({
    contextTools: true,
    react: true,
    quietMs: 300,
    reply: (r) => (r.maxTokens === 0 ? { chunks: [], usage: { outputTokens: 0 } } : { chunks: ["Oi!"] }),
  });
  const handlers = createJobHandlers({ ...f.jobDeps, prewarm: true });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, handlers);
  const [warm, real] = f.provider.calls.map((c) => c.request);
  expect(warm?.maxTokens).toBe(0);
  expect(real?.maxTokens).toBeGreaterThan(0);
  const same = (r?: ModelRequest) => JSON.stringify([r?.system, r?.messages, r?.tools, r?.cacheTtl, r?.notes]);
  expect(same(warm)).toBe(same(real));
  // Through the gateway: recorded like any call, with the agent.
  const usage = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, f.agent.id));
  expect(usage.filter((u) => u.kind === "agent")).toHaveLength(2);
  // Anthropic: a plain request with max_tokens 0, not a stream.
  const body = await anthropicBody(warm as ModelRequest);
  expect(body.max_tokens).toBe(0);
  expect(body.stream).toBe(false);
});

test("B11: the quiet window ends early when the person isn't typing, and lasts while they are", async () => {
  f = await setup({ contextTools: true });
  const sent = async (body: string) => {
    const posted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body,
    });
    const m = await getMessage(f.db, f.org.id, posted.id);
    if (!m) throw new Error("not posted");
    return m;
  };
  const alone = await sent("@dev oi");
  await waitForBurst(f.db, alone, 2500, undefined, f.pubsub);
  const quiet = Date.now() - alone.createdAt.getTime();
  expect(quiet).toBeGreaterThanOrEqual(TYPING_GRACE_MS - 10);
  expect(quiet).toBeLessThan(2300);

  const typing = await sent("@dev oi");
  setTimeout(() => {
    void f.pubsub.publish(channelTopic(f.general.id), {
      type: "user.typing",
      channelId: f.general.id,
      threadId: null,
      userId: f.owner.id,
      ttlMs: 6000,
    });
  }, 300);
  await waitForBurst(f.db, typing, 2500, undefined, f.pubsub);
  expect(Date.now() - typing.createdAt.getTime()).toBeGreaterThanOrEqual(2490);
});
