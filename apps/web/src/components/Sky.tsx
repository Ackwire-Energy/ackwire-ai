import type { Agent, Message } from "@agenteschat/client";
import { useOverview } from "@agenteschat/client";
import { joinNames, whenAt } from "@agenteschat/client/lib/format";
import {
  type AgentColor,
  agentGradient,
  agentTones,
  drawSprite,
  EYE,
  Icon,
  Logo,
  mix,
  PixelSky,
  parseColor,
  pixelBurst,
  pixelOf,
  prefersReducedMotion,
  SKY_TONES,
  type SkyOptions,
  softTones,
  spriteTone,
} from "@agenteschat/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { agentActivitySince, dayPart, isNewDay, lastVisit, markVisit } from "@/lib/welcome";

/*
 * The pixel sky inside the app. The sky is the
 * agents' world: it shows only where the subject is the agents, in the sky
 * blue or in one agent's own color. Everything around it stays neutral.
 */

const S = Math.sin;
const C = Math.cos;

/** An agent's color for drawing (its look, or the default sky). */
export const colorOf = (agent: { appearance?: unknown } | undefined | null): AgentColor =>
  lookOf(agent)?.color ?? "sky";

/* ---------- Channel: the greeting of a new day ---------- */

/** One greeting per workspace per page load: the first channel opened claims it. */
const greetings = new Map<string, { last: number | null; show: boolean; channelId?: string; closed?: boolean }>();
function claimGreeting(orgId: string, channelId: string) {
  let g = greetings.get(orgId);
  if (!g) {
    const last = lastVisit(orgId);
    g = { last, show: isNewDay(last) };
    greetings.set(orgId, g);
    markVisit(orgId);
  }
  if (g.show && !g.channelId) g.channelId = channelId;
  return g;
}

