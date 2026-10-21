import {
  AGENT_GRADIENTS,
  type AgentAccessory,
  type AgentAppearance,
  type AgentColor,
  Avatar,
  Button,
  Card,
  CardFooter,
  Chip,
  cx,
  type IconName,
  Input,
} from "@agenteschat/ui";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { CAST, type CastKey, PEOPLE, type PersonKey } from "./cast";
import { type Run, useAimRef, useJoy, useRunner, useVisible } from "./hooks";
import { LpAvatar } from "./LpAvatar";
import { PixelSky } from "./PixelSky";
import type { SkyOptions } from "./sky";
import "./team.css";

type ToolKey =
  | "github"
  | "computer"
  | "tasks"
  | "browser"
  | "errors"
  | "routines"
  | "database"
  | "sheets"
  | "drive"
  | "calendar"
  | "web"
  | "forum"
  | "wiki"
  | "inbox"
  | "email";

/** What each agent can use (the profile card's chips). */
const TOOLS: Record<CastKey | "new", [ToolKey, IconName][]> = {
  dev: [
    ["github", "code"],
    ["computer", "computer"],
    ["tasks", "issues"],
    ["browser", "globe"],
  ],
  atlas: [
    ["github", "code"],
    ["errors", "alert"],
    ["computer", "computer"],
    ["routines", "routines"],
  ],
  nina: [
    ["database", "database"],
    ["sheets", "table"],
    ["browser", "globe"],
    ["routines", "routines"],
  ],
  theo: [
    ["drive", "drive"],
    ["calendar", "calendar"],
    ["web", "globe"],
  ],
  ada: [
    ["tasks", "issues"],
    ["forum", "message"],
    ["wiki", "book"],
  ],
  sol: [
    ["inbox", "message"],
    ["wiki", "book"],
    ["tasks", "issues"],
  ],
  cora: [
    ["email", "mail"],
    ["sheets", "table"],
    ["browser", "globe"],
  ],
  new: [["drive", "drive"]],
};

/** Who answers for whom: each person's agents stand together in the sky. */
const GROUPS: [PersonKey, CastKey[]][] = [
  ["marina", ["theo", "ada"]],
  ["rafael", ["dev", "atlas"]],
  ["camila", ["nina", "sol", "cora"]],
];
/** Group centers in % of the panel (x, y). */
const POS_WIDE: [number, number][] = [
  [20, 56],
  [46, 34],
  [70, 70],
];
const POS_NARROW: [number, number][] = [
  [30, 16],
  [66, 46],
  [40, 77],
];
/** "-o"/"-a" in Portuguese: "responde ao Rafael", "responde à Marina". */
const MALE: ReadonlySet<PersonKey> = new Set(["rafael"]);

type AskKey = "staging" | "openRate" | "session" | "complaints" | "servers" | "dbPlan";
/** The private questions they ask each other, in turn (asker, who answers, the text). */
const ASKS: [CastKey, CastKey, AskKey][] = [
  ["dev", "atlas", "staging"],
  ["theo", "nina", "openRate"],
  ["sol", "dev", "session"],
  ["ada", "sol", "complaints"],
  ["cora", "nina", "servers"],
  ["atlas", "cora", "dbPlan"],
];

const MK_COLORS: AgentColor[] = ["rose", "sky", "indigo", "violet", "amber", "green", "teal", "graphite"];
const MK_ACC: AgentAccessory[] = ["party", "hat", "crown", "antenna", "bow", "beanie", "flower", "scarf", "headset"];
/** Marina's group keeps at most this many agents (the oldest one you added leaves). */
const MAX_GROUP = 4;

/** Light on top, deeper at the bottom, a soft glow in the middle (prototype's `teamField`). */
const TEAM_SKY: SkyOptions = {
  pixel: 4,
  sprites: true,
  lightR: 0.28,
  base: (u, v) => 0.78 - 0.2 * u - 0.46 * v,
  blobs: (t) => [
    [0.5, 0.45 + 0.03 * Math.sin(t * 0.3), 0.12, 0.1],
    [0.2 + 0.06 * Math.sin(t * 0.17), 0.9, 0.1, -0.06],
  ],
};

