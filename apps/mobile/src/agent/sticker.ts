import { drawSticker, STICKER_STILL_T, type StickerLook, type StickerMood } from "@agenteschat/ui/agent/stickers";
import { asCtx, type CompiledOp, compile, RecordingContext } from "./recorder";

/**
 * One frame of an agent's sticker (ADR 0091) as drawing commands: the shared `drawSticker` draws with the engine's
 * 2D subset, the recorder keeps it, and `replay` (./skia-ctx.ts) draws it on a Skia canvas, as agents' avatars are.
 * The phone shows the still frame (`STICKER_STILL_T`): animated stickers here wait for the engine's loop on Skia
 * (ADR 0091, Consequences). Pure: no React Native, no Skia, so it runs in `bun test`.
 */
export function stickerFrame(look: StickerLook, mood: StickerMood, size: number, t = STICKER_STILL_T): CompiledOp[] {
  const rec = new RecordingContext();
  drawSticker(asCtx(rec), look, mood, t, size);
  return compile(rec.commands);
}
