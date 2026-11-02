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
 * only what people said after it. `start`: where the turn starts ("You start in …", `prepareAgentCode`), read
 * with "# This turn" so the system text doesn't change with it.
 */
export function computerPrompt(turn: ComputerTurn, start = ""): string {
  const now = [turn.thisTurn?.trim(), start.trim()].filter(Boolean).join("\n\n");
  const body = conversationPrompt(turn);
  return now ? `${now}\n\n${body}` : body;
}

function conversationPrompt(turn: BrainTurn): string {
  const { before, trigger } = withoutTrigger(turn.messages, turn.trigger.trim());
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

/**
 * The conversation without the trigger at its end, which "Now answer this" gives once: the last user message is the
 * trigger itself, or ends with it as its author's part (`[Ana]: …`, marked `(current message)` after others), which
 * is then what "Now answer this" shows, its author kept.
 */
function withoutTrigger(
  messages: BrainTurn["messages"],
  trigger: string,
): { before: BrainTurn["messages"]; trigger: string } {
  const last = messages.at(-1);
  const same = { before: messages, trigger };
  if (last?.role !== "user" || !trigger) return same;
  const content = last.content.trimEnd();
  if (content.trim() === trigger) return { before: messages.slice(0, -1), trigger };
  const tail = `]: ${trigger}`;
  if (!content.endsWith(tail)) return same;
  // The trigger's part starts after the parts before it (joined by a blank line), with its author.
  const sep = content.lastIndexOf("\n\n", content.length - tail.length);
  const part = (sep === -1 ? content : content.slice(sep + 2)).replace(/^\(current message\) /, "");
  if (!/^\[[^\]\n]*\]: /.test(part)) return same;
  const rest = sep === -1 ? "" : content.slice(0, sep).trimEnd();
  return {
    before: rest ? [...messages.slice(0, -1), { ...last, content: rest }] : messages.slice(0, -1),
    trigger: part,
  };
}
