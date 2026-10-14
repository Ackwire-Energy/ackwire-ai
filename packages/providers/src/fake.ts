import type { ModelProvider, ModelRequest, ModelResult, ModelUsage, StopReason } from "./types";

export interface FakeReply {
  chunks: string[];
  usage?: Partial<ModelUsage>;
  stopReason?: StopReason;
  /** Report a different answering model (simulates a server-side fallback). */
  model?: string;
}

export interface FakeCall {
  request: ModelRequest;
  apiKey: string;
}

/**
 * In-memory provider for tests: no network. By default answers
 * "Echo: <last user message>" in three chunks. Pass `reply` to script answers
 * or throw errors. Records every call (including the decrypted key, so tests
 * can assert the gateway used the right credential).
 */
export function createFakeProvider(reply?: (request: ModelRequest, call: number) => FakeReply | Error) {
  const calls: FakeCall[] = [];
  const provider: ModelProvider & { calls: FakeCall[] } = {
    id: "anthropic",
    calls,
    async stream(request, { apiKey, onDelta }): Promise<ModelResult> {
      calls.push({ request, apiKey });
      const scripted = reply?.(request, calls.length);
      if (scripted instanceof Error) throw scripted;
      const last = request.messages.at(-1)?.content ?? "";
      const r = scripted ?? { chunks: ["Echo: ", last.slice(0, 40), "."] };
      for (const chunk of r.chunks) {
        await Promise.resolve();
        onDelta(chunk);
      }
      const text = r.chunks.join("");
      return {
        text,
        model: r.model ?? request.model,
        stopReason: r.stopReason ?? "end_turn",
        usage: {
          inputTokens: r.usage?.inputTokens ?? Math.ceil((request.system.length + last.length) / 4),
          outputTokens: r.usage?.outputTokens ?? Math.ceil(text.length / 4),
          cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
        },
      };
    },
  };
  return provider;
}

export type FakeProvider = ReturnType<typeof createFakeProvider>;
