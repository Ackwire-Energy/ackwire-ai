import { STICKER_STILL_T, type StickerLook, type StickerMood, stickerSeed } from "@agenteschat/ui/agent/stickers";
import { Canvas, createPicture, Picture } from "@shopify/react-native-skia";
import { createContext, memo, useContext, useMemo, useSyncExternalStore } from "react";
import { useReducedMotion } from "@/ui/theme";
import { useFrameTime } from "./live";
import { replay } from "./skia-ctx";
import { STICKER_FPS, stickerFrame } from "./sticker";
import type { StickerStage } from "./sticker-stage";

/** The stage of the list the stickers are in (none: they stand still). */
export const StickerStageContext = createContext<StickerStage | null>(null);

const noStage = () => () => undefined;

/** Whether the sticker that goes by `id` on its list's stage may play now. */
export function useStickerLive(id: string | undefined): boolean {
  const stage = useContext(StickerStageContext);
  return useSyncExternalStore(stage?.subscribe ?? noStage, () => Boolean(stage && id && stage.isLive(id)));
}

/** `useFrameTime`'s answer while not playing: never a moment of the clock. */
const STOPPED = -1;

function StickerCanvasView({
  look,
  mood,
  size,
  seed,
  live,
}: {
  look: StickerLook;
  mood: StickerMood;
  size: number;
  /** Keeps stickers side by side out of step: the agent's id. */
  seed: string;
  live: boolean;
}) {
  const reduced = useReducedMotion();
  const t = useFrameTime(live && !reduced, STOPPED, STICKER_FPS);
  const { color, eyes, accessory } = look;
  const picture = useMemo(() => {
    const at = t === STOPPED ? STICKER_STILL_T : t + stickerSeed(seed);
    const ops = stickerFrame({ color, eyes, accessory }, mood, size, at);
    return createPicture((canvas) => replay(canvas, ops), { width: size, height: size });
  }, [color, eyes, accessory, mood, size, seed, t]);
  return (
    <Canvas style={{ width: size, height: size }}>
      <Picture picture={picture} />
    </Canvas>
  );
}

/**
 * An agent's sticker on a Skia canvas, drawn by the shared agent engine: never any other way. While `live` it plays
 * on the one frame clock, at `STICKER_FPS`, its seed keeping it out of step with its neighbors; with reduced motion,
 * on a screen that isn't showing or with the app in the background it holds its still frame.
 */
export const StickerCanvas = memo(
  StickerCanvasView,
  (a, b) =>
    a.mood === b.mood &&
    a.size === b.size &&
    a.seed === b.seed &&
    a.live === b.live &&
    a.look.color === b.look.color &&
    a.look.eyes === b.look.eyes &&
    a.look.accessory === b.look.accessory,
);
