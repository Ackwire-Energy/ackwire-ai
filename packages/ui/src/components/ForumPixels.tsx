import { type MouseEvent, useMemo, useRef } from "react";
import { bodyTones, mixHex } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor } from "./AgentLook";
import { BAYER, column, reduced, spriteOf, token, useCanvas } from "./RunPixels";

/**
 * The forum's pixel pieces (telas/Forum.html), on the same grid and helpers
 * as the routines' runs: the round track (rounds × seats), the stance lane of
 * one agent and the convergence blocks. The canvases are decorative: the
 * caller gives the words (`label`) and, for the big track, what a column is
 * (`describe`, shown as the title while hovering) and where a click goes.
 */
export type ForumTrackKind =
  /** An agent's turn, spoken: a dithered column in its tones, as tall as the post. */
  | "spoke"
  /** A person's free post that leads the round: a narrow neutral column. */
  | "person"
  /** A seated person's turn, spoken: a neutral column. */
  | "seat"
  /** A seated person passed (or the turn went by): a flat stub. */
  | "passed"
  /** The round waits for a seated person: a blinking neutral pixel. */
  | "waiting"
  /** A seated person's turn to come: a neutral pixel. */
  | "seatPending"
  /** The synthesis: a wide full-height block in the writer's deep tones, with a check. */
  | "synthesis"
  /** Writing now: the agent itself, a 9×9 sprite with dash eyes. */
  | "live"
  /** The turn that stopped: the sprite, eyes closed. */
  | "sleep"
  /** No turn (the round ended early, not chosen): a short warm stub. */
  | "skipped"
  /** Skipped: the agent's own budget was out. Same warm stub, a step taller. */
  | "budget"
  /** To come: one pixel on the line in the agent's light tone. */
  | "pending";

export interface ForumTrackItem {
  kind: ForumTrackKind;
  round: number;
  agentId?: string;
  userId?: string;
  postId: string | null;
  /** Characters (column height). */
  length: number;
  /** The agent's look (agents' items). */
  color?: string;
  eyes?: string;
  /** The synthesis' item (live, done or stopped). */
  synthesis?: boolean;
}

export type TrackSize = "mini" | "mid" | "big";
export const TRACK_SIZES: Record<
  TrackSize,
  { cell: number; colW: number; gap: number; rgap: number; rows: number; personW: number; synthW: number }
> = {
  mini: { cell: 2, colW: 3, gap: 1, rgap: 4, rows: 12, personW: 2, synthW: 5 },
  mid: { cell: 3, colW: 3, gap: 1, rgap: 4, rows: 12, personW: 2, synthW: 5 },
  big: { cell: 4, colW: 5, gap: 2, rgap: 9, rows: 15, personW: 3, synthW: 9 },
};

export interface TrackLayoutItem extends ForumTrackItem {
  x: number;
  w: number;
}
export interface TrackLayout {
  groups: { round: number; x0: number; x1: number; items: TrackLayoutItem[] }[];
  width: number;
  rows: number;
  cell: number;
}

const SPRITE_W = 9;

/** Where each column goes: items side by side, a wider gap between rounds. */
export function layoutTrack(groups: { round: number; items: ForumTrackItem[] }[], size: TrackSize): TrackLayout {
  const Z = TRACK_SIZES[size];
  let x = 0;
  const out: TrackLayout["groups"] = groups.map((g) => {
    const x0 = x;
    const items = g.items.map((it) => {
      const w =
        it.kind === "live" || it.kind === "sleep"
          ? SPRITE_W
          : it.kind === "person" || it.kind === "seat" || it.kind === "passed"
            ? Z.personW
            : it.kind === "synthesis"
              ? Z.synthW
              : Z.colW;
      const item = { ...it, x, w };
      x += w + Z.gap;
      return item;
    });
    const x1 = Math.max(x0, x - Z.gap);
    x += Z.rgap - Z.gap;
    return { round: g.round, x0, x1, items };
  });
  return { groups: out, width: Math.max(4, x - Z.rgap + Z.gap), rows: Z.rows, cell: Z.cell };
}

