import type { Message } from "../api/types";

/**
 * How a person's conversations look (`chatPrefs` on their membership, on every device). `comfortable` is the original
 * layout (mine in a gray bubble on the right), `left` is one row for everyone, `bubbles` is a chat app's, `compact` puts
 * the time, a small face, the name and the text on one line. Mirrored in packages/engine/src/chat-prefs.ts.
 */
export const CHAT_STYLES = ["comfortable", "left", "bubbles", "compact"] as const;
export type ChatStyle = (typeof CHAT_STYLES)[number];
/** My bubbles in `bubbles`: a light tint of the color, or the solid color. */
export const CHAT_TONES = ["light", "strong"] as const;
export type ChatTone = (typeof CHAT_TONES)[number];
export const CHAT_OPEN_AT = ["latest", "read"] as const;
export type ChatOpenAt = (typeof CHAT_OPEN_AT)[number];

/** Only what the person chose: a key not here follows the defaults below, so they can change for everyone else. */
export interface ChatPrefs {
  channelStyle?: ChatStyle;
  dmStyle?: ChatStyle;
  channelTone?: ChatTone;
  dmTone?: ChatTone;
  openAt?: ChatOpenAt;
}

/** Owner's decision: a channel reads as one log, and in a DM right and left already say who spoke. */
export const DEFAULT_CHANNEL_STYLE: ChatStyle = "left";
export const DEFAULT_DM_STYLE: ChatStyle = "bubbles";
export const DEFAULT_CHAT_TONE: ChatTone = "light";

/**
 * A conversation's vertical rhythm, the web's (`--msg-part-gap`, `--msg-turn-gap`, `--msg-block`) and the phone's:
 * `part` between what stacks inside one group (a message's parts, the next row of the same turn), `turn` between
 * groups, measured from what shows to what shows. `block` is a row's plate past its content, and takes no room.
 */
export const CHAT_RHYTHM: Record<ChatStyle, { part: number; turn: number; block: number }> = {
  left: { part: 8, turn: 20, block: 6 },
  comfortable: { part: 8, turn: 20, block: 6 },
  bubbles: { part: 8, turn: 16, block: 1 },
  compact: { part: 4, turn: 8, block: 1 },
};

/** What a conversation shows. A DM has two speakers; anything with more, or with no one person across, is a channel. */
export function chatLookOf(prefs: ChatPrefs | undefined, dm: boolean): { style: ChatStyle; tone: ChatTone } {
  return dm
    ? { style: prefs?.dmStyle ?? DEFAULT_DM_STYLE, tone: prefs?.dmTone ?? DEFAULT_CHAT_TONE }
    : { style: prefs?.channelStyle ?? DEFAULT_CHANNEL_STYLE, tone: prefs?.channelTone ?? DEFAULT_CHAT_TONE };
}

/** Whether my own rows stand apart on the right. In the others, a row of mine is a row like anyone's. */
export const mineOnRight = (style: ChatStyle) => style === "comfortable" || style === "bubbles";

/** Where a conversation opens the first time it is shown with `unread` messages waiting. */
export const opensAtLastRead = (prefs: ChatPrefs | undefined, unread: number) => prefs?.openAt === "read" && unread > 0;

/** The first message after `lastReadAt` that isn't mine: where the "Novas" line goes. Null: none in what's loaded. */
export function firstUnreadId(
  messages: readonly Pick<Message, "id" | "author" | "createdAt">[],
  lastReadAt: string | null | undefined,
  meId: string | null,
): string | null {
  const after = lastReadAt ? Date.parse(lastReadAt) : -Infinity;
  const first = messages.find(
    (m) => Date.parse(m.createdAt) > after && !(m.author.type === "person" && m.author.id === meId),
  );
  return first?.id ?? null;
}
