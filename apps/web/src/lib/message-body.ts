import type { TFunction } from "i18next";

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
    const note = `_${t("chat.body.interrupted", { defaultValue: "Interrupted by a server update. Ask again to continue." })}_`;
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
  return t(`chat.body.${code}`, { ...params, defaultValue: body });
}
