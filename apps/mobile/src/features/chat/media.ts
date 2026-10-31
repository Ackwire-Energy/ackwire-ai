import type { Message } from "@agenteschat/client";
import { MEDIA_AFTER_KEY } from "@agenteschat/client/lib/media";

/**
 * GIFs and stickers in a message (ADR 0091), the phone's pure rules: how big a GIF shows, and when the sticker or
 * GIF an agent adds after its own reply reads as part of that reply.
 */

/** The widest a GIF shows in a message (points): bigger than a sticker, never a banner. */
export const MESSAGE_GIF_MAX = 260;
/** The tallest a GIF shows (points): a tall one gets narrower instead of filling the screen. */
export const MESSAGE_GIF_MAX_HEIGHT = 320;
/** A sticker's side in a message (points): bigger than an emoji, smaller than a GIF. */
export const MESSAGE_STICKER = 110;

/**
 * A GIF's box at its own proportions: as wide as the file, up to `MESSAGE_GIF_MAX` and the room the row has
 * (`room`, 0 while not measured yet), never taller than `MESSAGE_GIF_MAX_HEIGHT`. Sizes it doesn't know draw 4:3.
 */
export function gifBox(width: number, height: number, room = 0): { width: number; height: number } {
  const known = width > 0 && height > 0;
  const w = known ? width : 4;
  const h = known ? height : 3;
  const widest = Math.min(MESSAGE_GIF_MAX, room > 0 ? room : MESSAGE_GIF_MAX, known ? w : MESSAGE_GIF_MAX);
  let outW = widest;
  let outH = (widest * h) / w;
  if (outH > MESSAGE_GIF_MAX_HEIGHT) {
    outH = MESSAGE_GIF_MAX_HEIGHT;
    outW = (MESSAGE_GIF_MAX_HEIGHT * w) / h;
  }
  return { width: Math.max(1, Math.round(outW)), height: Math.max(1, Math.round(outH)) };
}

/** The reply an agent's silent sticker or GIF follows (`meta.mediaAfter`), or null for any other message. */
export function mediaAfterOf(meta: Message["meta"]): string | null {
  const after = meta?.[MEDIA_AFTER_KEY];
  return typeof after === "string" ? after : null;
}

/**
 * The sticker or GIF right under the reply it follows, from the same agent: it reads as the end of that reply
 * (grouped under it, whatever the reply carries), never as a message of its own.
 */
export function continuesReply(
  prev: Pick<Message, "id" | "author"> | null | undefined,
  m: Pick<Message, "author" | "meta">,
): boolean {
  const reply = mediaAfterOf(m.meta);
  return Boolean(
    reply && prev && prev.id === reply && prev.author.type === m.author.type && prev.author.id === m.author.id,
  );
}
