import { type Expression, idlePose, type Pose } from "@agenteschat/ui/agent/engine";

/**
 * How an agent looks in each state (Mobile.html `poseFor`): pure, so tests can check it.
 * - idle: looks around, blinks, now and then a happy face or a wink;
 * - run: working, the eyes are short dashes (words arriving);
 * - think: looks up and aside;
 * - rest: eyes closed, breathing slowly.
 */
export type AgentMode = "idle" | "run" | "think" | "rest";

const IDLE_EXPRESSIONS: Expression[] = ["happy", "wink"];

export function poseFor(mode: AgentMode, t: number, seed: number, reduced = false): Pose {
  if (mode === "run") return { ...idlePose(t, seed, { active: true, expressions: [] }), writing: true };
  if (mode === "think") {
    const p = idlePose(t, seed, { every: 99, expressions: [] });
    const g = Math.sin(t * 0.6 + seed);
    return { ...p, turn: [g * 0.45, -0.3], look: [g * 0.12, -0.14] };
  }
  if (mode === "rest")
    return { expression: "closed", turn: [0, 0.15], squash: reduced ? 0 : Math.sin(t * 1.1 + seed) * 0.3 };
  return idlePose(t, seed, { every: 12, expressions: IDLE_EXPRESSIONS });
}

/** A stable seed per agent (keeps several agents out of step), from any string such as its id. */
export function seedOf(key: string): number {
  let s = 0;
  for (let i = 0; i < key.length; i++) s = (s + key.charCodeAt(i) * (i + 1)) % 997;
  return (s % 7) + (s % 100) / 100;
}

/** The still frame used with reduced motion and in long lists (the prototype draws t = 2). */
export const STILL_T = 2;

/**
 * Where the body sits in an avatar box of `size` (Mobile.html `drawLive`): smaller with an accessory
 * so a hat fits, bottom-aligned; fewer dither cells at small sizes.
 */
export function agentLayout(size: number, hasAccessory: boolean) {
  const withAccessory = hasAccessory && size >= 26;
  const inner = size * (withAccessory ? 0.74 : 0.86);
  return {
    x: (size - inner) / 2,
    y: size - inner,
    inner,
    withAccessory,
    cells: size <= 18 ? 9 : size <= 32 ? 12 : undefined,
  };
}

/**
 * Inside a framed tile (the web's `drawFramed`, telas/RefinoUI.html "Céu"): the agent stands centered,
 * feet near the bottom edge, smaller with an accessory so it has room above (accessories from 26pt).
 */
export function framedLayout(size: number, hasAccessory: boolean) {
  const withAccessory = hasAccessory && size >= 26;
  const inner = size * (withAccessory ? 0.6 : 0.66);
  return {
    x: (size - inner) / 2,
    y: size - inner - size * (withAccessory ? 0.1 : 0.14),
    inner,
    withAccessory,
    cells: size <= 32 ? 12 : undefined,
  };
}

/** Framed by default, like the web: not the tiny receipt faces nor the big hero, which stand on their own. */
export const framedByDefault = (size: number) => size >= 20 && size < 64;
