import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, listMessages, postPersonMessage, type ToolSource } from "../src";
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

test("a 3-call tool loop: narration goes to steps and live events, the message is the final answer, nothing lost", async () => {
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
      return { chunks: ["Não dá para compilar aqui: ", "faltam Go e gcc no computador."] };
    },
  });
  const events = f.listen(f.general.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev compila o projeto",
  });
  await drainOutbox(f.db, f.handlers);
  expect(env.calls()).toBe(2);

  // The message holds only the final answer, whole.
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.map((m) => m.body)).toEqual([
    "@dev compila o projeto",
    "Não dá para compilar aqui: faltam Go e gcc no computador.",
  ]);

  // Narration: one event per tool turn, in order, complete.
  const narration = events.flatMap((e) =>
    e.type === "agent.narration" ? [e as unknown as { turn: number; text: string }] : [],
  );
  expect(narration.map((e) => [e.turn, e.text])).toEqual([
    [1, "Começo verificando o ambiente."],
    [2, "Go não está instalado. Vou tentar o compilador C."],
  ]);

  // Deltas: every piece streamed, tagged by turn, with increasing seq (never reused).
  const deltas = events.flatMap((e) =>
    e.type === "agent.delta" ? [e as unknown as { turn: number; seq: number; text: string }] : [],
  );
  const byTurn = new Map<number, string>();
  for (const d of deltas) byTurn.set(d.turn, (byTurn.get(d.turn) ?? "") + d.text);
  expect([...byTurn]).toEqual([
    [1, "Começo verificando o ambiente."],
    [2, "Go não está instalado. Vou tentar o compilador C."],
    [3, "Não dá para compilar aqui: faltam Go e gcc no computador."],
  ]);
  const seqs = deltas.map((d) => d.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);

  // Steps: the model calls keep the narration.
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
