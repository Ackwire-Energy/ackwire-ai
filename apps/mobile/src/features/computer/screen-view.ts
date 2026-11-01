/*
 * The camera over the agent's screen and the cursor on it (ADR 0096): in the desktop's own pixels, with `s` the scale
 * from those to points on the phone. Worklets, run on the UI thread by the gestures, and plain functions in the tests.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The desktop's size until the page says (`DESKTOP_SIZE` in the machine protocol). */
export const DEFAULT_DESKTOP: Size = { width: 1280, height: 900 };

/** The closest the view comes: past this a 1280-wide picture only blurs. */
export const MAX_SCALE = 2.4;

/** In control, the view never starts smaller than this much over the whole screen: its targets need the room. */
const CONTROL_ZOOM = 1.25;

/** How near an edge of the view the cursor goes before the view follows it, as a share of the view's short side. */
const FOLLOW_MARGIN = 0.2;

/** Trackpad points a two-finger swipe takes per notch of the wheel. */
export const WHEEL_STEP = 18;

export const clamp = (v: number, min: number, max: number) => {
  "worklet";
  return Math.max(min, Math.min(max, v));
};

/** The whole desktop in the box. */
export const fitScale = (box: Size, desk: Size) => {
  "worklet";
  return Math.min(box.width / desk.width, box.height / desk.height);
};

/** The scale control starts at: the box filled, no bands around the picture. */
export const controlScale = (box: Size, desk: Size) => {
  "worklet";
  const fit = fitScale(box, desk);
  return clamp(Math.max(box.width / desk.width, box.height / desk.height, fit * CONTROL_ZOOM), fit, MAX_SCALE);
};

/** The camera's corner kept on the desktop, centered on any side the box is larger than it. */
export const boundCamera = (x: number, y: number, s: number, box: Size, desk: Size): Point => {
  "worklet";
  const w = box.width / s;
  const h = box.height / s;
  return {
    x: w >= desk.width ? (desk.width - w) / 2 : clamp(x, 0, desk.width - w),
    y: h >= desk.height ? (desk.height - h) / 2 : clamp(y, 0, desk.height - h),
  };
};

/** The camera centered on a desktop position, as far as the desktop goes. */
export const lookAt = (p: Point, s: number, box: Size, desk: Size): Point => {
  "worklet";
  return boundCamera(p.x - box.width / s / 2, p.y - box.height / s / 2, s, box, desk);
};

/** The scale changed to `next` with the desktop point under `focal` (points in the box) staying under it. */
export const zoomCamera = (camera: Point, s: number, next: number, focal: Point, box: Size, desk: Size): Point => {
  "worklet";
  const x = focal.x / s + camera.x;
  const y = focal.y / s + camera.y;
  return boundCamera(x - focal.x / next, y - focal.y / next, next, box, desk);
};

/** The desktop position under a point in the box. */
export const toDesktop = (p: Point, camera: Point, s: number, desk: Size): Point => {
  "worklet";
  return { x: clamp(p.x / s + camera.x, 0, desk.width), y: clamp(p.y / s + camera.y, 0, desk.height) };
};

/**
 * Desktop pixels per trackpad point: slow moves aim, fast ones travel (`speed` in points per millisecond), and closer
 * in the same swipe covers less of the desktop, so a swipe always feels the same size on the screen.
 */
export const cursorGain = (speed: number, s: number) => {
  "worklet";
  return (1.1 + (2.3 * Math.min(speed, 1.6)) / 1.6) * (0.4 / s);
};

/** The camera moved just enough to keep the cursor inside the view's margin. */
export const followCursor = (camera: Point, s: number, cursor: Point, box: Size, desk: Size): Point => {
  "worklet";
  const margin = Math.min(box.width, box.height) * FOLLOW_MARGIN;
  const px = (cursor.x - camera.x) * s;
  const py = (cursor.y - camera.y) * s;
  let { x, y } = camera;
  if (px < margin) x -= (margin - px) / s;
  else if (px > box.width - margin) x += (px - box.width + margin) / s;
  if (py < margin) y -= (margin - py) / s;
  else if (py > box.height - margin) y += (py - box.height + margin) / s;
  return boundCamera(x, y, s, box, desk);
};
