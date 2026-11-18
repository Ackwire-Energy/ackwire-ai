import { describe, expect, test } from "bun:test";
import { createOpenAIEmbeddings, createVoyageEmbeddings, ProviderError } from "../src";

for (const kind of ["openai", "voyage"] as const) {
  describe(`${kind} embedding indices`, () => {
    const embed = (indices: number[]) => {
      const fetcher = (async () =>
        Response.json({
          data: indices.map((index) => ({ index, embedding: [index + 1] })),
        })) as unknown as typeof fetch;
      const provider =
        kind === "voyage"
          ? createVoyageEmbeddings({ fetch: fetcher })
          : createOpenAIEmbeddings({ url: "https://embeddings.example/v1", fetch: fetcher });
      return provider.embed(["first text", "second text"], { apiKey: "test-key", inputType: "document" });
    };

    test("restores an out-of-order response to the input order", async () => {
      expect((await embed([1, 0])).vectors.map((v) => v[0])).toEqual([1, 2]);
    });

    test.each([[0, 0], [0, 2], [-1, 0], [0, 0.5], [0]].map((indices) => ({ indices })))(
      "rejects missing or repeated input positions: %j",
      async ({ indices }) => {
        const error = await embed(indices).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).retryable).toBe(false);
      },
    );
  });
}
