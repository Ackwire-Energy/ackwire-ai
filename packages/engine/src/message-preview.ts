/** One line of at most `max` chars (a preview's text). */
function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * What a last-message preview needs to show a server-written body in the reader's language (the same
 * `meta` keys the chat reads: `bodyCode`/`bodyParams`, a cut-off run's notes, memory lines), or null
 * for a plain message. Long texts are cut: a preview is one line.
 */
export interface PreviewMeta {
  bodyCode?: string;
  bodyParams?: Record<string, unknown>;
  interrupted?: { text: string };
  brainInterrupted?: { brain?: string; text: string; tools?: string[] };
  memoryUpdates?: { action: string; text: string }[];
}

export function previewMeta(meta: Record<string, unknown> | null | undefined): PreviewMeta | null {
  if (!meta) return null;
  const out: PreviewMeta = {};
  if (typeof meta.bodyCode === "string") out.bodyCode = meta.bodyCode;
  if (meta.bodyParams && typeof meta.bodyParams === "object") {
    out.bodyParams = meta.bodyParams as Record<string, unknown>;
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
