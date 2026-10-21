import { ProviderError } from "./types";

/**
 * Text embeddings for hybrid search (ADR 0017). Provider-neutral; only the
 * Model Gateway calls it (`gateway.embed`), which records usage with kind
 * `embedding`. Vectors have `EMBEDDING_DIMENSIONS` entries (the database
 * column is fixed at that size).
 */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingResult {
  vectors: number[][];
  /** Tokens billed by the provider. */
  tokens: number;
  model: string;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  embed(texts: string[], options: { apiKey: string; inputType: "document" | "query" }): Promise<EmbeddingResult>;
}

/**
 * Embedding prices in nano-USD per token (USD per million × 1000). Voyage
 * list prices as of 2026-10 (verify before billing customers): voyage-3.5
 * $0.06/MTok, voyage-3.5-lite $0.02/MTok.
 */
export const EMBEDDING_CATALOG: Record<string, { provider: string; pricePerToken: number; dimensions: number }> = {
  "voyage-3.5": { provider: "voyage", pricePerToken: 60, dimensions: 1024 },
  "voyage-3.5-lite": { provider: "voyage", pricePerToken: 20, dimensions: 1024 },
  "fake-embed": { provider: "fake", pricePerToken: 0, dimensions: 1024 },
};

export const embeddingCostNanoUsd = (model: string, tokens: number) =>
  (EMBEDDING_CATALOG[model]?.pricePerToken ?? 0) * tokens;

/** Voyage AI embeddings over its REST API (no SDK needed). Optional: enabled by env. */
export function createVoyageEmbeddings(
  options: { model?: string; baseURL?: string; fetch?: typeof fetch } = {},
): EmbeddingProvider {
  const model = options.model ?? "voyage-3.5";
  const http = options.fetch ?? fetch;
  return {
    id: "voyage",
    model,
    async embed(texts, { apiKey, inputType }) {
      let res: Response;
      try {
        res = await http(`${options.baseURL ?? "https://api.voyageai.com"}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ input: texts, model, input_type: inputType, output_dimension: EMBEDDING_DIMENSIONS }),
        });
      } catch (error) {
        throw new ProviderError(`could not reach Voyage: ${String(error)}`, true);
      }
      if (!res.ok) {
        throw new ProviderError(
          `Voyage rejected the request (${res.status})`,
          res.status === 429 || res.status >= 500,
          res.status,
        );
      }
      const body = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
        usage?: { total_tokens?: number };
      };
      const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return { vectors, tokens: body.usage?.total_tokens ?? 0, model };
    },
  };
}

/**
 * Deterministic embeddings for tests: hashed bag of words, L2-normalized, so
 * texts sharing words are close. No network.
 */
export function createFakeEmbeddings(): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id: "fake",
    model: "fake-embed",
    calls,
    async embed(texts) {
      calls.push(texts);
      const vectors = texts.map((text) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
          let h = 2166136261;
          for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
          v[Math.abs(h) % EMBEDDING_DIMENSIONS] = (v[Math.abs(h) % EMBEDDING_DIMENSIONS] ?? 0) + 1;
        }
        const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0), model: "fake-embed" };
    },
  };
}