/** The column under `u` (track pixels), or null. */
export function trackItemAt(layout: TrackLayout, u: number): TrackLayoutItem | null {
  for (const g of layout.groups) for (const it of g.items) if (u >= it.x - 0.5 && u <= it.x + it.w + 0.5) return it;
  return null;
}

const toneOf = (c?: string) => bodyTones((c ?? "sky") as AgentColor);
const tone = (list: string[], i: number) => list[i] ?? "#888888";

/** The agent as a 9×9 sprite standing on `base`: writing (dash eyes, a small hop) or asleep (closed eyes). */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  cx0: number,
  base: number,
  color: string | undefined,
  eyes: string | undefined,
  t: number,
  mode: "run" | "sleep",
  seed: number,
) {
  const tones = toneOf(color);
  const g = spriteOf(eyes || "round");
  const eyeRows = g.map((r, y) => (r.includes("o") ? y : -1)).filter((y) => y >= 0);
  const mid = eyeRows[Math.floor(eyeRows.length / 2)] ?? 4;
  const low = eyeRows.at(-1) ?? 4;
  const still = reduced();
  const hop = mode === "run" && !still && (t * 1.6 + seed) % 2.4 < 0.3 ? 1 : 0;
  const top = base - 8 - hop;
  g.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === ".") continue;
      if (c === "o") {
        if (mode === "run") ctx.fillStyle = y === mid ? "#ffffff" : tone(tones, 1);
        else ctx.fillStyle = y === low ? mixHex("#ffffff", tone(tones, 2), 0.35) : tone(tones, 1);
      } else {
        const s = (1 - y / 8) * 3;
        const b = Math.floor(s);
        ctx.fillStyle = tone(tones, Math.min(4, 1 + (s - b > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? b + 1 : b)));
      }
      ctx.fillRect(cx0 - 4 + x, top + y, 1, 1);
    }
  });
}

/**
 * The round track: rounds × seats. Spoken turns are dithered columns in the
 * agent's tones (height ~ the post's length), the turn in progress is the
 * agent itself, turns to come single pixels, skipped ones warm stubs, people
 * neutral, and the synthesis a wide block at the end. `big` fills its width
 * (up to its natural size) and is clickable; `mini` / `mid` have a fixed size.
 */
