import {
  ACCESSORY_REACH,
  type AgentAppearance,
  type AgentState,
  Avatar,
  cx,
  drawAccessory,
  drawAgent,
  getGaze,
  Icon,
  idlePose,
  Message,
  MessageText,
  type Pose,
  Reaction,
  Reactions,
  WorkSummary,
} from "@agenteschat/ui";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST, type CastKey, PEOPLE, STARTUP_AGENTS, STARTUP_CHANNELS } from "./cast";
import { useLanding } from "./context";
import { GIANT_LOOKS } from "./data";
import { useFormat } from "./format";
import { useAimRef, useRunner, useVisible } from "./hooks";
import { LpApproval } from "./kit/Approval";
import { MockSidebar } from "./kit/MockSidebar";
import { LpAvatar } from "./LpAvatar";
import { PixelSky } from "./PixelSky";
import { RichText } from "./rich";
import { HERO_SKY } from "./sky";
import "./kit/kit.css";
import "./Hero.css";

/**
 * The hero: the sky, the headline and the waiting list, then the app itself
 * rising from the bottom of the sky with a live sample conversation, the giant
 * agent sitting on its window and watching it.
 */
export function Hero({
  giantLook,
  giantState,
  giantJoy,
  onGiantClick,
  onCelebrate,
  waitlist,
  waitlistRef,
}: {
  giantLook: number;
  giantState: AgentState;
  giantJoy: string;
  onGiantClick: () => void;
  /** Something good happened in the sample conversation: the giant hops. */
  onCelebrate: () => void;
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
    <section className="lp-hero lp-hero--app">
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
        <div className="lp-hero-app-wrap">
          <HeroApp onCelebrate={onCelebrate} />
          <Giant look={giantLook} state={giantState} joy={giantJoy} onClick={onGiantClick} buttonRef={giantRef} />
        </div>
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
      <button type="button" className="lp-giant" ref={setButton} aria-label={t("landing.hero.giant")} onClick={change}>
        <span className={cx("lp-giant__in", joy)}>
          <canvas className="lp-giant__body" ref={body} />
        </span>
      </button>
    </div>
  );
}

/* ---------- The app, live: a sample conversation that loops while the hero is on screen (still with reduced motion) ---------- */

type FeedItem =
  | { id: string; kind: "ask" }
  | { id: string; kind: "work"; done: number; summary: boolean }
  | { id: string; kind: "found" }
  | { id: string; kind: "approval"; decided: boolean }
  | { id: string; kind: "done" };

/** At most this many messages show; older ones leave through the fade at the top. */
const SHOWN = 4;

/** With reduced motion, the conversation as one loop ends, held still: nothing arrives, nobody hops. */
const STILL: FeedItem[] = [
  { id: "0-ask", kind: "ask" },
  { id: "0-work", kind: "work", done: 3, summary: true },
  { id: "0-found", kind: "found" },
  { id: "0-approval", kind: "approval", decided: true },
  { id: "0-done", kind: "done" },
];

