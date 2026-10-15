import {
  ACCESSORY_REACH,
  type AgentAppearance,
  type AgentState,
  Avatar,
  Chip,
  cx,
  drawAccessory,
  drawAgent,
  getGaze,
  idlePose,
  type Pose,
} from "@agenteschat/ui";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanding } from "./context";
import { AGENTS, type AgentKey, GIANT_LOOKS, PEOPLE } from "./data";
import { useFormat } from "./format";
import { useAimRef } from "./hooks";
import { LpAvatar, SampleAgent } from "./LpAvatar";
import { PixelSky } from "./PixelSky";
import { RichText } from "./rich";
import { HERO_SKY } from "./sky";

/** The hero: the sky, the headline, the waiting list, the giant agent and its activity bubbles. */
export function Hero({
  giantLook,
  giantState,
  giantJoy,
  onGiantClick,
  waitlist,
  waitlistRef,
}: {
  giantLook: number;
  giantState: AgentState;
  giantJoy: string;
  onGiantClick: () => void;
  /** The hero waiting list form. */
  waitlist: ReactNode;
  waitlistRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const chip = useRef<HTMLSpanElement>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  const lead = useRef<HTMLParagraphElement>(null);
  const calm = useCallback(() => [chip.current, h1.current, lead.current, waitlistRef.current], [waitlistRef]);
  // A light halo of sky behind the giant, so its dither reads against the blue.
  const giantRef = useRef<HTMLButtonElement | null>(null);
  const halo = useCallback(() => [giantRef.current], []);

  let word = 0;
  const words = (text: string) =>
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, i, all) => {
        const delay = 0.05 + word++ * 0.06;
        return (
          <span key={`${w}-${delay}`}>
            <span className="lp-w" style={{ animationDelay: `${delay.toFixed(2)}s` }}>
              {w}
            </span>
            {i < all.length - 1 ? " " : ""}
          </span>
        );
      });
  const titleA = words(t("landing.hero.titleA"));
  const avatarDelay = 0.05 + word++ * 0.06;
  const titleB = words(t("landing.hero.titleB"));

  return (
    <section className="lp-hero">
      <div className="lp-sky">
        <PixelSky options={{ pixel: 4, sprites: true, calmV: 6 / 7, calm, halo, ...HERO_SKY }} />
        <div className="lp-hero-in">
          <div className="lp-hero-col">
            <span className="lp-sky-chip lp-after" ref={chip}>
              <LpAvatar look={{ color: "sky" }} />
              {t("landing.hero.chip")}
            </span>
            <h1 ref={h1}>
              {titleA}{" "}
              <span className="lp-w lp-inline-av" style={{ animationDelay: `${avatarDelay.toFixed(2)}s` }}>
                <LpAvatar look={{ color: "sky" }} />
              </span>
              {titleB}
            </h1>
            <p className="lp-lead lp-after" ref={lead}>
              {t("landing.hero.lead")}
            </p>
            <div className="lp-after">{waitlist}</div>
          </div>
        </div>
        <Giant look={giantLook} state={giantState} joy={giantJoy} onClick={onGiantClick} buttonRef={giantRef} />
      </div>
      <Ticker />
    </section>
  );
}

/* ---------- The giant: the engine's agent, forming from the sky and coming apart into it ---------- */

const CELLS = 26;

type Tween = { from: number; to: number; start: number; dur: number; done: (() => void) | null };
const tweenAt = (a: Tween, now: number) => {
  const k = Math.min(1, (now - a.start) / Math.max(1, a.dur));
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  return a.from + (a.to - a.from) * e;
};

/**
 * Draws the giant from the agent engine on `canvas` (sized to `box`, with room
 * for the accessory): its idle life, states and joy, turned toward the gaze,
 * at `progress` of forming. `play(to, ms, done)` dissolves or forms it.
 */
