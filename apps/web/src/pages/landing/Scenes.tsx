import {
  type AgentState,
  Avatar,
  Button,
  Chip,
  cx,
  Icon,
  Message,
  MessageText,
  PixelSpinner,
  WorkSummary,
} from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST, PEOPLE } from "./cast";
import { useLanding } from "./context";
import { useFormat } from "./format";
import { useJoy, useRunner } from "./hooks";
import { type Decision, LpApproval } from "./kit/Approval";
import { LpAvatar } from "./LpAvatar";
import { RichText } from "./rich";
import "./Story.css";

/**
 * The five scenes of "01 · Como funciona". `run` counts activations: each
 * time it changes (and isn't 0) the scene plays again. Every scene keeps a
 * fixed height while it plays (hidden rows, or the final state as an
 * invisible ghost underneath), so the page never moves.
 */
export interface SceneProps {
  run: number;
}

const dev = CAST.dev;
const atlas = CAST.atlas;
const nina = CAST.nina;
const marina = PEOPLE.marina;

export function Caret({ ink }: { ink?: boolean }) {
  return <span className={ink ? "lp-caret lp-caret--ink" : "lp-caret"} aria-hidden="true" />;
}

/** Live content over invisible copies of its biggest states: the box is as tall as the tallest. */
function Stable({ ghosts, children }: { ghosts: ReactNode[]; children: ReactNode }) {
  return (
    <div className="lp-story-stack">
      {ghosts.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
        <div key={i} className="lp-story-ghost" aria-hidden="true" inert>
          {g}
        </div>
      ))}
      <div className="lp-story-live">{children}</div>
    </div>
  );
}

/** 1. The request: Marina types in the channel, without tagging anyone. */
export function SceneRequest({ run }: SceneProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { reduced } = useLanding();
  const runner = useRunner();
  const text = t("landing.story.request.text");
  const [shown, setShown] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!run || reduced) return;
    runner.start(async (r) => {
      for (let i = 1; i <= text.length; i++) {
        if (!r.alive()) return;
        setShown(i);
        await r.sleep(38);
      }
      if (r.alive()) setShown(undefined);
    });
  }, [run, runner, text, reduced]);
  return (
    <div className="lp-story-box">
      <div className="lp-story-float">
        <Message
          avatar={<Avatar name={marina.name} initials={marina.initials} />}
          author={marina.short}
          time={fmt.time(14, 21)}
        >
          <MessageText>
            {/* The whole sentence holds the space; the typed part sits on top. */}
            <span className="lp-story-type">
              <span className="lp-story-type__ghost" aria-hidden="true">
                {text}
              </span>
              <span className="lp-story-type__live">
                {shown === undefined ? text : text.slice(0, shown)}
                {shown !== undefined && <Caret ink />}
              </span>
            </span>
          </MessageText>
        </Message>
      </div>
      <div className="lp-story-composer" aria-hidden="true">
        <span>{t("landing.story.request.composer", { channel: t("landing.channel.engineering") })}</span>
        <span className="lp-story-send">
          <Icon name="send" size={16} />
        </span>
      </div>
    </div>
  );
}

