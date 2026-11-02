type Tree = Record<string, unknown>;

/** Deep merge of string trees: `b` wins on the same leaf, nested objects merge (a language over English). */
export function deepMerge<T extends object>(a: T, b: object): T {
  const out: Tree = { ...(a as Tree) };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] =
      v && typeof v === "object" && prev && typeof prev === "object" && typeof prev !== "function"
        ? deepMerge(prev as object, v as object)
        : v;
  }
  return out as T;
}
