import {
  AttentionNote,
  Button,
  bodyTones,
  Card,
  CardFooter,
  Chip,
  cx,
  Icon,
  type IconName,
  PixelSpinner,
} from "@agenteschat/ui";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { POSTGRES_MARK } from "@/components/DatabaseConnect";
import { CAST, type CastKey, ORGS } from "./cast";
import { useLanding } from "./context";
import { useJoy, useRunner, useVisible } from "./hooks";
import { LpAvatar } from "./LpAvatar";
import { RichText } from "./rich";
import "./Bento.css";

/** "05 · Um lugar só": tasks, inbox, routines, memory, Drive, wiki, database, forum and connectors. */
export function Bento() {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const visible = useVisible(ref, { rootMargin: "100px" });
  return (
    <section className="lp-sec" id="lugar" ref={ref}>
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.bento.eyebrow")}</span>
          <h2>{t("landing.bento.title")}</h2>
          <p className="lp-lead">{t("landing.bento.lead")}</p>
        </div>
        <div className="lp-bento-grid">
          <Card as="article" className="lp-bento-card lp-bento-w8 lp-bento-fixed lp-bento-c-kan">
            <Head icon="issues" title={t("landing.bento.kanban.title")} sub={t("landing.bento.kanban.sub")} />
            <Kanban active={visible} />
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w4 lp-bento-c-inbox">
            <Head icon="bell" title={t("landing.bento.inbox.title")} sub={t("landing.bento.inbox.sub")} />
            <Inbox />
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w5 lp-bento-c-row">
            <Head icon="routines" title={t("landing.bento.routine.title")} sub={t("landing.bento.routine.sub")} />
            <RoutineChart />
            <CardFooter icon={null}>
              <LpAvatar look={CAST.nina.look} px={18} name={CAST.nina.name} />
              {t("landing.bento.routine.foot")}
            </CardFooter>
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w7 lp-bento-fixed lp-bento-c-row">
            <Head icon="bulb" title={t("landing.bento.memory.title")} sub={t("landing.bento.memory.sub")} />
            <Lesson />
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w4 lp-bento-c-row">
            <Head icon="drive" title={t("landing.bento.drive.title")} sub={t("landing.bento.drive.sub")} />
            <Drive />
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w4 lp-bento-c-row">
            <Head icon="book" title={t("landing.bento.wiki.title")} sub={t("landing.bento.wiki.sub")} />
            <WikiGraph />
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w4 lp-bento-fixed lp-bento-c-row">
            <Head
              icon={<img src={POSTGRES_MARK} alt="" width={16} height={16} />}
              title={t("landing.bento.db.title")}
              sub={t("landing.bento.db.sub")}
            />
            <ReadOnlySql active={visible} />
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w6 lp-bento-c-row">
            <Head icon="message" title={t("landing.bento.forum.title")} sub={t("landing.bento.forum.sub")} />
            <Forum />
          </Card>
          <Card as="article" className="lp-bento-card lp-bento-w6 lp-bento-c-row">
            <Head icon="plug" title={t("landing.bento.connectors.title")} sub={t("landing.bento.connectors.sub")} />
            <Connectors />
            <CardFooter icon="calendar">{t("landing.bento.connectors.also")}</CardFooter>
          </Card>
        </div>
      </div>
    </section>
  );
}

/**
 * The card head of the design system (key, title, quiet line), with an h3 under the section's h2. The key is a
 * line icon, or a product's own mark at the same 16 px.
 */
function Head({ icon, title, sub }: { icon: IconName | ReactElement; title: string; sub: string }) {
  return (
    <div className="ac-card__head">
      <span className="ac-card__key" aria-hidden="true">
        {typeof icon === "string" ? <Icon name={icon} size={16} /> : icon}
      </span>
      <div className="ac-card__heading">
        <h3>{title}</h3>
        <p className="ac-card__sub">{sub}</p>
      </div>
    </div>
  );
}

function Agent({ id, px, state, className }: { id: CastKey; px: number; state?: "thinking"; className?: string }) {
  return <LpAvatar look={CAST[id].look} px={px} state={state} name={CAST[id].name} className={className} />;
}

/* ---------- Tasks: the board where cards move on their own ---------- */

