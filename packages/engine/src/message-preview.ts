import { type MessageMedia, mediaOf } from "./media";

/** One line of at most `max` chars (a preview's text). */
function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * What a last-message preview needs to show a server-written body in the reader's language (the same
 * `meta` keys the chat reads: `bodyCode`/`bodyParams`, a cut-off run's notes, memory lines, why an
 * agent has no AI, a GIF or a sticker), or null for a plain message. Long texts are cut: a preview is one line.
 */
export interface PreviewMeta {
  bodyCode?: string;
  bodyParams?: Record<string, unknown>;
  interrupted?: { text: string };
  brainInterrupted?: { brain?: string; text: string; tools?: string[] };
  memoryUpdates?: { action: string; text: string }[];
  noAi?: { reason: string; own?: string };
  /** A GIF or a sticker (ADR 0091), as `meta.media`: a message of only that has no text to preview. */
  media?: MessageMedia;
}

/**
 * A message of only a GIF or a sticker (ADR 0091): which, so a preview with no text says it in the reader's
 * language ("GIF", "Figurinha"); null for a message with text or without media.
 */
export function previewMediaKind(
  body: string | null | undefined,
  meta: Record<string, unknown> | null | undefined,
): MessageMedia["kind"] | null {
  return (body ?? "").trim() === "" ? (mediaOf(meta)?.kind ?? null) : null;
}

export function previewMeta(meta: Record<string, unknown> | null | undefined): PreviewMeta | null {
  if (!meta) return null;
  const out: PreviewMeta = {};
  if (typeof meta.bodyCode === "string") out.bodyCode = meta.bodyCode;
  const media = mediaOf(meta);
  if (media) out.media = media;
  if (meta.bodyParams && typeof meta.bodyParams === "object") {
    out.bodyParams = meta.bodyParams as Record<string, unknown>;
  }
  const noAi = meta.noAi as { reason?: unknown; own?: unknown } | undefined;
  if (out.bodyCode === "no_ai" && typeof noAi?.reason === "string") {
    out.noAi = { reason: noAi.reason, ...(typeof noAi.own === "string" ? { own: noAi.own } : {}) };
  }
  const cut = (v: unknown) => (typeof v === "string" ? oneLine(v) : null);
  const interrupted = meta.interrupted as { text?: unknown } | undefined;
  const iText = interrupted && typeof interrupted === "object" ? cut(interrupted.text) : null;
  if (iText !== null) out.interrupted = { text: iText };
  const b = meta.brainInterrupted as { brain?: unknown; text?: unknown; tools?: unknown } | undefined;
  const bText = b && typeof b === "object" ? cut(b.text) : null;
  if (b && bText !== null) {
    out.brainInterrupted = {
      text: bText,
      ...(typeof b.brain === "string" ? { brain: b.brain } : {}),
      ...(Array.isArray(b.tools) ? { tools: b.tools.filter((x): x is string => typeof x === "string") } : {}),
    };
  }
  if (out.bodyCode === "memory" && Array.isArray(meta.memoryUpdates)) {
    out.memoryUpdates = (meta.memoryUpdates as { action?: unknown; text?: unknown }[])
      .flatMap((u) =>
        u && typeof u.action === "string" && typeof u.text === "string"
          ? [{ action: u.action, text: oneLine(u.text) }]
          : [],
      )
      .slice(0, 3);
  }
  return Object.keys(out).length > 0 ? out : null;
}
