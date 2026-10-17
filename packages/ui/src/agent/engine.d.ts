/** Types for engine.js (plain JavaScript so the HTML prototypes can import it as is). */

export type AgentColorName = "sky" | "indigo" | "violet" | "rose" | "amber" | "green" | "teal" | "graphite";
export type EyeStyle = "round" | "dots" | "wide" | "happy" | "sleepy";
export type EyeKind = "pill" | "arc" | "lid" | "cup" | "spiral" | "heart" | "star" | "cross" | "ring" | "slant";
export type Expression = "closed" | "happy" | "dizzy" | "heart" | "star" | "cross" | "surprised" | "angry" | "wink";

export interface EyeShape {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: EyeKind;
  /** 0 = left eye, 1 = right eye. */
  side: number;
}

export interface Pose {
  writing?: boolean;
  blink?: boolean;
  /** [dx, dy] in fractions of the body. */
  look?: [number, number];
  /** Pseudo-3D head turn, each in -1..1. */
  turn?: [number, number];
  /** Breath: -1..1 (squash and stretch). */
  squash?: number;
  /** A passing expression that replaces the eye style. */
  expression?: Expression;
}

export interface BodyFrame {
  sx: number;
  sy: number;
  dx: number;
  /** Accessories' parallax shift, in body fractions. */
  head: [number, number];
}

export interface DrawAgentOptions {
  color?: AgentColorName;
  eyes?: EyeStyle;
  pose?: Pose;
  cells?: number;
  deep?: boolean;
  progress?: number;
  withEyes?: boolean;
  /** Draws on the body in its own space (0..s), e.g. accessories. */
  after?: (ctx: Ctx2D, s: number, frame: BodyFrame) => void;
}

/** The 2D context subset the engine draws with (the phone app adapts React Native Skia to it). */
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "roundRect"
  | "clip"
  | "fillRect"
  | "fill"
  | "stroke"
  | "ellipse"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "translate"
  | "scale"
  | "moveTo"
  | "lineTo"
  | "bezierCurveTo"
  | "quadraticCurveTo"
  | "closePath"
>;

export const AGENT_GRADIENTS: Record<AgentColorName, [string, string]>;
export const EYE_COLOR: string;
export const BODY_RADIUS: number;
export const BODY_CUT: number;
export const EYE_X: [number, number];
export const EYE_STYLES: Record<EyeStyle, { w: number; h: number; cy: number; kind?: EyeKind }>;
export const WRITING_EYE: { w: number; h: number; cy: number };
export const EXPRESSIONS: Record<
  Expression,
  { w: number; h: number; cy: number; kind: EyeKind; right?: { w: number; h: number; cy: number; kind: EyeKind } }
>;
export function idlePose(
  t: number,
  seed?: number,
  opts?: { active?: boolean; expressions?: Expression[]; every?: number },
): { turn: [number, number]; blink: boolean; squash: number; expression?: Expression };
export function bodyFrame(pose?: Pose): BodyFrame;

export function rgbOf(hex: string): [number, number, number];
export function mixHex(a: string, b: string, k: number): string;
export function gradientOf(color?: AgentColorName | string): [string, string];
export function bodyTones(color?: AgentColorName | string, deep?: boolean): string[];
export function spriteBody(color?: AgentColorName | string): string;
export function ditherCells(px: number): number;
export function inBody(u: number, v: number): boolean;
export function bodyPath(x?: number, y?: number, s?: number): string;
export function toneAt(x: number, y: number, n: number, turn?: [number, number]): number;
export function bodySvg(color: AgentColorName | string | undefined, n: number, deep?: boolean): string;
export function eyeShapes(style?: EyeStyle | string, pose?: Pose): EyeShape[];
export function drawEyes(ctx: Ctx2D, x: number, y: number, s: number, shapes: EyeShape[], color?: string): void;
export function drawAgent(ctx: Ctx2D, x: number, y: number, s: number, opts?: DrawAgentOptions): void;
export function spriteGrid(n?: number, style?: EyeStyle | string): string[];

export type AccessoryName =
  | "hat"
  | "cap"
  | "headphones"
  | "bow"
  | "crown"
  | "antenna"
  | "headset"
  | "beanie"
  | "party"
  | "flower"
  | "scarf";
export const ACCESSORY_PALETTE: Record<string, string>;
export const ACCESSORIES: Record<AccessoryName, { ox: number; oy: number; rows: string[] }>;
export const ACCESSORY_NAMES: ["none", ...AccessoryName[]];
export const ACCESSORY_REACH: { top: number; left: number; right: number; bottom: number };
export function drawAccessory(
  ctx: Ctx2D,
  s: number,
  name: string,
  frame?: BodyFrame,
  t?: number,
  active?: boolean,
): void;