/** 2. Who answers: a wire lights up toward Dev, then Dev asks Atlas in private. */
export function SceneWho({ run }: SceneProps) {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const runner = useRunner();
  const path = useRef<SVGPathElement>(null);
  const [devState, setDevState] = useState<AgentState>("idle");
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!run) return;
    const p = path.current;
    if (p) {
      let len = 160;
      try {
        if (typeof p.getTotalLength === "function") len = p.getTotalLength() || 160;
      } catch {
        // No layout (tests): a fixed length.
      }
      p.style.transition = "none";
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = reduced ? "0" : String(len);
      p.getBoundingClientRect();
      p.style.transition = reduced ? "none" : "stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1) .2s";
      p.style.strokeDashoffset = "0";
    }
    runner.start(async (r) => {
      setAsked(false);
      setDevState("thinking");
      await r.sleep(1600);
      if (!r.alive()) return;
      setAsked(true);
      await r.sleep(1600);
      if (!r.alive()) return;
      setDevState("idle");
    });
  }, [run, runner, reduced]);
  const atlasThinks = asked && devState === "thinking";
  return (
    <div className="lp-story-box lp-story-who">
      <Chip icon="message" className="lp-story-center">
        {t("landing.story.who.quote")}
      </Chip>
      <svg className="lp-story-wires" viewBox="0 0 300 90" preserveAspectRatio="none" aria-hidden="true">
        <path className="lp-story-wire" d="M150 0 V90" />
        <path className="lp-story-wire" d="M150 0 C150 45 250 45 250 90" />
        <path ref={path} className="lp-story-wire lp-story-wire--live" d="M150 0 C150 45 50 45 50 90" />
      </svg>
      <div className="lp-story-agents">
        <div>
          <LpAvatar look={dev.look} px={52} name={dev.name} state={devState} />
          <b>{dev.name}</b>
          {t("landing.story.who.answers")}
        </div>
        <div className={cx(!asked && "lp-story-off")}>
          <LpAvatar look={atlas.look} px={52} name={atlas.name} state={atlasThinks ? "thinking" : "idle"} />
          <b>{atlas.name}</b>
          {asked ? t("landing.story.who.consulted") : t("landing.story.who.out")}
        </div>
        <div className="lp-story-off">
          <LpAvatar look={nina.look} px={52} name={nina.name} />
          <b>{nina.name}</b>
          {t("landing.story.who.out")}
        </div>
      </div>
      <svg
        className="lp-story-wires lp-story-wires--ask"
        viewBox="0 0 300 30"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className={cx("lp-story-wire lp-story-wire--ask", asked && "lp-on")} d="M50 0 C50 26 150 26 150 0" />
      </svg>
      <Chip icon="message" className={cx("lp-story-center lp-story-fade", asked && "lp-on")} aria-hidden={!asked}>
        {t("landing.story.who.asks", { from: dev.name, to: atlas.name })}
      </Chip>
      <Chip icon="lock" className="lp-story-center">
        {t("landing.story.who.noPermission")}
      </Chip>
    </div>
  );
}

type WorkPhase = "work" | "done" | "stopped";
type WorkState = { steps: number; nudge: boolean; phase: WorkPhase };

interface WorkView extends WorkState {
  devState?: AgentState;
  joyClass?: string;
  onStop?: () => void;
}

/** The work scene at one moment (the live scene and its ghosts). */
function WorkFrame({ steps, nudge, phase, devState = "idle", joyClass, onStop }: WorkView) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const labels = [
    t("landing.story.work.s1"),
    t("landing.story.work.s2", { agent: atlas.name }),
    t("landing.story.work.s3"),
    t("landing.story.work.s4"),
  ];
  const summary =
    phase === "done"
      ? t("landing.story.work.summary", { n: 4, dur: fmt.dur(41) })
      : phase === "stopped"
        ? t("landing.stopped")
        : t("landing.working");
  return (
    <div className="lp-story-box">
      <div className="lp-story-float">
        <Message
          avatar={<LpAvatar look={dev.look} name={dev.name} state={devState} className={joyClass} />}
          author={dev.name}
          time={fmt.time(14, 21)}
          agent
        >
          <WorkSummary
            defaultOpen
            summary={summary}
            steps={labels.slice(0, steps).map((label, i) => ({ key: String(i), label }))}
          />
          {phase === "work" && (
            <div className="lp-story-foot">
              <PixelSpinner size={14} color={dev.color} />
              <Button variant="ghost" size="sm" icon="stop" onClick={onStop}>
                {t("landing.stop")}
              </Button>
            </div>
          )}
          {phase === "stopped" && <MessageText>{t("landing.story.work.stoppedText")}</MessageText>}
        </Message>
      </div>
      {nudge && (
        <div className="lp-story-float lp-story-float--you lp-enter">
          <Message
            avatar={<Avatar name={t("landing.you")} initials={t("landing.youInitials")} />}
            author={t("landing.you")}
            time={fmt.time(14, 22)}
          >
            <MessageText>{t("landing.story.work.nudge")}</MessageText>
            <span className="lp-story-seen">
              <LpAvatar look={dev.look} size="xs" name={dev.name} />
              {t("landing.read", { name: dev.name })}
            </span>
          </Message>
        </div>
      )}
      {phase === "done" && (
        <div className="lp-story-float lp-enter">
          <Message
            avatar={<LpAvatar look={dev.look} name={dev.name} />}
            author={dev.name}
            time={fmt.time(14, 22)}
            agent
          >
            <MessageText>
              <RichText text={t("landing.story.work.answer")} />
            </MessageText>
          </Message>
        </div>
      )}
    </div>
  );
}