type Col = 0 | 1 | 2 | 3;
type Why = "started" | "pr" | "merged" | "review";
const COLS: { key: "todo" | "progress" | "review" | "done"; icon: IconName }[] = [
  { key: "todo", icon: "stageTodo" },
  { key: "progress", icon: "stageProgress" },
  { key: "review", icon: "stageReview" },
  { key: "done", icon: "stageDone" },
];
const TASKS: { key: "t88" | "t91" | "t74" | "t70" | "t93"; n: number; agent: CastKey }[] = [
  { key: "t88", n: 88, agent: "dev" },
  { key: "t91", n: 91, agent: "nina" },
  { key: "t74", n: 74, agent: "ada" },
  { key: "t70", n: 70, agent: "theo" },
  { key: "t93", n: 93, agent: "atlas" },
];
const START: Col[] = [0, 1, 2, 3, 0];
const MOVES: [task: number, to: Col, why: Why][] = [
  [0, 1, "started"],
  [0, 2, "pr"],
  [0, 3, "merged"],
  [4, 1, "started"],
  [1, 2, "review"],
  [4, 2, "pr"],
];
const FIRST_MOVE = [0, 1, "started"] as const;
const MOVE_MS = 2600;

interface Board {
  cols: Col[];
  step: number;
  moved: number | null;
  why: Why | null;
}

/** One move of the loop; after the last one the board starts over. */
function nextBoard(b: Board): Board {
  const fresh = b.step >= MOVES.length;
  const step = fresh ? 0 : b.step;
  const [task, to, why] = MOVES[step] ?? FIRST_MOVE;
  const cols = [...(fresh ? START : b.cols)];
  cols[task] = to;
  return { cols, step: step + 1, moved: task, why };
}

