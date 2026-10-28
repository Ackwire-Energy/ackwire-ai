import { type Message, type MessageReceipt, type ReceiptPhase, receiptView } from "@agenteschat/client";
import { isEventLine } from "@agenteschat/client/lib/notices";

/**
 * The agents' receipt under a person's message, the phone's way: one quiet line under the latest one (the
 * web marks every message with a check and a popover). Faces of the agents it is about, a small mark, and
 * words only where the faces and the live rows can't say it: who saw it, a wait, a failure, nobody or no AI,
 * and while the author's own plan picks who answers. While an agent answers, its block at the end and the line
 * above the box already say so, and once they answered the reply is right there: then only the faces and the
 * mark. Pure, so it is tested; the state itself is the shared `receipts.ts` (seeded from the lists, moved by the
 * channel's events).
 */

/** The small mark before the words: a check (seen, answered), the orbit (on it), paused, a question, the clock, none. */
export type ReceiptMark = "seen" | "working" | "waiting" | "asking" | "done" | "picking" | "none";

export interface ReceiptLine {
  /** The agents whose faces show (at most `FACES`), and how many more there are. */
  faces: string[];
  more: number;
  mark: ReceiptMark;
  /** The words, an i18n key and the agents it names (`names` / `count`); null: faces and the mark only. */
  words: { key: ReceiptWords; agents: string[] } | null;
  /** The words for a screen reader when the line shows none (`receipts.picked`, …). */
  label: { key: ReceiptWords; agents: string[] };
  /** What a tap on the line's own button does: send it again, or connect an AI. */
  action: "retry" | "connect" | null;
  /** A failure or no AI reads in the danger tone. */
  alert: boolean;
}

export type ReceiptWords =
  | "receipts.seenBy"
  | "receipts.picked"
  | "receipts.claimed"
  | "receipts.waiting"
  | "receipts.asking"
  | "receipts.handled"
  | "receipts.failed"
  | "receipts.nobody"
  | "receipts.platformCap"
  | "receipts.mentionNeeded"
  | "receipts.picking"
  | "noAi.receipt";

export const FACES = 3;

const faces = (ids: string[]) => ({ faces: ids.slice(0, FACES), more: Math.max(0, ids.length - FACES) });

/** What the line under a person's message shows, or null when there is nothing to say yet. */
export function receiptLine(receipt: MessageReceipt | undefined): ReceiptLine | null {
  const view = receiptView(receipt);
  const status = view.status;
  if (view.picking) {
    const words = { key: "receipts.picking" as const, agents: [] };
    return { faces: [], more: 0, mark: "picking", words, label: words, action: null, alert: false };
  }
  if (view.seen.length === 0 && status?.kind !== "no_ai" && status?.kind !== "platform_cap") return null;
  if (status === null) {
    const words = { key: "receipts.seenBy" as const, agents: view.seen };
    return { ...faces(view.seen), mark: "seen", words, label: words, action: null, alert: false };
  }
  switch (status.kind) {
    case "picked":
    case "claimed": {
      const label = { key: `receipts.${status.kind}` as const, agents: status.agents };
      return { ...faces(status.agents), mark: "working", words: null, label, action: null, alert: false };
    }
    case "handled": {
      const label = { key: "receipts.handled" as const, agents: status.agents };
      return { ...faces(status.agents), mark: "done", words: null, label, action: null, alert: false };
    }
    case "waiting":
    case "asking": {
      const words = { key: `receipts.${status.kind}` as const, agents: status.agents };
      return { ...faces(status.agents), mark: status.kind, words, label: words, action: null, alert: false };
    }
    case "failed": {
      const words = { key: "receipts.failed" as const, agents: status.agents };
      return { ...faces(status.agents), mark: "none", words, label: words, action: "retry", alert: true };
    }
    case "nobody": {
      const key = status.mentionNeeded ? ("receipts.mentionNeeded" as const) : ("receipts.nobody" as const);
      const words = { key, agents: [] };
      return { faces: [], more: 0, mark: "none", words, label: words, action: null, alert: false };
    }
    case "platform_cap": {
      const words = { key: "receipts.platformCap" as const, agents: [] };
      return { faces: [], more: 0, mark: "none", words, label: words, action: null, alert: false };
    }
    case "no_ai": {
      const words = { key: "noAi.receipt" as const, agents: [] };
      return { ...faces(status.agents), mark: "none", words, label: words, action: "connect", alert: true };
    }
  }
}

/**
 * The line gives way to the steer line ("Theo leu", "lê na próxima pausa"), which says more about a message
 * that went into a task at work; only what asks for a tap (send again, connect an AI) still shows.
 */
export const receiptShows = (line: ReceiptLine | null, steered: boolean): line is ReceiptLine =>
  line !== null && (!steered || line.action !== null);

/** The message the line goes under: the latest person's message on screen that the server has. */
export function receiptMessageId(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.author.type !== "person" || m.local || isEventLine(m.meta)) continue;
    return m.id;
  }
  return null;
}

/** Each agent's line in the sheet: its phase, "only mentioned" for one the message just names. */
export type ReceiptRowPhase = ReceiptPhase | "referenced";

export function receiptRows(receipt: MessageReceipt | undefined): { agentId: string; phase: ReceiptRowPhase }[] {
  const view = receiptView(receipt);
  const phases = new Map<string, ReceiptPhase>(receipt?.agents ?? []);
  return view.seen.map((agentId) => {
    const phase = phases.get(agentId) ?? "seen";
    return { agentId, phase: phase === "seen" && view.referenced.includes(agentId) ? "referenced" : phase };
  });
}

/** The i18n key of an agent's phase in the sheet. */
export const phaseKey = (phase: ReceiptRowPhase) => (phase === "no_ai" ? "noAi.chip" : `receipts.status.${phase}`);
