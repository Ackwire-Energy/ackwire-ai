import { afterEach, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, listMessages, liveTurnOf, postPersonMessage, type ToolSource } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

/** A built-in-like tool every agent may call (no scope), counting its calls. */
function envTool() {
  let calls = 0;
  const source: ToolSource = {
    name: "env",
    tools: async () => [
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          calls++;
          return { content: calls === 1 ? "go: not found" : "gcc: not found" };
        },
      },
    ],
  };
  return { source, calls: () => calls };
}

const turns = (req: ModelRequest) => req.messages.filter((m) => m.role === "assistant").length;

/** An answer past `WORKING_TEXT_MAX`: read as the answer before its turn ends. */
const LONG = "Não dá para compilar aqui: faltam Go e gcc no computador. ".repeat(6);

test("a 3-call tool loop: working text goes to the steps, never live; the long answer streams; the message is the final answer", async () => {
  const env = envTool();
  f = await setup({
    toolSources: [env.source],
    reply: (req) => {
      const n = turns(req);
      if (n === 0)
        return { chunks: ["Começo verificando ", "o ambiente."], toolUses: [{ name: "check_env", input: {} }] };
      if (n === 1)
        return {
          chunks: ["Go não está instalado. ", "Vou tentar o compilador C."],
          toolUses: [{ name: "check_env", input: {} }],
        };
      return { chunks: [LONG, "Instale os dois."] };
    },
  });
  const events = f.listen(f.general.id);
  // What an app opening mid-answer reads, as each piece goes out: the call's text so far, from its start.
  const seen: { turn: number; at: number; upTo: string; live: string | undefined }[] = [];
  let runId = "";
  const heard = new Map<number, string>();
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => {
    const d = e as { type: string; runId: string; turn: number; text: string };
    if (d.type !== "agent.delta") return;
    runId = d.runId;
    heard.set(d.turn, (heard.get(d.turn) ?? "") + d.text);
    const live = liveTurnOf(d.runId);
    seen.push({ turn: d.turn, at: live?.at ?? -1, upTo: heard.get(d.turn) ?? "", live: live?.text });
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev compila o projeto",
  });
  await drainOutbox(f.db, f.handlers);
  expect(env.calls()).toBe(2);
  expect(seen.length).toBeGreaterThan(0);
  for (const x of seen) {
    // Published once the call ended (its last pieces), it's gone: the app waits for the message or the next call.
    if (x.live === undefined) continue;
    expect(x.at).toBe(0);
    expect(x.live.startsWith(x.upTo)).toBe(true);
  }
  expect(seen.some((x) => x.live !== undefined)).toBe(true);
  // The run ended: nothing kept.
  expect(liveTurnOf(runId)).toBeUndefined();

  // The message holds only the final answer, whole.
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.map((m) => m.body)).toEqual(["@dev compila o projeto", `${LONG}Instale os dois.`.trim()]);

  // Nothing of the working text reached the conversation live, on any event.
  expect(JSON.stringify(events)).not.toContain("Vou tentar o compilador");
  expect(JSON.stringify(events)).not.toContain("Começo verificando");

  // Deltas: only the answer, tagged by its turn, with increasing seq (never reused).
  const deltas = events.flatMap((e) =>
    e.type === "agent.delta" ? [e as unknown as { turn: number; seq: number; text: string }] : [],
  );
  const byTurn = new Map<number, string>();
  for (const d of deltas) byTurn.set(d.turn, (byTurn.get(d.turn) ?? "") + d.text);
  expect([...byTurn]).toEqual([[3, `${LONG}Instale os dois.`]]);
  const seqs = deltas.map((d) => d.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  // Each piece says where it starts in its turn's text: an app that missed one knows its text has a hole.
  const told = new Map<number, number>();
  for (const d of deltas as { turn: number; at?: number; text: string }[]) {
    expect(d.at).toBe(told.get(d.turn) ?? 0);
    told.set(d.turn, (told.get(d.turn) ?? 0) + d.text.length);
  }

  // Steps: the model calls keep the narration, for the run's activity.
  const [run] = await f.db.select().from(schema.agentRuns);
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  const calls = steps
    .filter((s) => s.kind === "model_call")
    .sort((a, b) => a.seq - b.seq)
    .map((s) => (s.data as { narration?: string }).narration ?? null);
  expect(calls).toEqual(["Começo verificando o ambiente.", "Go não está instalado. Vou tentar o compilador C.", null]);
});

test("a short answer shows whole when its turn ends, with no tool call to wait for", async () => {
  f = await setup({ reply: () => ({ chunks: ["Tudo ", "certo."] }) });
  const events = f.listen(f.general.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, f.handlers);
  const deltas = events.flatMap((e) => (e.type === "agent.delta" ? [(e as unknown as { text: string }).text] : []));
  expect(deltas.join("")).toBe("Tudo certo.");
});

test("a final call with no text closes with the last narration instead of an empty reply", async () => {
  const env = envTool();
  f = await setup({
    toolSources: [env.source],
    reply: (req) =>
      turns(req) === 0
        ? { chunks: ["Instalando e testando."], toolUses: [{ name: "check_env", input: {} }] }
        : { chunks: [] },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev prepara o ambiente",
  });
  await drainOutbox(f.db, f.handlers);
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.at(-1)?.body).toBe("Instalando e testando.");
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
});