export function RoundTrack({
  groups,
  size = "mini",
  dim = false,
  label,
  describe,
  onPick,
  className,
}: {
  groups: { round: number; items: ForumTrackItem[] }[];
  size?: TrackSize;
  /** Canceled: everything fades toward the surface. */
  dim?: boolean;
  label: string;
  /** The words for a column (big track: the hover title). */
  describe?: (item: ForumTrackItem) => string;
  /** A column was clicked (big track). */
  onPick?: (item: ForumTrackItem) => void;
  className?: string;
}) {
  const L = useMemo(() => layoutTrack(groups, size), [groups, size]);
  const hover = useRef<TrackLayoutItem | null>(null);
  const moving = groups.some((g) => g.items.some((it) => it.kind === "live" || it.kind === "waiting"));
  const seed = groups.length;
  const ref = useCanvas(
    (ctx, canvas, t) => {
      if (canvas.width !== L.width) canvas.width = L.width;
      if (canvas.height !== L.rows) canvas.height = L.rows;
      const ink = token(canvas, "--ink", "#151514");
      const raised = token(canvas, "--raised", "#ffffff");
      const warn = token(canvas, "--warn", "#9a5b00");
      const fade = (c: string) => (dim ? mixHex(c, raised, 0.55) : c);
      const base = L.rows - 2;
      ctx.clearRect(0, 0, L.width, L.rows);
      for (let x = 0; x < L.width; x += 2) {
        ctx.fillStyle = mixHex(ink, raised, 0.86);
        ctx.fillRect(x, base + 1, 1, 1);
      }
      const neutral = [mixHex(ink, raised, 0.2), mixHex(ink, raised, 0.45), mixHex(ink, raised, 0.65)].map(fade);
      for (const g of L.groups)
        for (const it of g.items) {
          const tones = toneOf(it.color);
          const hl = hover.current === it;
          const mid = it.x + Math.floor(it.w / 2);
          switch (it.kind) {
            case "spoke": {
              const h = Math.max(3, Math.min(base, Math.round(3 + (it.length / 330) * (base - 4))));
              const pal = hl
                ? [tone(tones, 2), tone(tones, 3), tone(tones, 4)]
                : [tone(tones, 1), tone(tones, 2), tone(tones, 3)];
              column(ctx, it.x, it.w, h, base, pal.map(fade));
              break;
            }
            case "person":
              column(ctx, it.x, it.w, Math.max(3, Math.min(base - 2, Math.round(2 + it.length / 40))), base, neutral);
              break;
            case "seat":
              column(ctx, it.x, it.w, Math.max(3, Math.min(base - 1, Math.round(3 + it.length / 36))), base, neutral);
              break;
            case "passed":
              ctx.fillStyle = fade(mixHex(ink, raised, 0.55));
              ctx.fillRect(it.x, base, it.w, 1);
              break;
            case "waiting":
              if (reduced() || Math.floor(t * 2.2) % 2 === 0) {
                ctx.fillStyle = ink;
                ctx.fillRect(mid, base, 1, 1);
                ctx.fillRect(mid, base - 1, 1, 1);
              }
              break;
            case "seatPending":
              ctx.fillStyle = mixHex(ink, raised, 0.6);
              ctx.fillRect(mid, base, 1, 1);
              break;
            case "synthesis": {
              const deep = bodyTones((it.color ?? "sky") as AgentColor, true);
              column(
                ctx,
                it.x,
                it.w,
                base + 1,
                base,
                [tone(deep, 1), tone(deep, 2), tone(deep, 3), tone(deep, 4)].map(fade),
              );
              // A check of eye-white pixels on the block.
              const cy = Math.round(base * 0.45);
              ctx.fillStyle = "#ffffff";
              for (const [dx, dy] of [
                [-2, 0],
                [-1, 1],
                [0, 2],
                [1, 1],
                [2, 0],
                [3, -1],
              ] as const)
                if (mid + dx >= it.x && mid + dx < it.x + it.w) ctx.fillRect(mid + dx, cy + dy, 1, 1);
              break;
            }
            case "live":
              drawSprite(ctx, it.x + 4, base, it.color, it.eyes, t, "run", seed);
              break;
            case "sleep":
              drawSprite(ctx, it.x + 4, base, it.color, it.eyes, t, "sleep", seed);
              break;
            case "skipped":
            case "budget":
              ctx.fillStyle = fade(mixHex(warn, raised, 0.3));
              ctx.fillRect(mid, base, 1, 1);
              ctx.fillRect(mid, base - 1, 1, 1);
              if (it.kind === "budget") ctx.fillRect(mid, base - 2, 1, 1);
              break;
            default:
              ctx.fillStyle = fade(mixHex(tone(tones, 3), raised, 0.25));
              ctx.fillRect(mid, base, 1, 1);
          }
        }
    },
    moving || size === "big",
  );
  const big = size === "big";
  const at = (e: MouseEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const u = (e.nativeEvent.offsetX / (el.clientWidth || 1)) * L.width;
    return trackItemAt(L, u);
  };
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      className={cx("ac-round-track", big && "ac-round-track--big", onPick && "is-clickable", className)}
      width={L.width}
      height={L.rows}
      style={
        big
          ? { width: "100%", maxWidth: L.width * L.cell, aspectRatio: `${L.width} / ${L.rows}` }
          : { width: L.width * L.cell, height: L.rows * L.cell }
      }
      onMouseMove={
        big
          ? (e) => {
              const it = at(e);
              hover.current = it;
              e.currentTarget.title = it && describe ? describe(it) : "";
            }
          : undefined
      }
      onMouseLeave={
        big
          ? () => {
              hover.current = null;
            }
          : undefined
      }
      onClick={
        big && onPick
          ? (e) => {
              const it = at(e);
              if (it) onPick(it);
            }
          : undefined
      }
    />
  );
}