function HeroApp({ onCelebrate }: { onCelebrate: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { aim, reduced } = useLanding();
  const runner = useRunner();
  const wrap = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const visible = useVisible(wrap);
  const seen = useRef(false);
  seen.current = visible;
  const [items, setItems] = useState<FeedItem[]>(() => (reduced ? STILL : []));
  const [states, setStates] = useState<Partial<Record<CastKey, AgentState>>>({});
  const decide = useRef<(() => void) | null>(null);
  const celebrate = useRef(onCelebrate);
  celebrate.current = onCelebrate;

  // The giant looks at each new message for a moment.
  const look = useCallback(() => {
    const last = feed.current?.lastElementChild;
    if (!last) return;
    const r = last.getBoundingClientRect();
    aim.at(r.left + r.width / 2, r.top + r.height / 2);
  }, [aim]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: look again whenever a message arrives
  useEffect(look, [items.length, look]);

  const started = useRef(false);
  useEffect(() => {
    if (reduced || !visible || started.current) return;
    started.current = true;
    runner.start(async (r) => {
      const step = async (ms: number) => {
        await r.sleep(ms);
        // Paused while the hero is off screen or the tab is hidden.
        while (r.alive() && (!seen.current || document.hidden)) await r.sleep(800);
        return r.alive();
      };
      const patch = (id: string, fn: (x: FeedItem) => FeedItem) =>
        setItems((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));
      for (let loop = 0; r.alive(); loop++) {
        const k = (s: string) => `${loop}-${s}`;
        setStates({});
        setItems((xs) => [...xs, { id: k("ask"), kind: "ask" }]);
        if (!(await step(1300))) return;
        setStates({ dev: "thinking" });
        setItems((xs) => [...xs, { id: k("work"), kind: "work", done: 0, summary: false }]);
        if (!(await step(1300))) return;
        patch(k("work"), (x) => (x.kind === "work" ? { ...x, done: 1 } : x));
        setStates({ dev: "thinking", atlas: "thinking" });
        if (!(await step(1300))) return;
        patch(k("work"), (x) => (x.kind === "work" ? { ...x, done: 2 } : x));
        setStates({ dev: "thinking" });
        if (!(await step(900))) return;
        patch(k("work"), (x) => (x.kind === "work" ? { ...x, done: 3, summary: true } : x));
        setStates({});
        setItems((xs) => [...xs, { id: k("found"), kind: "found" }]);
        if (!(await step(1500))) return;
        setItems((xs) => [...xs, { id: k("approval"), kind: "approval", decided: false }]);
        // Approves by itself if nobody holds the button (HoldButton's `auto`).
        await new Promise<void>((resolve) => {
          decide.current = resolve;
        });
        decide.current = null;
        if (!r.alive()) return;
        patch(k("approval"), (x) => (x.kind === "approval" ? { ...x, decided: true } : x));
        celebrate.current();
        if (!(await step(1200))) return;
        setStates({ atlas: "thinking" });
        if (!(await step(1200))) return;
        setStates({});
        setItems((xs) => [...xs, { id: k("done"), kind: "done" }]);
        if (!(await step(4500))) return;
      }
    });
  }, [reduced, visible, runner]);
  useEffect(() => () => decide.current?.(), []);

  const shown = items.slice(-SHOWN);
  const dev = CAST.dev;
  const atlas = CAST.atlas;
  const marina = PEOPLE.marina;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled sample screen, not a form group
    <div className="lp-hero-app" ref={wrap} role="group" aria-label={t("landing.hero.app")}>
      <MockSidebar
        org="startup"
        channels={STARTUP_CHANNELS.map((key, i) => ({ key, unread: i === 2 ? 3 : 0 }))}
        active="engineering"
        agents={STARTUP_AGENTS.slice(0, 3)}
        states={states}
        tools={[]}
        label={t("landing.hero.sidebar")}
      />
      <div className="lp-hero-chan">
        <div className="lp-hero-chan__head">
          <Icon name="channel" />
          {t("landing.channel.engineering")}
        </div>
        <div className="lp-hero-feed" ref={feed}>
          {shown.map((it) => {
            if (it.kind === "ask")
              return (
                <Message
                  key={it.id}
                  entering
                  avatar={<Avatar name={marina.name} initials={marina.initials} />}
                  author={marina.short}
                  time={fmt.time(14, 21)}
                >
                  <MessageText>{t("landing.heroFeed.ask")}</MessageText>
                </Message>
              );
            if (it.kind === "work")
              return (
                <Message
                  key={it.id}
                  entering
                  agent
                  avatar={<LpAvatar look={dev.look} name={dev.name} state={it.summary ? "idle" : "thinking"} />}
                  author={dev.name}
                  time={fmt.time(14, 21)}
                >
                  <WorkSummary
                    defaultOpen
                    summary={it.summary ? t("landing.heroFeed.summary") : t("landing.working")}
                    steps={(["s1", "s2", "s3"] as const).slice(0, Math.min(3, it.done + 1)).map((s, i) => ({
                      key: s,
                      label: t(`landing.heroFeed.${s}`),
                      pending: i >= it.done,
                    }))}
                  />
                </Message>
              );
            if (it.kind === "found")
              return (
                <Message
                  key={it.id}
                  entering
                  agent
                  avatar={<LpAvatar look={dev.look} name={dev.name} />}
                  author={dev.name}
                  time={fmt.time(14, 22)}
                >
                  <MessageText>{t("landing.heroFeed.found")}</MessageText>
                </Message>
              );
            if (it.kind === "approval")
              return (
                <Message
                  key={it.id}
                  entering
                  agent
                  avatar={<LpAvatar look={atlas.look} name={atlas.name} />}
                  author={atlas.name}
                  time={fmt.time(14, 23)}
                >
                  <LpApproval
                    who={<b>{atlas.name}</b>}
                    title={t("landing.heroFeed.approval")}
                    color={atlas.color}
                    decided={it.decided ? "yes" : undefined}
                    decidedLabel={t("landing.heroFeed.approved")}
                    onDecide={() => decide.current?.()}
                    hint={t("landing.heroFeed.tryIt")}
                    auto={4500}
                    noDecline
                  />
                </Message>
              );
            return (
              <Message
                key={it.id}
                entering
                agent
                avatar={<LpAvatar look={atlas.look} name={atlas.name} />}
                author={atlas.name}
                time={fmt.time(14, 24)}
              >
                <MessageText>{t("landing.heroFeed.done")}</MessageText>
                <Reactions label={t("landing.hero.reactions")}>
                  <Reaction count={3} label="🎉 3">
                    🎉
                  </Reaction>
                  <Reaction count={2} label="🙏 2">
                    🙏
                  </Reaction>
                </Reactions>
              </Message>
            );
          })}
        </div>
        <div className="lp-hero-composer" aria-hidden="true">
          <span>{t("landing.hero.composer", { channel: t("landing.channel.engineering") })}</span>
          <Icon name="send" size={16} />
        </div>
      </div>
    </div>
  );
}

/* ---------- The live ticker under the hero (two copies of the track for the loop) ---------- */

const TICK: [CastKey, "consult" | "rollback" | "report" | "post" | "support" | "invoices" | "task" | "lesson"][] = [
  ["dev", "consult"],
  ["atlas", "rollback"],
  ["nina", "report"],
  ["theo", "post"],
  ["sol", "support"],
  ["cora", "invoices"],
  ["ada", "task"],
  ["dev", "lesson"],
];

function Ticker() {
  const { t } = useTranslation();
  const items = (copy: number) =>
    TICK.map(([agent, key]) => (
      <span className="lp-tk" key={`${copy}-${agent}-${key}`}>
        <LpAvatar look={CAST[agent].look} size="sm" name={CAST[agent].name} />
        <span>
          <RichText
            text={t(`landing.ticker.${key}`, { a: CAST[agent].name, b: CAST.atlas.name, person: PEOPLE.rafael.short })}
          />
        </span>
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