interface Custom {
  id: string;
  name: string;
  look: AgentAppearance;
}
interface Bubble {
  key: string;
  who: string;
  ask: AskKey;
  part: "q" | "a";
  left: number;
  top: number;
}
type Joys = Record<string, { n: number; ms: number }>;

const NARROW = "(max-width: 760px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const mq = window.matchMedia(NARROW);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches,
    () => false,
  );
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const snap = (n: number) => Math.round(n / 6) * 6;

/** "04 · Equipe": the agents in a pixel sky, grouped by their person; they consult each other; make your own. */
export function Team() {
  const { t } = useTranslation();
  const narrow = useNarrow();
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const runner = useRunner();

  const panel = useRef<HTMLDivElement>(null);
  const visible = useVisible(panel, { rootMargin: "100px" });
  const avatars = useRef(new Map<string, HTMLElement>());

  const [custom, setCustom] = useState<Custom[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [work, setWork] = useState<string | null>(null);
  const [joys, setJoys] = useState<Joys>({});
  const [line, setLine] = useState<string | null>(null);
  const [says, setSays] = useState<Bubble[]>([]);

  // The maker's draft.
  const [mkName, setMkName] = useState(() => t("landing.team.maker.defaultName"));
  const [mkColor, setMkColor] = useState<AgentColor>("rose");
  const [mkAcc, setMkAcc] = useState(0);
  const mkJoy = useJoy();
  const aimRef = useAimRef();
  const mkCount = useRef(0);

  const joy = useCallback((id: string, ms = 1600) => {
    setJoys((j) => ({ ...j, [id]: { n: (j[id]?.n ?? 0) + 1, ms } }));
  }, []);

  const customById = useMemo(() => new Map(custom.map((c) => [c.id, c])), [custom]);
  const groups = useMemo(
    () =>
      GROUPS.map(([p, ids], i) => [p, i === 0 ? [...ids, ...custom.map((c) => c.id)] : ids] as [PersonKey, string[]]),
    [custom],
  );
  const nameOf = useCallback(
    (id: string) => CAST[id as CastKey]?.name ?? customById.get(id)?.name ?? t("landing.team.maker.noName"),
    [customById, t],
  );

  const clear = useCallback(() => {
    setWork(null);
    setLine(null);
    setSays([]);
  }, []);

  // One consultation: a pixel line between the two, the question, then the answer.
  const ask = useRef(0);
  const consult = useCallback(
    async (run: Run) => {
      const host = panel.current;
      if (!host || document.hidden) return;
      const [from, to, key] = ASKS[ask.current++ % ASKS.length] as [CastKey, CastKey, AskKey];
      const ea = avatars.current.get(from);
      const eb = avatars.current.get(to);
      if (!ea || !eb) return;
      const tr = host.getBoundingClientRect();
      const ra = ea.getBoundingClientRect();
      const rb = eb.getBoundingClientRect();
      const x1 = snap(ra.left + ra.width / 2 - tr.left);
      const y1 = snap(ra.top + ra.height / 2 - tr.top);
      const x2 = snap(rb.left + rb.width / 2 - tr.left);
      const y2 = snap(rb.top + rb.height / 2 - tr.top);
      const mx = snap((x1 + x2) / 2);
      // Wide: above the speaker. Narrow: under the speaker's group, so the tags stay visible.
      const place = (el: HTMLElement, x: number, y: number) => {
        if (narrowRef.current) {
          const g = el.closest(".lp-team-grp")?.getBoundingClientRect();
          return { left: 0, top: (g ? g.bottom - tr.top : y + 60) + 8 };
        }
        return { left: Math.min(tr.width - 250, Math.max(8, x - 40)), top: Math.max(8, y - 110) };
      };
      setLine(`M${x1} ${y1}H${mx}V${y2}H${x2}`);
      setWork(from);
      setSays([{ key: `${key}-q`, who: from, ask: key, part: "q", ...place(ea, x1, y1) }]);
      await pause(2000);
      if (!run.alive()) return;
      setWork(to);
      const answer: Bubble = { key: `${key}-a`, who: to, ask: key, part: "a", ...place(eb, x2, y2) };
      // Narrow: one bubble at a time (two under the same group would overlap).
      setSays((s) => (narrowRef.current ? [answer] : [...s, answer]));
      await pause(1800);
      if (!run.alive()) return;
      clear();
      joy(from);
    },
    [clear, joy],
  );
  const consultRef = useRef(consult);
  consultRef.current = consult;

  useEffect(() => {
    if (!visible) return;
    const go = () => runner.start((run) => consultRef.current(run));
    const first = setTimeout(go, 900);
    const every = setInterval(go, 4600);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      runner.stop();
      clear();
    };
  }, [visible, runner, clear]);

  // The layout changed: the line and the bubbles point at old places.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the layout changes
  useEffect(() => {
    runner.stop();
    clear();
  }, [narrow, custom, runner, clear]);

  const pick = (id: string) => {
    setSel(id);
    joy(id);
  };

  const add = () => {
    const id = `mk${++mkCount.current}`;
    const agent: Custom = {
      id,
      name: mkName.trim() || t("landing.team.maker.noName"),
      look: { color: mkColor, accessory: MK_ACC[mkAcc % MK_ACC.length] ?? "party" },
    };
    setCustom((list) => {
      const next = [...list, agent];
      // The two cast agents stay; the oldest one you added leaves.
      return next.length > MAX_GROUP - 2 ? next.slice(next.length - (MAX_GROUP - 2)) : next;
    });
    setSel(id);
    joy(id, 2400);
  };

  const lookOf = (id: string): AgentAppearance => CAST[id as CastKey]?.look ?? customById.get(id)?.look ?? {};
  const pos = narrow ? POS_NARROW : POS_WIDE;
  const tagPx = narrow ? 56 : 72;
  const mkLook: AgentAppearance = { color: mkColor, accessory: MK_ACC[mkAcc % MK_ACC.length] ?? "party" };

  return (
    <section className="lp-sec" id="equipe">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.team.eyebrow")}</span>
          <h2>{t("landing.team.title")}</h2>
          <p className="lp-lead">{t("landing.team.lead")}</p>
        </div>
        <div className="lp-team" ref={panel}>
          <PixelSky options={TEAM_SKY} />
          <svg className="lp-team-lines" aria-hidden="true">
            {line && (
              <path
                d={line}
                fill="none"
                stroke="#fff"
                strokeWidth={6}
                strokeDasharray="6 6"
                shapeRendering="crispEdges"
                opacity={0.9}
              />
            )}
          </svg>
          {groups.map(([p, ids], i) => {
            const [x, y] = pos[i] as [number, number];
            const person = PEOPLE[p];
            return (
              // biome-ignore lint/a11y/useSemanticElements: a labelled group of agents in the sky, not a form group
              <div
                key={p}
                className="lp-team-grp"
                role="group"
                aria-label={t("landing.team.groupOf", { name: person.short })}
                style={{ "--x": `${x}%`, top: `${y}%`, "--n": ids.length } as CSSProperties}
              >
                <div className="lp-team-ags">
                  {ids.map((id) => (
                    <Tag
                      key={id}
                      name={nameOf(id)}
                      look={lookOf(id)}
                      px={tagPx}
                      selected={sel === id}
                      writing={work === id}
                      joy={joys[id]}
                      onPick={() => pick(id)}
                      avatarRef={(el) => {
                        if (el) avatars.current.set(id, el);
                        else avatars.current.delete(id);
                      }}
                    />
                  ))}
                </div>
                <div className="lp-team-person">
                  <Avatar name={person.name} initials={person.initials} size="xs" />
                  {person.short}
                </div>
              </div>
            );
          })}
          {says.map((s) => (
            <div key={s.key} className="lp-team-say" style={narrow ? { top: s.top } : { left: s.left, top: s.top }}>
              <b>{nameOf(s.who)}:</b> {t(`landing.team.asks.${s.ask}.${s.part}`)}
            </div>
          ))}
          {sel && (
            <Profile
              key={sel}
              name={nameOf(sel)}
              look={lookOf(sel)}
              cast={sel in CAST ? (sel as CastKey) : null}
              onClose={() => setSel(null)}
            />
          )}
        </div>
        <div className="lp-team-maker">
          <span className="lp-team-maker-lab">{t("landing.team.maker.label")}</span>
          <Input
            className="lp-team-name"
            value={mkName}
            maxLength={14}
            autoComplete="off"
            aria-label={t("landing.team.maker.name")}
            onChange={(e) => setMkName(e.target.value)}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: the color swatches, like the app's pickers */}
          <div className="lp-team-sw" role="group" aria-label={t("landing.team.maker.color")}>
            {MK_COLORS.map((c) => {
              const [top, bottom] = AGENT_GRADIENTS[c];
              const label = t(`landing.team.maker.colors.${c}`);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={mkColor === c}
                  aria-label={label}
                  title={label}
                  style={{ background: `linear-gradient(180deg, ${top}, ${bottom})` }}
                  onClick={() => {
                    setMkColor(c);
                    mkJoy.trigger(700);
                  }}
                />
              );
            })}
          </div>
          <Button
            size="sm"
            onClick={() => {
              setMkAcc((n) => n + 1);
              mkJoy.trigger(700);
            }}
          >
            {t("landing.team.maker.accessory")}
          </Button>
          <Button size="sm" variant="primary" icon="plus" onClick={add}>
            {t("landing.team.maker.add")}
          </Button>
          <span className="lp-team-prev" ref={aimRef}>
            <LpAvatar
              look={mkLook}
              px={40}
              className={mkJoy.className}
              name={mkName.trim() || t("landing.team.maker.preview")}
            />
          </span>
        </div>
      </div>
    </section>
  );
}

