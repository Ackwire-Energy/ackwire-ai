import type { ArtifactRef, Message, ReplyRef } from "../api/types";

/** Same rule as the server (`replyExcerpt`): one line, no code fences, ~200 characters. */
export function quoteExcerpt(body: string, max = 200): string {
  const line = body
    .replace(/```[\w+-]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `meta.replyTo` when it is well formed. */
export function replyOf(meta: Record<string, unknown> | undefined): ReplyRef | null {
  const r = meta?.replyTo;
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.messageId !== "string" || typeof o.excerpt !== "string") return null;
  const author = o.author as ReplyRef["author"] | undefined;
  return {
    messageId: o.messageId,
    threadId: typeof o.threadId === "string" ? o.threadId : null,
    author:
      author && (author.type === "person" || author.type === "agent")
        ? { type: author.type, id: typeof author.id === "string" ? author.id : null }
        : { type: "person", id: null },
    authorName: typeof o.authorName === "string" ? o.authorName : "",
    excerpt: o.excerpt,
  };
}

/** The optimistic `meta` of a message being sent (the server writes the real one). */
export function localMeta(quote: Message | null, authorName: string, files: ArtifactRef[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (quote) {
    meta.replyTo = {
      messageId: quote.id,
      threadId: quote.threadId,
      author: quote.author,
      authorName,
      excerpt: quoteExcerpt(quote.body),
    } satisfies ReplyRef;
  }
  if (files.length > 0) meta.artifacts = files;
  return meta;
}
