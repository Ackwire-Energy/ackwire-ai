import type { TFunction } from "i18next";
import { previewOf } from "./consultations";

type Meta = Record<string, unknown> | undefined;

/**
 * The text of an agent message the server wrote itself (approval and secret
 * cards, "Done.", "File saved.", memory lines, a run cut by a deploy), in the
 * person's language: `meta.bodyCode` + `meta.bodyParams` → `chat.body.*`, and
 * `meta.interrupted` / `meta.brainInterrupted` → what the agent wrote plus the notice. Anything else (the
 * model's own text) is shown as is; the server's English body is the fallback.
 */
export function serverBody(t: TFunction, body: string, meta: Meta): string {
  const m = meta ?? {};
  const interrupted = m.interrupted as { text?: unknown } | undefined;
  if (interrupted && typeof interrupted === "object" && typeof interrupted.text === "string") {
    const note = `_${t("chat.body.interrupted", { defaultValue: "Interrupted by a server restart. Ask again to continue." })}_`;
    return interrupted.text ? `${interrupted.text}\n\n${note}` : note;
  }
  // A computer brain stopped mid-turn after its tools ran: what it wrote, then which tools it used.
  const cut = m.brainInterrupted as { brain?: unknown; text?: unknown; tools?: unknown } | undefined;
  if (cut && typeof cut === "object" && typeof cut.text === "string") {
    const brain = cut.brain === "codex" ? "Codex" : "Claude Code";
    const tools = Array.isArray(cut.tools) ? cut.tools.filter((x) => typeof x === "string").join(", ") : "";
    const note = `_${t("chat.body.brain_interrupted", {
      brain,
      tools,
      defaultValue: `${brain} stopped before finishing. Already done, not repeated: ${tools}.`,
    })}_`;
    return cut.text ? `${cut.text}\n\n${note}` : note;
  }
  const code = typeof m.bodyCode === "string" ? m.bodyCode : null;
  if (!code) return body;
  if (code === "memory") {
    const updates = Array.isArray(m.memoryUpdates) ? (m.memoryUpdates as { action?: unknown; text?: unknown }[]) : [];
    const lines = updates.flatMap((u) =>
      u && typeof u.action === "string" && typeof u.text === "string"
        ? [t(`chat.body.memory.${u.action}`, { text: u.text, defaultValue: "" })]
        : [],
    );
    return lines.some(Boolean) ? lines.filter(Boolean).join("\n") : body;
  }
  const params =
    m.bodyParams && typeof m.bodyParams === "object" ? (m.bodyParams as Record<string, unknown>) : ({} as const);
  // Waiting for room on a busy computer, not for one that went away; no AI because its sign-in ended, or because the
  // computer's own sign-in of that CLI isn't there (`own`), not none at all.
  const busy = code === "brain_unavailable" && (m.brainUnavailable as { code?: unknown } | undefined)?.code === "busy";
  const noAi = code === "no_ai" ? (m.noAi as { reason?: unknown; own?: unknown } | undefined) : undefined;
  const signedOut = noAi?.reason === "not_signed_in";
  const own = signedOut && (noAi?.own === "codex" || noAi?.own === "claude_code") ? noAi.own : null;
  if (own) {
    const brain = own === "codex" ? "Codex" : "Claude Code";
    return t("chat.body.no_ai_not_signed_in", { brain, defaultValue: body });
  }
  const shown = busy ? "brain_busy" : signedOut ? "no_ai_signed_out" : code;
  return t(`chat.body.${shown}`, { ...params, defaultValue: body });
}

/**
 * A conversation list's last-message line: a body the server wrote (`meta` from the list, same keys as
 * the message's) in the reader's language, as the chat shows it, on one plain line; else the text as is.
 */
export function previewBody(t: TFunction, text: string, meta: Meta | null): string {
  if (!meta) return text;
  const shown = serverBody(t, text, meta);
  return shown === text ? text : previewOf(shown);
}