/** A round's label positions under the big track (left and width in %). */
export function roundLabelBoxes(layout: TrackLayout) {
  return layout.groups.map((g) => ({
    round: g.round,
    left: (g.x0 / layout.width) * 100,
    width: (Math.max(1, g.x1 - g.x0) / layout.width) * 100,
    narrow: g.x1 - g.x0 < 18,
  }));
}

/**
 * One agent's stance, round by round: a block up (for the proposal), in the
 * middle (a question) or down (against), joined by a thin step when it moves;
 * the round it is writing flickers in the middle; no post is a dot.
 */
export function StanceLane({
  lane,
  color = "sky",
  label,
  className,
}: {
  lane: (0 | 1 | 2 | "live" | null)[];
  color?: AgentColor;
  label: string;
  className?: string;
}) {
  const n = Math.max(1, lane.length);
  const W = n * 7 - 2;
  const H = 11;
  const moving = lane.includes("live");
  const ref = useCanvas((ctx, canvas, t) => {
    const ink = token(canvas, "--ink", "#151514");
    const raised = token(canvas, "--raised", "#ffffff");
    const tones = bodyTones(color);
    ctx.clearRect(0, 0, W, H);
    for (let x = 0; x < W; x += 2) {
      ctx.fillStyle = mixHex(ink, raised, 0.88);
      ctx.fillRect(x, 5, 1, 1);
    }
    let prev: number | null = null;
    lane.forEach((cell, r) => {
      const x0 = r * 7;
      if (typeof cell === "number") {
        const y1 = cell * 4 + 2;
        if (prev !== null && prev !== cell) {
          ctx.fillStyle = mixHex(tone(tones, 3), raised, 0.35);
          const a = Math.min(prev, cell) * 4 + 2;
          const b = Math.max(prev, cell) * 4 + 2;
          for (let y = a; y <= b; y++) ctx.fillRect(x0 - 1, y, 1, 1);
        }
        column(ctx, x0, 5, 3, y1, [tone(tones, 1), tone(tones, 2), tone(tones, 3)]);
        prev = cell;
      } else if (cell === "live") {
        for (let y = 4; y <= 6; y++)
          for (let x = 0; x < 5; x++) {
            if ((x * 7 + y * 13 + Math.floor(t * 10)) % 4 === 0) continue;
            ctx.fillStyle = [tone(tones, 2), tone(tones, 3), tone(tones, 4)][(x + y) % 3] ?? "#888";
            ctx.fillRect(x0 + x, y, 1, 1);
          }
      } else {
        ctx.fillStyle = mixHex(tone(tones, 3), raised, 0.3);
        ctx.fillRect(x0 + 2, 5, 1, 1);
      }
    });
  }, moving);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      className={cx("ac-stance-lane", className)}
      width={W}
      height={H}
      style={{ width: W * 3, height: H * 3 }}
    />
  );
}

/** Convergence: one block per agent; full = for the proposal, half = a question, a stub = not (yet). */
export function Convergence({
  blocks,
  label,
  className,
}: {
  blocks: { color?: AgentColor; level: "for" | "ask" | "none" }[];
  label: string;
  className?: string;
}) {
  const W = Math.max(1, blocks.length * 7 - 1);
  const H = 8;
  const ref = useCanvas((ctx, canvas) => {
    const raised = token(canvas, "--raised", "#ffffff");
    ctx.clearRect(0, 0, W, H);
    blocks.forEach((b, i) => {
      const tones = bodyTones(b.color ?? "sky");
      if (b.level === "for")
        column(ctx, i * 7, 6, 8, 7, [tone(tones, 1), tone(tones, 2), tone(tones, 3), tone(tones, 4)]);
      else if (b.level === "ask") column(ctx, i * 7, 6, 4, 7, [tone(tones, 2), tone(tones, 3)]);
      else column(ctx, i * 7, 6, 1, 7, [mixHex(tone(tones, 3), raised, 0.25)]);
    });
  }, false);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      className={cx("ac-convergence", className)}
      width={W}
      height={H}
      style={{ width: W * 4, height: H * 4 }}
    />
  );
}
