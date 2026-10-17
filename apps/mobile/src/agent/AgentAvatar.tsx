import { drawAccessory, drawAgent } from "@agenteschat/ui/agent/engine";
import { Canvas, createPicture, Picture } from "@shopify/react-native-skia";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useReducedMotion } from "@/ui/theme";
import { useFrameTime } from "./live";
import type { AgentLookInput } from "./looks";
import { type AgentMode, agentLayout, poseFor, STILL_T, seedOf } from "./poses";
import { asCtx, compile, RecordingContext } from "./recorder";
import { replay } from "./skia-ctx";

export interface AgentAvatarProps {
  agent: AgentLookInput;
  /** Box size in points (the body sits at the bottom; room above for an accessory). */
  size: number;
  mode?: AgentMode;
  /** false: one still frame (use it in long lists). Default true. */
  live?: boolean;
  /** The agent's name, for screen readers. */
  name?: string;
}

/** One frame of an agent as drawing commands (the engine draws, the recorder keeps the commands). */
export function agentFrame(
  agent: AgentLookInput,
  size: number,
  mode: AgentMode,
  t: number,
  seed: number,
  reduced: boolean,
) {
  const accessory = agent.accessory && agent.accessory !== "none" ? agent.accessory : undefined;
  const box = agentLayout(size, Boolean(accessory));
  const rec = new RecordingContext();
  drawAgent(asCtx(rec), box.x, box.y, box.inner, {
    color: agent.color,
    eyes: agent.eyes,
    cells: box.cells,
    pose: poseFor(mode, t, seed, reduced),
    after:
      box.withAccessory && accessory
        ? (ctx, side, frame) => drawAccessory(ctx, side, accessory, frame, t, mode === "run")
        : undefined,
  });
  return compile(rec.commands);
}

function AgentAvatarView({ agent, size, mode = "idle", live = true, name }: AgentAvatarProps) {
  const reduced = useReducedMotion();
  const { t: tr } = useTranslation();
  const { color, eyes, accessory, id } = agent;
  const seed = useMemo(() => seedOf(id ?? `${color}:${eyes}:${accessory ?? ""}`), [id, color, eyes, accessory]);
  const t = useFrameTime(live && !reduced, STILL_T);
  const picture = useMemo(() => {
    const frame = agentFrame({ color, eyes, accessory }, size, mode, t, seed, reduced);
    return createPicture((canvas) => replay(canvas, frame), { width: size, height: size });
  }, [color, eyes, accessory, size, mode, t, seed, reduced]);
  const label = name
    ? tr(mode === "run" ? "mobile.a11y.agentWorking" : "mobile.a11y.agent", { name })
    : tr("mobile.a11y.agentPlain");
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size }}>
      <Canvas style={{ width: size, height: size }}>
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}

/**
 * An agent, drawn by the shared engine (`@agenteschat/ui/agent/engine`) on a Skia canvas: never any
 * other way. Living agents share one ~25 fps clock; with reduced motion, `live={false}`, an off-screen
 * screen or the app in the background they hold a still frame.
 */
export const AgentAvatar = memo(
  AgentAvatarView,
  (a, b) =>
    a.size === b.size &&
    a.mode === b.mode &&
    a.live === b.live &&
    a.name === b.name &&
    a.agent.color === b.agent.color &&
    a.agent.eyes === b.agent.eyes &&
    a.agent.accessory === b.agent.accessory &&
    a.agent.id === b.agent.id,
);
