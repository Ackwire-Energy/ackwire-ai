/** Types for engine.js (plain JavaScript so the HTML prototypes can import it as is). */

export type AgentColorName = "sky" | "indigo" | "violet" | "rose" | "amber" | "green" | "teal" | "graphite";
export type EyeStyle = "round" | "dots" | "wide" | "happy" | "sleepy";
export type EyeKind = "pill" | "arc" | "lid";

export interface EyeShape {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: EyeKind;
}

export interface Pose {
  writing?: boolean;
  blink?: boolean;
  /** [dx, dy] in fractions of the body. */
  look?: [number, number];
}

export interface DrawAgentOptions {
  color?: AgentColorName;
  eyes?: EyeStyle;
  pose?: Pose;
  cells?: number;
  deep?: boolean;
  progress?: number;
  withEyes?: boolean;
}

type Ctx2D = Pick<
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
>;

export const AGENT_GRADIENTS: Record<AgentColorName, [string, string]>;
export const EYE_COLOR: string;
export const BODY_RADIUS: number;
export const BODY_CUT: number;
export const EYE_X: [number, number];
export const EYE_STYLES: Record<EyeStyle, { w: number; h: number; cy: number; kind?: EyeKind }>;
export const WRITING_EYE: { w: number; h: number; cy: number };

export function rgbOf(hex: string): [number, number, number];
export function mixHex(a: string, b: string, k: number): string;
export function gradientOf(color?: AgentColorName | string): [string, string];
export function bodyTones(color?: AgentColorName | string, deep?: boolean): string[];
export function spriteBody(color?: AgentColorName | string): string;
export function ditherCells(px: number): number;
export function inBody(u: number, v: number): boolean;
export function bodyPath(x?: number, y?: number, s?: number): string;
export function toneAt(x: number, y: number, n: number): number;
export function bodySvg(color: AgentColorName | string | undefined, n: number, deep?: boolean): string;
export function eyeShapes(style?: EyeStyle | string, pose?: Pose): EyeShape[];
export function drawEyes(ctx: Ctx2D, x: number, y: number, s: number, shapes: EyeShape[], color?: string): void;
export function drawAgent(ctx: Ctx2D, x: number, y: number, s: number, opts?: DrawAgentOptions): void;
export function spriteGrid(n?: number, style?: EyeStyle | string): string[];
