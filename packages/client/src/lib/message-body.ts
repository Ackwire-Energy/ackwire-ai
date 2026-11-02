import type { TFunction } from "i18next";
import { previewOf } from "./consultations";
import { mediaKindOf, mediaWord } from "./media";
import { brainName } from "./outages";
import { usageWhen } from "./plan-usage";

/** Notes of an agent waiting on its plan's limit or its budget (`meta.usageWait`): `{{when}}` from its reset. */
const USAGE_NOTES = new Set([
  "plan_limit_cut",
  "plan_limit_cut_unknown",
  "plan_limit_wait",
  "plan_limit_wait_unknown",
  "budget_wait",
]);

type Meta = Record<string, unknown> | undefined;

/**
 * The text of an agent message the server wrote itself (approval and secret
 * cards, "Done.", "File saved.", memory lines, a run cut by a deploy), in the
 * person's language: `meta.bodyCode` + `meta.bodyParams` → `chat.body.*`, and
 * `meta.interrupted` / `meta.brainInterrupted` → what the agent wrote plus the notice. Anything else (the
 * model's own text) is shown as is; the server's English body is the fallback. A body that says where something ran
 * (a task's end, a mission's plan: `bodyParams.computer`) names the computer only with `namesComputer`
 * (`namesComputers`), else it reads in its code's `…NoComputer` words. `locale` formats a usage wait's reset time.
 */
export function serverBody(t: TFunction, body: string, meta: Meta, locale?: string, namesComputer = false): string {
  const m = meta ?? {};
  const interrupted = m.interrupted as { text?: unknown } | undefined;
  if (interrupted && typeof interrupted === "object" && typeof interrupted.text === "string") {
    const note = `_${t("chat.body.interrupted", { defaultValue: "Interrupted by a server restart. Ask again to continue." })}_`;
    return interrupted.text ? `${interrupted.text}\n\n${note}` : note;
  }
  // A computer brain stopped mid-turn after its tools ran: what it wrote, then which tools it used.
  const cut = m.brainInterrupted as { brain?: unknown; text?: unknown; tools?: unknown } | undefined;
  if (cut && typeof cut === "object" && typeof cut.text === "string") {
    const brain = brainName(typeof cut.brain === "string" ? cut.brain : null);
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
  const own =
    signedOut && (noAi?.own === "codex" || noAi?.own === "claude_code" || noAi?.own === "cursor") ? noAi.own : null;
  if (own) {
    const brain = brainName(own);
    return t("chat.body.no_ai_not_signed_in", { brain, defaultValue: body });
  }
  if (USAGE_NOTES.has(code)) {
    const resetsAt = (m.usageWait as { resetsAt?: unknown } | undefined)?.resetsAt;
    const when = typeof resetsAt === "string" ? usageWhen(t, locale, resetsAt) : "";
    return t(`chat.body.${code}`, { ...params, when, defaultValue: body });
  }
  // An older note about a plan's limit (sent as the computer brain being unavailable): the plan's words.
  if (code === "brain_unavailable" && (m.brainUnavailable as { code?: unknown } | undefined)?.code === "plan_limit") {
    const plan = params.brain === "Codex" ? "ChatGPT" : "Claude";
    return t("chat.body.plan_limit_wait_unknown", { plan, defaultValue: body });
  }
  // A secret request posted before the body named its agent.
  const anon = code === "secret_request" && typeof params.agent !== "string";
  const shown = busy ? "brain_busy" : signedOut ? "no_ai_signed_out" : anon ? "secret_requestAnon" : code;
  const key = `chat.body.${shown}`;
  // i18next takes the first key that exists: a body with no `…NoComputer` words keeps its own.
  return t(params.computer && !namesComputer ? [`${key}NoComputer`, key] : key, { ...params, defaultValue: body });
}

/**
 * A conversation list's last-message line: a body the server wrote (`meta` from the list, same keys as
 * the message's) in the reader's language, as the chat shows it, on one plain line, never naming a computer; a GIF
 * or a sticker with no text as its word (ADR 0091: the list's `mediaKind`, or a kind its meta carries); else the text
 * as is.
 */
export function previewBody(t: TFunction, text: string, meta: Meta | null, mediaKind?: unknown): string {
  if (!text.trim()) {
    const kind = mediaKindOf(mediaKind) ?? mediaKindOf(meta?.mediaKind) ?? mediaKindOf(meta?.media);
    if (kind) return mediaWord(t, kind);
  }
  if (!meta) return text;
  const shown = serverBody(t, text, meta);
  return shown === text ? text : previewOf(shown);
}