/** One agent in the sky: 72px (56 on phones), bare on the sky, its name on glass. */
function Tag({
  name,
  look,
  px,
  selected,
  writing,
  joy,
  onPick,
  avatarRef,
}: {
  name: string;
  look: AgentAppearance;
  px: number;
  selected: boolean;
  writing: boolean;
  joy?: { n: number; ms: number };
  onPick: () => void;
  avatarRef: (el: HTMLElement | null) => void;
}) {
  const j = useJoy();
  const { trigger } = j;
  useEffect(() => {
    if (joy?.n) trigger(joy.ms);
  }, [joy?.n, joy?.ms, trigger]);
  return (
    <button type="button" className="lp-team-tag" aria-pressed={selected} onClick={onPick}>
      <span className="lp-team-av" ref={avatarRef}>
        <AgentAvatar
          name={name}
          appearance={look}
          size="lg"
          framed={false}
          state={writing ? "writing" : undefined}
          expression={j.on && !writing ? "happy" : undefined}
          className={cx("lp-av", "lp-av--px", j.className)}
          style={{ "--s": `${px}px` } as CSSProperties}
        />
      </span>
      <span className="lp-team-nm">{name}</span>
    </button>
  );
}

/** The profile card: role, who answers for it, when to call it and what it can use. */
function Profile({
  name,
  look,
  cast,
  onClose,
}: {
  name: string;
  look: AgentAppearance;
  cast: CastKey | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const agent = cast ? CAST[cast] : null;
  const owner: PersonKey = agent?.owner ?? "marina";
  const tools = TOOLS[cast ?? "new"];
  return (
    <Card as="div" className="lp-team-prof">
      <div className="lp-team-prof-row">
        <LpAvatar look={look} px={52} />
        <div className="lp-team-prof-who">
          <h3>{name}</h3>
          <small>
            {t(`landing.team.roles.${agent?.role ?? "new"}`)} ·{" "}
            {t(MALE.has(owner) ? "landing.team.ownerM" : "landing.team.ownerF", { name: PEOPLE[owner].short })}
          </small>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="close"
          iconOnly
          aria-label={t("landing.team.close")}
          onClick={onClose}
        />
      </div>
      <p className="lp-team-call">{t(`landing.team.calls.${cast ?? "new"}`)}</p>
      <div className="lp-team-chips">
        {tools.map(([key, icon]) => (
          <Chip key={key} icon={icon}>
            {t(`landing.team.tools.${key}`)}
          </Chip>
        ))}
      </div>
      <CardFooter icon="message">{t("landing.team.footer")}</CardFooter>
    </Card>
  );
}
