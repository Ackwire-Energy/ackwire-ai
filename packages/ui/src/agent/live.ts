/**
 * Living agents: one shared loop draws every agent avatar on screen from the
 * agent engine (engine.js). Only visible avatars are drawn (about 24 times a
 * second); with reduced motion each one is drawn once, still. A page can set a
 * gaze point (the landing's pointer): avatars inside an element marked
 * `data-gaze` turn their heads toward it.
 */
import { ACCESSORY_REACH, type DrawAgentOptions, drawAccessory, drawAgent, idlePose, type Pose } from "./engine.js";

export interface LiveAgent {
  canvas: HTMLCanvasElement;
  /** The avatar's box (the body), for size and gaze. */
  box: HTMLElement;
  /** Read each frame: what to draw. */
  look: () => {
    color?: DrawAgentOptions["color"];
    eyes?: DrawAgentOptions["eyes"];
    accessory?: string;
    state: "idle" | "thinking" | "writing";
    expression?: Pose["expression"];
    seed: number;
  };
}

const agents = new Set<LiveAgent>();
const visible = new WeakSet<HTMLElement>();
let raf = 0;
let last = 0;
let gaze: { x: number; y: number } | null = null;
let observer: IntersectionObserver | null = null;

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;

/** The current gaze point (client coordinates), if a page set one. */
export function getGaze() {
  return gaze;
}

/** Where avatars inside `[data-gaze]` look (client coordinates), or null to let them wander. */
export function setGaze(point: { x: number; y: number } | null) {
  gaze = point;
}

/** In the app expressions are rare (one every ~18 s per agent); thinking speeds the head up. */
function poseFor(a: ReturnType<LiveAgent["look"]>, t: number, box: HTMLElement, gazing: boolean): Pose {
  if (a.state === "writing") return { writing: true, turn: [Math.sin(t * 1.3 + a.seed) * 0.15, 0.1] };
  const pose: Pose = idlePose(t, a.seed, { active: a.state === "thinking", every: 18 });
  if (a.state === "thinking") pose.expression = undefined;
  if (a.expression) pose.expression = a.expression;
  if (gazing && gaze && a.state !== "thinking") {
    const r = box.getBoundingClientRect();
    const k = (v: number) => Math.max(-1, Math.min(1, v));
    pose.turn = [k((gaze.x - (r.left + r.width / 2)) / 380), k((gaze.y - (r.top + r.height / 2)) / 300)];
  }
  return pose;
}

/** Draws one agent now (sizes the canvas to the box, with room for accessories). */
export function drawLive(agent: LiveAgent, t: number) {
  const { canvas, box } = agent;
  const size = box.clientWidth;
  if (!size) return;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return;
  }
  if (!ctx) return;
  const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const R = ACCESSORY_REACH;
  const w = Math.round(size * (1 + R.left + R.right) * dpr);
  const h = Math.round(size * (1 + R.top + R.bottom) * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  const look = agent.look();
  const s = size * dpr;
  const gazing = !!gaze && !!box.closest("[data-gaze]");
  const pose = poseFor(look, reduced() ? 0 : t, box, gazing);
  drawAgent(ctx, R.left * s, R.top * s, s, {
    color: look.color,
    eyes: look.eyes,
    pose,
    cells: size <= 28 ? 8 : 16,
    after: look.accessory
      ? (g, side, frame) => drawAccessory(g, side, look.accessory as string, frame, t, look.state === "thinking")
      : undefined,
  });
}

function tick(now: number) {
  raf = 0;
  if (now - last >= 40) {
    last = now;
    const t = now / 1000;
    for (const a of agents) if (visible.has(a.box)) drawLive(a, t);
  }
  if (agents.size && !reduced()) raf = requestAnimationFrame(tick);
}

/** Starts drawing an agent; returns the cleanup. */
export function addLiveAgent(agent: LiveAgent): () => void {
  agents.add(agent);
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target as HTMLElement);
        else visible.delete(e.target as HTMLElement);
      }
    });
    observer.observe(agent.box);
  } else visible.add(agent.box);
  drawLive(agent, typeof performance === "object" ? performance.now() / 1000 : 0);
  if (!raf && !reduced() && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
  return () => {
    agents.delete(agent);
    observer?.unobserve(agent.box);
    visible.delete(agent.box);
  };
}