/** 3. The work: steps appear, a message arrives mid-run and Dev changes course. Stop works. */
export function SceneWork({ run }: SceneProps) {
  const runner = useRunner();
  const joy = useJoy();
  const { trigger } = joy;
  // Before it plays (or without IntersectionObserver) the scene shows how it ends.
  const [view, setView] = useState<WorkState>({ steps: 4, nudge: true, phase: "done" });
  useEffect(() => {
    if (!run) return;
    runner.start(async (r) => {
      const at = (ms: number, next: Partial<WorkState>) =>
        r.sleep(ms).then(() => {
          if (!r.alive()) return false;
          setView((v) => ({ ...v, ...next }));
          return true;
        });
      setView({ steps: 0, nudge: false, phase: "work" });
      if (!(await at(800, { steps: 1 }))) return;
      if (!(await at(900, { steps: 2 }))) return;
      if (!(await at(700, { nudge: true }))) return;
      if (!(await at(900, { steps: 3 }))) return;
      if (!(await at(900, { steps: 4 }))) return;
      setView((v) => ({ ...v, phase: "done" }));
      trigger(1400);
    });
  }, [run, runner, trigger]);
  const stop = () => {
    runner.stop();
    setView((v) => ({ ...v, phase: "stopped" }));
  };
  return (
    <Stable
      ghosts={[
        <WorkFrame key="done" steps={4} nudge phase="done" />,
        <WorkFrame key="stopped" steps={3} nudge phase="stopped" />,
      ]}
    >
      <WorkFrame
        {...view}
        devState={view.phase === "work" ? "thinking" : "idle"}
        joyClass={joy.className}
        onStop={stop}
      />
    </Stable>
  );
}