function Kanban({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const [board, setBoard] = useState<Board>({ cols: START, step: 0, moved: null, why: null });
  useEffect(() => {
    if (!active || reduced) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setBoard(nextBoard);
    }, MOVE_MS);
    return () => clearInterval(timer);
  }, [active, reduced]);
  return (
    <div className="lp-bento-kan">
      {COLS.map((col, ci) => (
        <div className="lp-bento-col" key={col.key}>
          <h4>
            <Icon name={col.icon} size={14} />
            {t(`landing.bento.kanban.cols.${col.key}`)}
          </h4>
          {TASKS.map((task, ti) => {
            if (board.cols[ti] !== ci) return null;
            const moved = board.moved === ti;
            const working = ci === 1;
            return (
              <div className={cx("lp-bento-task", moved && "lp-bento-task--moved")} key={task.key}>
                <span className="lp-bento-task__t">{t(`landing.bento.kanban.tasks.${task.key}`)}</span>
                <span className="lp-bento-task__m">
                  <Agent id={task.agent} px={16} state={working ? "thinking" : undefined} />#{task.n}
                  {working && <PixelSpinner size={14} color={CAST[task.agent].color} />}
                  {moved && board.why && <span>· {t(`landing.bento.kanban.why.${board.why}`)}</span>}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------- One inbox: what waits on you on top ---------- */

function Inbox() {
  const { t } = useTranslation();
  const row = (id: CastKey, text: string, when: string) => (
    <div className="lp-bento-it">
      <Agent id={id} px={22} />
      <span className="lp-bento-it__t">{text}</span>
      <small>{when}</small>
    </div>
  );
  return (
    <div className="lp-bento-inbox">
      <AttentionNote className="lp-bento-lab">{t("landing.bento.inbox.waiting")}</AttentionNote>
      {row("atlas", t("landing.bento.inbox.rollback"), t("landing.bento.inbox.rollbackWhen"))}
      {row("theo", t("landing.bento.inbox.post"), t("landing.bento.inbox.postWhen"))}
      <span className="lp-bento-lab lp-bento-lab--quiet">{t("landing.bento.inbox.before")}</span>
      {row("dev", t("landing.bento.inbox.reactions"), t("landing.bento.inbox.reactionsWhen"))}
      {row("nina", t("landing.bento.inbox.report"), t("landing.bento.inbox.reportWhen"))}
    </div>
  );
}

/* ---------- Routines: Nina's weekly report, pixel bars in her colors ---------- */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const BARS = [0.42, 0.5, 0.46, 0.58, 0.55, 0.63, 0.6, 0.7, 0.66, 0.74, 0.79, 0.9];
const CW = 120;
const CH = 44;

function RoutineChart() {
  const { t } = useTranslation();
  const { theme } = useLanding();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current?.getContext("2d");
    if (!g) return;
    const tones = bodyTones(CAST.nina.color, theme === "dark");
    const last = tones.length - 1;
    g.clearRect(0, 0, CW, CH);
    BARS.forEach((v, i) => {
      const h = Math.round(v * (CH - 2));
      const x0 = 1 + i * 10;
      for (let y = CH - h; y < CH; y++) {
        for (let x = x0; x < x0 + 8; x++) {
          // Lighter at the top of each bar, dithered between tones; older weeks are checkered.
          const f = ((y - (CH - h)) / h) * (last - 0.01);
          const lo = Math.floor(f);
          const tn = lo + (f - lo > (BAYER[(x & 3) + (y & 3) * 4] ?? 0.5) ? 1 : 0);
          if (i !== BARS.length - 1 && ((x + y) & 1) !== 0 && f <= 1) continue;
          g.fillStyle = tones[Math.min(last, last - tn)] ?? "#888888";
          g.fillRect(x, y, 1, 1);
        }
      }
    });
  }, [theme]);
  return (
    <canvas
      className="lp-bento-chart"
      ref={ref}
      width={CW}
      height={CH}
      role="img"
      aria-label={t("landing.bento.routine.chart")}
    />
  );
}

/* ---------- Memory: a lesson Dev proposed ---------- */

function Lesson() {
  const { t } = useTranslation();
  const [state, setState] = useState<"open" | "ok" | "no">("open");
  const joy = useJoy();
  const agent = CAST.dev.name;
  const decide = (s: "ok" | "no") => {
    setState(s);
    if (s === "ok") joy.trigger(1600);
  };
  return (
    <div className="lp-bento-lesson">
      <div className="lp-bento-lesson__m">
        <Agent id="dev" px={18} className={joy.className} />
        {state === "open"
          ? t("landing.bento.memory.by", { agent })
          : state === "ok"
            ? t("landing.bento.memory.ruled", { agent })
            : t("landing.bento.memory.discarded")}
      </div>
      <div className="lp-bento-lesson__t">
        {state === "open" ? (
          <RichText text={t("landing.bento.memory.lesson")} />
        ) : state === "ok" ? (
          t("landing.bento.memory.ruledText", { agent })
        ) : (
          t("landing.bento.memory.discardedText", { agent })
        )}
      </div>
      <div className="lp-bento-lesson__acts">
        {state === "open" ? (
          <>
            <Button variant="primary" size="sm" onClick={() => decide("ok")}>
              {t("landing.bento.memory.makeRule")}
            </Button>
            <Button size="sm" onClick={() => decide("no")}>
              {t("landing.bento.memory.discard")}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setState("open")}>
            {t("landing.bento.memory.again")}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ---------- Drive ---------- */

function Drive() {
  const { t } = useTranslation();
  const file = (icon: IconName, name: string, meta: string) => (
    <div className="lp-bento-file">
      <span className="lp-bento-file__th">
        <Icon name={icon} size={16} />
      </span>
      <div>
        {name}
        <small>{meta}</small>
      </div>
    </div>
  );
  return (
    <div className="lp-bento-files">
      {file("table", t("landing.bento.drive.invoices"), t("landing.bento.drive.invoicesMeta"))}
      {file("file", t("landing.bento.drive.weekly"), t("landing.bento.drive.weeklyMeta"))}
      {file("pullRequest", t("landing.bento.drive.diff"), t("landing.bento.drive.diffMeta"))}
    </div>
  );
}

/* ---------- Wiki: linked pages ---------- */

type WikiPage = "context" | "voice" | "customers" | "deploy" | "pricing" | "onboarding";
const WIKI_NODES: [x: number, y: number, key: WikiPage][] = [
  [150, 80, "context"],
  [60, 40, "voice"],
  [70, 125, "customers"],
  [240, 38, "deploy"],
  [250, 120, "pricing"],
  [150, 145, "onboarding"],
];
const WIKI_EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  [3, 4],
  [1, 2],
];

function WikiGraph() {
  const { t } = useTranslation();
  const label = (key: WikiPage) =>
    key === "context" ? t("landing.bento.wiki.context", { org: ORGS.shop.name }) : t(`landing.bento.wiki.${key}`);
  return (
    <div className="lp-bento-wiki">
      <svg viewBox="0 0 300 160" role="img" aria-label={t("landing.bento.wiki.graph")}>
        {WIKI_EDGES.map(([a, b]) => {
          const [x1, y1] = WIKI_NODES[a] ?? [0, 0];
          const [x2, y2] = WIKI_NODES[b] ?? [0, 0];
          return <line key={`${a}-${b}`} className="lp-bento-wiki__edge" x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
        {WIKI_NODES.map(([x, y, key], i) => {
          const text = label(key);
          const w = text.length * 6.8 + 16;
          return (
            <g key={key} className={cx("lp-bento-wiki__node", i === 0 && "lp-bento-wiki__node--main")}>
              <rect x={x - w / 2} y={y - 11} width={w} height={22} rx={7} />
              <text x={x} y={y + 4} textAnchor="middle">
                {text}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ---------- Read-only database: a query runs, a write is blocked ---------- */

/** The read runs; the write is blocked. */
const SQL = ["read", "write"] as const;

function ReadOnlySql({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const runner = useRunner();
  const [shown, setShown] = useState({ which: 0, chars: Number.POSITIVE_INFINITY, done: true });
  useEffect(() => {
    if (!active || reduced) {
      runner.stop();
      setShown({ which: 0, chars: Number.POSITIVE_INFINITY, done: true });
      return;
    }
    runner.start(async (r) => {
      for (let n = 0; r.alive(); n++) {
        const which = n % SQL.length;
        const len = t(`landing.bento.db.${SQL[which] ?? "read"}`).length;
        for (let i = 1; i <= len && r.alive(); i += 2) {
          setShown({ which, chars: i, done: false });
          await r.sleep(22);
        }
        if (!r.alive()) return;
        setShown({ which, chars: len, done: false });
        await r.sleep(400);
        if (!r.alive()) return;
        setShown({ which, chars: len, done: true });
        await r.sleep(3200);
      }
    });
    return () => runner.stop();
  }, [active, reduced, runner, t]);
  const kind = SQL[shown.which] ?? "read";
  return (
    <pre className="lp-bento-sql">
      {t(`landing.bento.db.${kind}`).slice(0, shown.chars)}
      {shown.done && (
        <>
          {"\n"}
          <span className={kind === "read" ? "lp-bento-sql__ok" : "lp-bento-sql__no"}>
            {t(`landing.bento.db.${kind}Result`)}
          </span>
        </>
      )}
    </pre>
  );
}

/* ---------- Forum: two views and the summary ---------- */

function Forum() {
  const { t } = useTranslation();
  const view = (id: CastKey, text: string) => (
    <div className="lp-bento-view">
      <Agent id={id} px={20} />
      <span>
        <RichText text={text} />
      </span>
    </div>
  );
  return (
    <>
      <div className="lp-bento-views">
        {view("theo", t("landing.bento.forum.theo"))}
        {view("atlas", t("landing.bento.forum.atlas"))}
      </div>
      <div className="lp-bento-synth">
        <RichText text={t("landing.bento.forum.synth")} />
      </div>
    </>
  );
}

/* ---------- Connectors ---------- */

const BRANDS = ["GitHub", "Sentry", "Linear", "Notion", "Google Drive", "Gmail", null, "Stripe", "Postgres", "Figma"];
const BRANDS_END = ["HubSpot", "Intercom"];

function Connectors() {
  const { t } = useTranslation();
  const chips: ReactNode[] = [...BRANDS, ...BRANDS_END].map((name) => {
    const label = name ?? t("landing.bento.connectors.calendar");
    return (
      <Chip icon="plug" key={label}>
        {label}
      </Chip>
    );
  });
  return (
    <div className="lp-bento-logos">
      {chips}
      <Chip icon="plus">{t("landing.bento.connectors.own")}</Chip>
    </div>
  );
}
