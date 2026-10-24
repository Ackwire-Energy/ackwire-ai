import type { BrainTurn } from "./types";

/**
 * A turn as a computer brain gets it: `thisTurn` is the "# This turn" block (ADR 0053 §10), what is true
 * for this turn only (the time, why it was called, where it is, memory and wiki found for the trigger,
 * a routine's time line). Its system prompt holds only what doesn't change during its session.
 */
export type ComputerTurn = BrainTurn & { thisTurn?: string };

/**
 * What a computer brain (Claude Code, Codex) reads this turn. Every turn starts
 * with "# This turn", so a live process or a resumed session never acts on the
 * time or the place it was started with. Then a new session gets the
 * conversation so far (the system text goes separately) and the trigger; a
 * resumed session already has everything up to its own last reply, so it gets
 * only what people said after it.
 */
export function computerPrompt(turn: ComputerTurn): string {
  const now = turn.thisTurn?.trim();
  const body = conversationPrompt(turn);
  return now ? `${now}\n\n${body}` : body;
}

function conversationPrompt(turn: BrainTurn): string {
  const messages = turn.messages;
  const trigger = turn.trigger.trim();
  const last = messages[messages.length - 1];
  const before = last && last.role === "user" && last.content.trim() === trigger ? messages.slice(0, -1) : messages;
  const render = (m: { role: string; content: string }) => `${m.role === "user" ? "User" : "You"}: ${m.content}`;
  if (turn.session?.resume) {
    let i = before.length;
    while (i > 0 && before[i - 1]?.role === "user") i--;
    const fresh = before.slice(i);
    if (!fresh.length) return trigger;
    return `New messages since your last reply:\n\n${fresh.map(render).join("\n\n")}\n\nNow answer this:\n\n${trigger}`;
  }
  if (!before.length) return trigger;
  return `The conversation so far:\n\n${before.map(render).join("\n\n")}\n\nNow answer this:\n\n${trigger}`;
}