/** The approval scene at one moment (the live scene and its ghosts). */
function ApprovalFrame({
  decision,
  onDecide,
  onAgain,
  joyClass,
}: {
  decision?: Decision;
  onDecide?: (d: Decision) => void;
  onAgain?: () => void;
  joyClass?: string;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const decidedLabel =
    decision === "yes"
      ? t("landing.approval.approved", { name: marina.short, time: fmt.time(14, 23) })
      : t("landing.story.approval.refusedLesson", { name: marina.short, agent: atlas.name });
  return (
    <div className="lp-story-box">
      <LpApproval
        who={null}
        title={t("landing.story.approval.title", { agent: atlas.name })}
        detail={t("landing.story.approval.detail")}
        rows={[
          [t("landing.approval.action"), t("landing.story.approval.actionValue")],
          [t("landing.approval.service"), "checkout-api"],
          [t("landing.approval.who"), marina.short],
        ]}
        color={atlas.color}
        fuse={22 / 24}
        waitingLabel={t("landing.approval.expires", { h: 24 })}
        decided={decision}
        decidedLabel={decidedLabel}
        onDecide={onDecide}
        hint={t("landing.story.approval.hint", { name: marina.short })}
      />
      {decision && (
        <>
          <div className="lp-story-float lp-enter">
            <Message
              avatar={<LpAvatar look={atlas.look} name={atlas.name} className={joyClass} />}
              author={atlas.name}
              time={fmt.time(14, 25)}
              agent
            >
              <MessageText>
                {decision === "yes"
                  ? t("landing.story.approval.yes", { agent: dev.name })
                  : t("landing.story.approval.no", { agent: dev.name })}
              </MessageText>
            </Message>
          </div>
          <Button variant="ghost" size="sm" icon="repeat" className="lp-story-start" onClick={onAgain}>
            {t("landing.story.approval.again")}
          </Button>
        </>
      )}
    </div>
  );
}

/** 4. The approval: hold to approve; a refusal becomes a lesson. The visitor decides. */
export function SceneApproval(_props: SceneProps) {
  const joy = useJoy();
  const [decision, setDecision] = useState<Decision | undefined>(undefined);
  return (
    <Stable ghosts={[<ApprovalFrame key="wait" />, <ApprovalFrame key="no" decision="no" />]}>
      <ApprovalFrame
        decision={decision}
        joyClass={joy.className}
        onDecide={(d) => {
          setDecision(d);
          joy.trigger(1800);
        }}
        onAgain={() => setDecision(undefined)}
      />
    </Stable>
  );
}

const LEDGER = [
  { key: "router", agent: null, tokens: 412, pct: 0.1 },
  { key: "investigation", agent: dev, tokens: 2188, pct: 1.6 },
  { key: "consult", agent: atlas, tokens: 640, pct: 0.4 },
  { key: "answer", agent: dev, tokens: 812, pct: 0.6 },
  { key: "rollback", agent: atlas, tokens: 1304, pct: 0.9 },
] as const;
const CELLS = 20;
const USED = 63;
const LIT = Math.round((USED / 100) * CELLS);

/** 5. The receipt: each call lands in the ledger by agent; the budget in %, money only for admins. */
export function SceneLedger({ run }: SceneProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const runner = useRunner();
  // Full until it plays, like the other scenes.
  const [rows, setRows] = useState<number>(LEDGER.length);
  const [cells, setCells] = useState(LIT);
  useEffect(() => {
    if (!run) return;
    runner.start(async (r) => {
      setRows(0);
      setCells(0);
      for (let i = 1; i <= LEDGER.length; i++) {
        await r.sleep(380);
        if (!r.alive()) return;
        setRows(i);
      }
      for (let i = 1; i <= LIT; i++) {
        await r.sleep(60);
        if (!r.alive()) return;
        setCells(i);
      }
    });
  }, [run, runner]);
  // While the cells fill, the number follows them; at the end it shows the exact value.
  const pct = cells === 0 ? 0 : cells < LIT ? Math.round((cells / CELLS) * 100) : USED;
  const budgetLabel = t("landing.story.ledger.month", { agent: dev.name, month: fmt.month() });
  return (
    <div className="lp-story-box">
      <div className="lp-story-float lp-story-float--pad">
        <table className="lp-story-ledger">
          <thead>
            <tr>
              <th>{t("landing.story.ledger.call")}</th>
              <th>{t("landing.story.ledger.tokens")}</th>
              <th>{t("landing.story.ledger.budget")}</th>
            </tr>
          </thead>
          <tbody>
            {LEDGER.map((row, i) => (
              <tr key={row.key} className={cx(i < rows ? "lp-on" : "lp-story-hidden")} aria-hidden={i >= rows}>
                <td>
                  <span className="lp-story-call">
                    {row.agent && <LpAvatar look={row.agent.look} size="xs" name={row.agent.name} />}
                    {t(`landing.story.ledger.${row.key}`, { agent: row.agent?.name })}
                  </span>
                </td>
                <td>{fmt.num(row.tokens)}</td>
                <td>{fmt.num(row.pct, 1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="lp-story-bud">
          <LpAvatar look={dev.look} size="xs" name={dev.name} />
          <span className="lp-story-bud__label">{budgetLabel}</span>
          <span className="lp-story-bud__bar" aria-hidden="true">
            {Array.from({ length: CELLS }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed cells
              <i key={i} className={cx(i < cells && "lp-on")} />
            ))}
          </span>
          <span className="lp-story-bud__pc">{fmt.num(pct)}%</span>
        </div>
      </div>
      <div className="lp-story-chips">
        <Chip icon="check">{t("landing.story.ledger.checked")}</Chip>
        <Chip icon="lock">{t("landing.story.ledger.money")}</Chip>
      </div>
    </div>
  );
}
