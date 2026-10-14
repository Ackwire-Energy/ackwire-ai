import {
  type ContentBlock,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  ProviderError,
  promptChars,
  type StopReason,
  systemText,
  textOf,
} from "./types";

export interface FakeReply {
  chunks: string[];
  /** Tool calls appended after the text (stop reason becomes `tool_use` unless set). */
  toolUses?: { id?: string; name: string; input: Record<string, unknown> }[];
  /** Extra provider blocks to return (e.g. a fake thinking block), placed first. */
  opaque?: Record<string, unknown>[];
  usage?: Partial<ModelUsage>;
  stopReason?: StopReason;
  /** Report a different answering model (simulates a server-side fallback). */
  model?: string;
  /**
   * Fail after streaming `chunks`. `inputTokens` simulates the start-of-stream
   * usage event (null = the stream died before it).
   */
  failMidStream?: { error?: string; retryable?: boolean; inputTokens: number | null };
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
  const countCalls: ModelRequest[] = [];
  let toolSeq = 0;
  const provider: ModelProvider & { calls: FakeCall[]; countCalls: ModelRequest[] } = {
    id: "anthropic",
    calls,
    countCalls,
    async stream(request, { apiKey, onDelta }): Promise<ModelResult> {
      calls.push({ request: structuredClone({ ...request, signal: undefined }), apiKey });
      const scripted = reply?.(request, calls.length);
      if (scripted instanceof Error) throw scripted;
      const lastMessage = request.messages.at(-1);
      const last = lastMessage ? textOf(lastMessage.content) : "";
      const r = scripted ?? { chunks: ["Echo: ", last.slice(0, 40), "."] };
      for (const chunk of r.chunks) {
        await Promise.resolve();
        onDelta(chunk);
      }
      const text = r.chunks.join("");
      if (r.failMidStream) {
        throw new ProviderError(r.failMidStream.error ?? "stream broke", r.failMidStream.retryable ?? true, 500, {
          inputTokens: r.failMidStream.inputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: null,
          outputChars: text.length,
        });
      }
      const content: ContentBlock[] = [
        ...(r.opaque ?? []).map((data) => ({ type: "opaque" as const, provider: "anthropic", data })),
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(r.toolUses ?? []).map((t) => ({
          type: "tool_use" as const,
          id: t.id ?? `toolu_fake_${++toolSeq}`,
          name: t.name,
          input: t.input,
        })),
      ];
      return {
        text,
        content,
        model: r.model ?? request.model,
        stopReason: r.stopReason ?? (r.toolUses?.length ? "tool_use" : "end_turn"),
        usage: {
          inputTokens: r.usage?.inputTokens ?? Math.ceil((systemText(request.system).length + last.length) / 4),
          outputTokens: r.usage?.outputTokens ?? Math.ceil(text.length / 4),
          cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
        },
      };
    },
    async countTokens(request) {
      countCalls.push(request);
      return Math.ceil(promptChars(request) / 4);
    },
  };
  return provider;
}

export type FakeProvider = ReturnType<typeof createFakeProvider>;