function useGiant(
  canvas: RefObject<HTMLCanvasElement | null>,
  box: RefObject<HTMLElement | null>,
  live: { look: AgentAppearance; state: AgentState; joy: boolean },
  reduced: boolean,
) {
  const animate = typeof requestAnimationFrame === "function" && !reduced;
  const tween = useRef<Tween>({ from: animate ? 0 : 1, to: animate ? 0 : 1, start: 0, dur: 1, done: null });
  const now$ = useRef(live);
  now$.current = live;
  const draw = useCallback(
    (now: number) => {
      const el = canvas.current;
      const b = box.current;
      if (!el || !b) return;
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = el.getContext("2d");
      } catch {
        return;
      }
      if (!ctx) return;
      const size = b.clientWidth;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const R = ACCESSORY_REACH;
      const w = Math.round(size * (1 + R.left + R.right) * dpr);
      const h = Math.round(size * (1 + R.top + R.bottom) * dpr);
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const { look, state, joy } = now$.current;
      const t = animate ? now / 1000 : 0;
      const pose: Pose =
        state === "writing" ? { writing: true } : idlePose(t, 1.3, { active: state === "thinking", every: 7 });
      if (joy) pose.expression = "happy";
      const gaze = getGaze();
      if (gaze && state === "idle") {
        const r = b.getBoundingClientRect();
        const k = (v: number) => Math.max(-1, Math.min(1, v));
        pose.turn = [k((gaze.x - (r.left + r.width / 2)) / 500), k((gaze.y - (r.top + r.height / 2)) / 400)];
      }
      const s = size * dpr;
      const accessory = look.accessory && look.accessory !== "none" ? look.accessory : undefined;
      drawAgent(ctx, R.left * s, R.top * s, s, {
        color: look.color,
        eyes: look.eyes,
        cells: CELLS,
        deep: true,
        progress: tweenAt(tween.current, now),
        pose,
        after: accessory
          ? (g, side, frame) => drawAccessory(g, side, accessory, frame, t, state === "thinking")
          : undefined,
      });
      const a = tween.current;
      if (a.done && now - a.start >= a.dur) {
        const done = a.done;
        a.done = null;
        done();
      }
    },
    [animate, box, canvas],
  );
  useEffect(() => {
    if (!animate) {
      draw(performance.now());
      return;
    }
    let raf = 0;
    const loop = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate, draw]);
  // Still pages redraw when the look or the state changes.
  useEffect(() => {
    if (!animate) draw(performance.now());
  });
  const play = useCallback(
    (to: number, ms: number, done?: () => void) => {
      const now = performance.now();
      const a = tween.current;
      if (!animate) {
        a.from = to;
        a.to = to;
        done?.();
        return;
      }
      a.from = tweenAt(a, now);
      a.to = to;
      a.start = now;
      a.dur = ms;
      a.done = done ?? null;
    },
    [animate],
  );
  useEffect(() => {
    play(1, 1500);
  }, [play]);
  return play;
}