/** The sky band at the top of a channel on the first visit of the day: a greeting and what its agents did since. */
export function ChannelWelcome({
  channelId,
  messages,
  agents,
}: {
  channelId: string;
  messages: Message[] | undefined;
  agents: Agent[];
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const overview = useOverview(org.id);
  const [greeting] = useState(() => claimGreeting(org.id, channelId));
  const [closed, setClosed] = useState(greeting.closed ?? false);
  const text = useRef<HTMLDivElement>(null);
  if (!greeting.show || greeting.channelId !== channelId || closed || !messages || greeting.last === null) return null;
  const close = () => {
    greeting.closed = true;
    setClosed(true);
  };
  const since = greeting.last;
  const activity = agentActivitySince(messages, since);
  const names = joinNames(
    activity.agentIds.slice(0, 3).map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
    t("newAgent.and"),
  );
  const waiting = overview.data?.approvalsWaitingForMe ?? 0;
  const firstName = me.user.name.split(/\s+/)[0] ?? me.user.name;
  const crew = (activity.agentIds.length ? activity.agentIds : agents.map((a) => a.id)).slice(0, 3);
  return (
    <section className="sky-welcome" aria-label={t("sky.welcome.label")}>
      <PixelSky
        options={{
          pixel: 4,
          palette: SKY_TONES,
          sprites: { area: 1100, max: 30 },
          calm: () => [text.current],
          base: (u, v) => 0.9 - 0.38 * u - 0.5 * v,
          blobs: (tt) => [
            [0.2 + 0.05 * S(tt * 0.21), 0.25 + 0.05 * C(tt * 0.17), 0.12, 0.14],
            [0.62 + 0.08 * S(tt * 0.13), 0.4 + 0.08 * C(tt * 0.19), 0.08, 0.14],
            [0.85 + 0.05 * C(tt * 0.15), 0.95, 0.14, -0.3],
            [0.45 + 0.1 * C(tt * 0.11), 1, 0.1, -0.16],
          ],
        }}
      />
      <div className="sky-welcome__text" ref={text}>
        <span className="sky-welcome__when">
          {t("sky.welcome.lastVisit", { when: whenAt(t, i18n.language, new Date(since).toISOString()) })}
        </span>
        <h2 className="sky-welcome__title">
          {t(`sky.welcome.${dayPart(new Date().getHours())}`, { name: firstName })}
        </h2>
        <p className="sky-welcome__lead">
          {activity.count === 0
            ? t("sky.welcome.quiet")
            : activity.agentIds.length === 1
              ? t("sky.welcome.activityOne", { names, count: activity.count })
              : t("sky.welcome.activityMany", { names, count: activity.count })}{" "}
          {waiting > 0 && t("sky.welcome.approvals", { count: waiting })}
        </p>
      </div>
      {crew.length > 0 && (
        <div className="sky-welcome__crew" aria-hidden="true">
          {crew.map((id) => (
            <AgentAvatar key={id} agentId={id} name={dir.agentById.get(id)?.name ?? ""} size="lg" />
          ))}
        </div>
      )}
      <button type="button" className="sky-welcome__close" aria-label={t("sky.welcome.dismiss")} onClick={close}>
        <Icon name="close" size={16} />
      </button>
    </section>
  );
}

/* ---------- Agent page: the cover in the agent's color ---------- */

/**
 * The agent page's cover: a sky in the
 * agent's own color, lighter behind the agent (at `at`, 0..1 across) so its
 * body reads; faster and busier while it works.
 */
export function AgentCover({ color, busy, at = 0.1 }: { color: AgentColor; busy: boolean; at?: number }) {
  return (
    <div className="agp-cover__sky" data-busy={busy || undefined} aria-hidden="true">
      <PixelSky
        options={{
          pixel: 4,
          palette: agentTones(color),
          body: spriteTone(color),
          speed: busy ? 2.6 : 1,
          rise: busy ? 2.4 : 1,
          sprites: busy ? { area: 520, max: 40 } : { area: 1100, max: 20 },
          light: 0,
          base: (u, v, tt) => {
            const dx = (u - at) * 2.2;
            const dy = (v - 0.84) * 1.3;
            return (
              0.86 - 0.22 * u - 0.46 * v + 0.42 * Math.exp(-(dx * dx + dy * dy) / 0.14) + 0.06 * S(u * 5 + tt * 0.6)
            );
          },
        }}
      />
    </div>
  );
}

/* ---------- Sign in and sign up ---------- */

/**
 * The sign-in screen's horizon: soft tones rising from the page
 * at the bottom, a few agents passing. Calm, so the one question above stays the subject.
 */
export function AuthHorizon() {
  const opts: SkyOptions = {
    pixel: 4,
    surface: "--bg",
    palette: (bg) => softTones("sky", bg),
    body: spriteTone("sky"),
    near: 0,
    ceil: 0.3,
    light: 0.06,
    sprites: 6,
    base: (u, v, tt) => {
      const s = Math.max(0, (v - 0.2) / 0.8);
      const e = s * s * (3 - 2 * s);
      return 0.78 * e + 0.05 * S(u * 4 + tt * 0.4) * e;
    },
    blobs: (tt) => [
      [0.2 + 0.1 * C(tt * 0.17), 0.95, 0.06, 0.08],
      [0.8 + 0.1 * S(tt * 0.13), 0.92, 0.06, 0.08],
    ],
  };
  return (
    <span className="auth__horizon" aria-hidden="true">
      <PixelSky options={opts} />
    </span>
  );
}

/* ---------- Small moments ---------- */

/** A thin dithered strip sweeping in the agent's color behind the activity bar ("Theo está pensando…"). */
export function ActivitySky({ color }: { color: AgentColor }) {
  return (
    <span className="ac-typing__sky" aria-hidden="true">
      <PixelSky
        options={{
          pixel: 3,
          surface: "--raised",
          palette: (bg) => softTones(color, bg),
          light: 0,
          base: (u, _v, tt) => {
            const c = ((tt * 0.32) % 1.6) - 0.3;
            const d = u - c;
            return 0.08 + 0.5 * Math.exp(-(d * d) / 0.035);
          },
        }}
      />
    </span>
  );
}

/** The top of a card where an agent waits on a person (question, approval): a light drift in its color. */
export function CardSky({ color }: { color: AgentColor }) {
  return (
    <span className="ac-approval__sky" aria-hidden="true">
      <PixelSky
        options={{
          pixel: 3,
          surface: "--raised",
          palette: (bg) => softTones(color, bg),
          light: 0,
          base: (u, v, tt) => {
            const fade = Math.max(0, 1 - v);
            return fade * fade * (0.18 + 0.32 * u * u + 0.06 * S(u * 7 + tt * 0.5));
          },
        }}
      />
    </span>
  );
}

/**
 * The top of a suggested connector in the catalog: a soft pixel sky in the brand's own color (the
 * ink's sky when the brand has none), fading into the card.
 */
export function ConnectorSky({ brand }: { brand: string | null }) {
  return (
    <span className="catalog-feat__sky" aria-hidden="true">
      <PixelSky
        options={{
          pixel: 3,
          surface: "--raised",
          palette: (bg) =>
            brand
              ? [bg, mix(bg, brand, 0.1), mix(bg, brand, 0.22), mix(bg, brand, 0.36), mix(bg, brand, 0.52)]
              : softTones("sky", bg),
          light: 0,
          base: (u, v, tt) => {
            const fade = Math.max(0, 1 - v);
            return fade * (0.35 + 0.35 * u + 0.06 * S(u * 6 + tt * 0.4));
          },
        }}
      />
    </span>
  );
}

/** The whole app loading (the workspace's first load): the sky rises and agents pass through it. */
export function BootSplash() {
  const { t } = useTranslation();
  const [start] = useState(() => (typeof performance === "undefined" ? 0 : performance.now()));
  return (
    <div className="sky-boot" role="status" aria-live="polite">
      <PixelSky
        options={{
          pixel: 4,
          palette: SKY_TONES,
          sprites: { area: 700, max: 40 },
          rise: 2.2,
          light: 0.12,
          base: (u, v, tt) => {
            const fill = Math.min(1, (performance.now() - start) / 1800);
            return -0.3 + 1.15 * fill * (0.35 + 0.65 * v) + 0.05 * S(u * 6 + tt);
          },
        }}
      />
      <div className="sky-boot__in">
        <Logo size={40} />
        <span>{t("sky.boot")}</span>
      </div>
    </div>
  );
}

/**
 * Readies a burst of an agent's colors from `from` (an approval's agent
 * avatar, else the button): place and colors are read now, since the card may
 * collapse once decided. Call the result when the action went through.
 */
export function prepareBurst(from: HTMLElement): () => void {
  const avatar =
    from.closest(".ac-approval, [data-burst], .ac-details")?.querySelector<HTMLElement>(".ac-avatar") ?? null;
  const box = (avatar ?? from).getBoundingClientRect();
  const css = avatar ? getComputedStyle(avatar) : null;
  const [skyTop, skyBottom] = agentGradient("sky");
  const top = css?.getPropertyValue("--av-top").trim() || skyTop;
  const bottom = css?.getPropertyValue("--av-bottom").trim() || skyBottom;
  return () =>
    pixelBurst(
      { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      [bottom, mix(bottom, top, 0.5), top, mix(top, "#ffffff", 0.5), "#ffffff"],
      bottom,
    );
}

/* ---------- Sidebar ---------- */

/** The workspace header's little sky: light tones, a touch deeper at the right (calm behind its name). */
export function SidebarOrgSky({ calm }: { calm: () => (Element | null)[] }) {
  return (
    <PixelSky
      className="sidebar__org-sky"
      options={{
        pixel: 3,
        surface: "--sunken",
        // Soft tones run from the surface (0) toward the color: low values stay light.
        palette: (bg) => softTones("sky", bg),
        body: spriteTone("sky"),
        // No pixel agents here: the strip is too small, they would pass behind the logo.
        sprites: 0,
        near: 0,
        calm,
        calmV: 0,
        calmPad: 10,
        light: 0,
        base: (u, v) => 0.36 * u * u * u * (0.6 + 0.4 * v),
        blobs: (tt) => [[0.9 + 0.04 * S(tt * 0.3), 0.75, 0.07, 0.08]],
      }}
    />
  );
}

/** Behind a working agent's row: a light sweep in its color, stronger on the right. */
export function AgentTrail({ color }: { color: AgentColor }) {
  return (
    <span className="sidebar__trail" aria-hidden="true">
      <PixelSky
        options={{
          pixel: 3,
          surface: "--sunken",
          palette: (bg) => softTones(color, bg),
          light: 0,
          base: (u, _v, tt) => {
            const p = ((tt * 0.42) % 1.6) - 0.3;
            const d = u - (1 - p);
            return Math.min(0.6, 0.3 * u * u * u + 0.26 * Math.exp(-(d * d) / 0.018) * (0.4 + 0.6 * u));
          },
        }}
      />
    </span>
  );
}

/** Behind a working agent's icon in the rail: a soft pulse in its color. */
export function AgentGlow({ color }: { color: AgentColor }) {
  return (
    <span className="sidebar__glow" aria-hidden="true">
      <PixelSky
        options={{
          pixel: 2,
          surface: "--sunken",
          palette: (bg) => softTones(color, bg),
          light: 0,
          base: (u, v, tt) => {
            const dx = (u - 0.5) * 2;
            const dy = (v - 0.5) * 2;
            return 0.9 * Math.exp(-(dx * dx + dy * dy) / (0.42 + 0.12 * S(tt * 3)));
          },
        }}
      />
    </span>
  );
}

/** The sky rising from the sidebar's bottom: fuller the more agents are working. */
export function SidebarHorizon({ working, total }: { working: number; total: number }) {
  const share = total > 0 ? Math.min(1, working / Math.min(total, 3)) : 0;
  const target = 0.2 + 0.6 * share;
  // Eases toward the new level frame by frame (at once with reduced motion).
  const level = useRef({ now: target, target });
  level.current.target = target;
  if (prefersReducedMotion()) level.current.now = target;
  const opts: SkyOptions = {
    pixel: 4,
    surface: "--sunken",
    palette: (bg) => softTones("sky", bg),
    body: spriteTone("sky"),
    near: 0,
    ceil: 0.3,
    light: 0.06,
    sprites: Math.min(8, working * 2),
    base: (u, v, tt) => {
      const s = Math.max(0, (v - 0.1) / 0.9);
      const e = s * s * (3 - 2 * s);
      return level.current.now * e * 0.7 + 0.04 * S(u * 5 + tt * 0.6) * e;
    },
    blobs: (tt) => {
      const l = level.current;
      l.now += (l.target - l.now) * 0.04;
      return [
        [0.3 + 0.2 * S(tt * 0.2), 0.95, 0.05, 0.1 * l.now],
        [0.75 + 0.15 * C(tt * 0.17), 0.9, 0.04, 0.1 * l.now],
      ];
    },
  };
  return (
    <span className="sidebar__horizon" aria-hidden="true">
      <PixelSky options={opts} />
    </span>
  );
}

/** Under the workspace's full-screen menu (MenuOverlay): a calm horizon in soft tones, no sprites. */
export function MenuHorizon() {
  const opts: SkyOptions = {
    pixel: 4,
    surface: "--bg",
    palette: (bg) => softTones("sky", bg),
    body: spriteTone("sky"),
    near: 0,
    ceil: 0.3,
    light: 0.04,
    sprites: 0,
    base: (u, v, tt) => {
      const s = Math.max(0, (v - 0.1) / 0.9);
      const e = s * s * (3 - 2 * s);
      return 0.32 * e + 0.04 * S(u * 5 + tt * 0.6) * e;
    },
    blobs: (tt) => [
      [0.3 + 0.2 * S(tt * 0.2), 0.95, 0.05, 0.04],
      [0.75 + 0.15 * C(tt * 0.17), 0.9, 0.04, 0.04],
    ],
  };
  return <PixelSky options={opts} />;
}

/* ---------- Onboarding ---------- */

/**
 * The onboarding rail's horizon: soft tones rising from the rail's surface into
 * the sky (no edge), a little higher with each step done; the guide sits on it.
 */
export function OnboardingHorizon({ progress }: { progress: number }) {
  const target = 0.45 + 0.4 * Math.max(0, Math.min(1, progress));
  const level = useRef({ now: target, target });
  level.current.target = target;
  if (prefersReducedMotion()) level.current.now = target;
  const opts: SkyOptions = {
    pixel: 4,
    surface: "--sunken",
    palette: (bg) => softTones("sky", bg),
    body: spriteTone("sky"),
    near: 0,
    ceil: 0.3,
    light: 0.06,
    sprites: 3,
    base: (u, v, tt) => {
      const s = Math.max(0, (v - 0.08) / 0.92);
      const e = s * s * (3 - 2 * s);
      return level.current.now * e * 0.85 + 0.05 * S(u * 4 + tt * 0.5) * e;
    },
    blobs: (tt) => {
      const l = level.current;
      l.now += (l.target - l.now) * 0.04;
      return [
        [0.2 + 0.1 * C(tt * 0.17), 0.95, 0.05, 0.1 * l.now],
        [0.8 + 0.1 * S(tt * 0.13), 0.92, 0.05, 0.1 * l.now],
      ];
    },
  };
  return (
    <span className="onb__horizon" aria-hidden="true">
      <PixelSky options={opts} />
    </span>
  );
}

/**
 * The onboarding's progress at the top of the rail: a strip of pixel
 * sky that fills as steps get done, with a pixel agent walking at its front. `progress` is 0..1.
 */
export function OnboardingProgress({ progress }: { progress: number }) {
  const target = Math.max(0, Math.min(1, progress));
  const level = useRef({ now: target, target });
  level.current.target = target;
  if (prefersReducedMotion()) level.current.now = target;
  const body = pixelOf(spriteTone("sky"));
  const eye = pixelOf(EYE);
  const opts: SkyOptions = {
    pixel: 3,
    surface: "--sunken",
    light: 0,
    palette: (bg) => {
      const [r, g, b] = parseColor(bg);
      const dark = r * 0.3 + g * 0.59 + b * 0.11 < 128;
      const sky = dark ? ["#0f56c4", "#2b74e6", "#4b93ff", "#78b4ff"] : ["#a6cfff", "#78b4ff", "#4b93ff", "#2b74e6"];
      return [bg, mix(bg, "#78b4ff", dark ? 0.1 : 0.14), ...sky];
    },
    // Called once per frame, before the field: eases the fill toward the target.
    blobs: () => {
      const l = level.current;
      l.now += (l.target - l.now) * 0.06;
      return [];
    },
    base: (u, v, t) => {
      const now = level.current.now;
      if (u > now) return 0.12;
      const head = Math.max(0, 1 - (now - u) * 12);
      return Math.min(1, 0.45 + 0.4 * v + 0.08 * S(u * 22 + t * 1.2) + 0.2 * head);
    },
    after: (f) => {
      const now = level.current.now;
      if (now < 0.01) return;
      const x = Math.max(0, Math.min(f.w - 9, Math.round(now * f.w) - 6));
      drawSprite(f, x, Math.round((f.h - 9) / 2), 1, body, eye, f.t % 3.6 > 3.46);
    },
  };
  return (
    <span className="onb__progress-sky" aria-hidden="true">
      <PixelSky options={opts} />
    </span>
  );
}

/* ---------- Criar agente ---------- */

/** The live preview's cover: the draft agent's own sky, lighter right behind it so the body reads. */
export function AgentPreviewSky({ color }: { color: AgentColor }) {
  return (
    <PixelSky
      options={{
        pixel: 4,
        palette: agentTones(color),
        body: spriteTone(color),
        sprites: 4,
        light: 0,
        base: (u, v, tt) => {
          const dx = (u - 0.5) * 1.6;
          const dy = (v - 0.78) * 1.4;
          return 0.86 - 0.28 * u - 0.5 * v + 0.42 * Math.exp(-(dx * dx + dy * dy) / 0.12) + 0.06 * S(u * 5 + tt * 0.4);
        },
      }}
    />
  );
}

/** The created moment: the new agent's sky, a halo where it stands (`at`, in 0..1) and calm behind the words. */
export function AgentBornSky({
  color,
  at,
  calm,
}: {
  color: AgentColor;
  at: [number, number];
  calm: () => (Element | null)[];
}) {
  return (
    <PixelSky
      options={{
        pixel: 4,
        palette: agentTones(color),
        body: spriteTone(color),
        sprites: { area: 1200, max: 18 },
        calm,
        base: (u, v, tt) => 0.72 - 0.2 * u - 0.42 * v + 0.05 * S(u * 6 + tt * 0.5) + 0.04 * C(v * 7 - tt * 0.3),
        blobs: () => [[at[0], at[1], 0.06, 0.42]],
      }}
    />
  );
}

/** The onboarding's last card: a small sky, calm behind its text. */
export function WelcomeSky({ calm }: { calm: () => (Element | null)[] }) {
  return (
    <PixelSky
      options={{
        pixel: 4,
        palette: SKY_TONES,
        sprites: { area: 1300, max: 24 },
        calm,
        base: (u, v) => 0.95 - 0.4 * u - 0.45 * v,
        blobs: (tt) => [
          [0.2 + 0.05 * S(tt * 0.21), 0.25 + 0.05 * C(tt * 0.17), 0.12, 0.12],
          [0.85 + 0.05 * C(tt * 0.15), 0.95, 0.14, -0.3],
          [0.5 + 0.1 * C(tt * 0.11), 1, 0.1, -0.16],
        ],
      }}
    />
  );
}

/** Wiki: the top of "agents that use this page" (a slow drift) or the glow behind a finished import. */
export function WikiSky({ variant }: { variant: "strip" | "glow" }) {
  return (
    <span className={`wiki-sky wiki-sky--${variant}`} aria-hidden="true">
      <PixelSky
        options={
          variant === "strip"
            ? {
                pixel: 2,
                surface: "--raised",
                palette: (bg) => softTones("sky", bg),
                light: 0,
                base: (u, v, tt) => {
                  const c = ((tt * 0.22) % 1.6) - 0.3;
                  const d = u - c;
                  return 0.08 + 0.45 * Math.exp(-(d * d) / 0.05) + 0.3 * (1 - v);
                },
              }
            : {
                pixel: 4,
                surface: "--raised",
                palette: (bg) => softTones("sky", bg),
                light: 0,
                base: (u, v, tt) => {
                  const dx = (u - 0.5) * 2.2;
                  const dy = (v - 0.6) * 1.3;
                  return 0.75 * Math.exp(-(dx * dx + dy * dy) / 0.22) + 0.05 * S(tt * 0.8 + u * 3);
                },
              }
        }
      />
    </span>
  );
}