function Giant({
  look,
  state,
  joy,
  onClick,
  buttonRef,
}: {
  look: number;
  state: AgentState;
  joy: string;
  onClick: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const aimRef = useAimRef();
  const zone = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const setButton = useCallback(
    (el: HTMLButtonElement | null) => {
      button.current = el;
      buttonRef.current = el;
      return aimRef(el);
    },
    [aimRef, buttonRef],
  );
  const body = useRef<HTMLCanvasElement>(null);
  const play = useGiant(
    body,
    button,
    { look: GIANT_LOOKS[look] ?? {}, state, joy: joy.split(" ").includes("lp-joy") },
    reduced,
  );
  // A click: it comes apart into the sky, changes look, and forms again.
  const change = () =>
    play(0, 520, () => {
      onClick();
      play(1, 900);
    });
  useEffect(() => {
    const sync = () => zone.current?.style.setProperty("--gs", `${button.current?.offsetWidth ?? 0}px`);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return (
    <div className="lp-giant-zone" ref={zone}>
      <Bubbles />
      <button type="button" className="lp-giant" ref={setButton} aria-label={t("landing.hero.giant")} onClick={change}>
        <span className={cx("lp-giant__in", joy)}>
          <canvas className="lp-giant__body" ref={body} />
        </span>
      </button>
    </div>
  );
}

type When = "now" | "twoMin" | [number, number];
const EVENTS: [AgentKey, "pr" | "report" | "approval" | "cause" | "replied" | "saved" | "tests", When][] = [
  ["lia", "pr", "now"],
  ["teo", "report", [9, 0]],
  ["bia", "approval", "now"],
  ["lia", "cause", [14, 22]],
  ["teo", "replied", "twoMin"],
  ["bia", "saved", [11, 4]],
  ["lia", "tests", "now"],
];

/** Activity bubbles stacked above the giant; one changes every 2.6 s. */
function Bubbles() {
  const { reduced } = useLanding();
  const { t } = useTranslation();
  const fmt = useFormat();
  const [slots, setSlots] = useState([
    { ev: 0, n: 0 },
    { ev: 1, n: 1 },
    { ev: 2, n: 2 },
  ]);
  useEffect(() => {
    if (reduced) return;
    let next = 3;
    let slot = 0;
    const id = setInterval(() => {
      if (document.hidden) return;
      const at = slot++ % 3;
      const ev = next++ % EVENTS.length;
      setSlots((s) => s.map((x, i) => (i === at ? { ev, n: x.n + 3 } : x)));
    }, 2600);
    return () => clearInterval(id);
  }, [reduced]);
  return (
    <div className="lp-bubs">
      {slots.map((s) => {
        const [agent, key, when] = EVENTS[s.ev] ?? EVENTS[0] ?? ["lia", "pr", "now"];
        const time = Array.isArray(when) ? fmt.time(when[0], when[1]) : t(`landing.when.${when}`);
        return (
          <div className="lp-bub lp-pop" key={s.n}>
            <SampleAgent agent={agent} size="sm" />
            <span>
              {t(`landing.bubbles.${key}`, { name: AGENTS[agent].name })} <small>· {time}</small>
            </span>
          </div>
        );
      })}
    </div>
  );
}

type Tick = {
  key: "pr" | "report" | "announce" | "closed" | "rollback" | "split" | "versions" | "lesson";
  agent?: AgentKey;
  time: [number, number];
  tone?: "warn" | "ok";
};
const TICK: Tick[] = [
  { agent: "lia", key: "pr", time: [14, 24] },
  { agent: "teo", key: "report", time: [9, 0] },
  { agent: "bia", key: "announce", time: [11, 6], tone: "warn" },
  { agent: "lia", key: "closed", time: [15, 2], tone: "ok" },
  { key: "rollback", time: [14, 23], tone: "ok" },
  { agent: "teo", key: "split", time: [9, 14] },
  { agent: "bia", key: "versions", time: [11, 4] },
  { agent: "lia", key: "lesson", time: [16, 40] },
];

/** The live ticker under the hero (two copies of the track for the loop). */
function Ticker() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const marina = PEOPLE.marina;
  const items = (copy: number) =>
    TICK.map((k) => (
      <span className="lp-tk" key={`${copy}-${k.key}`}>
        {k.agent ? (
          <SampleAgent agent={k.agent} size="sm" />
        ) : (
          <Avatar name={marina.name} initials={marina.initials} size="sm" />
        )}
        <span>
          <RichText
            text={t(`landing.ticker.${k.key}`, {
              name: k.agent ? AGENTS[k.agent].name : marina.short,
              to: PEOPLE.camila.short,
            })}
          />
        </span>
        {k.tone === "warn" && (
          <Chip icon="waiting" tone="waiting">
            {t("landing.ticker.waiting")}
          </Chip>
        )}
        {k.tone === "ok" && (
          <Chip icon="check" tone="done">
            {t("landing.ticker.done")}
          </Chip>
        )}
        <time>{fmt.time(k.time[0], k.time[1])}</time>
      </span>
    ));
  return (
    <section className="lp-ticker" aria-label={t("landing.hero.activity")}>
      <div className="lp-track">
        {items(0)}
        <span className="lp-track-copy" aria-hidden="true">
          {items(1)}
        </span>
      </div>
    </section>
  );
}
