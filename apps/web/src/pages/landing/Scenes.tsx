import {
  type AgentState,
  ApprovalCard,
  Avatar,
  Button,
  Chip,
  Icon,
  Kbd,
  Message,
  MessageText,
  Meter,
  WorkSummary,
} from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanding } from "./context";
import { AGENTS, MODELS, PEOPLE } from "./data";
import { useFormat } from "./format";
import { useJoy, useRunner } from "./hooks";
import { SampleAgent } from "./LpAvatar";
import { RichText, tokenCount } from "./rich";

/**
 * The five scenes of "Como funciona". `run` counts activations: each time it
 * changes (and isn't 0) the scene plays again.
 */
export interface SceneProps {
  run: number;
}

const marina = PEOPLE.marina;
const lia = AGENTS.lia;

export function Caret({ ink }: { ink?: boolean }) {
  return <span className={ink ? "lp-caret lp-caret--ink" : "lp-caret"} aria-hidden="true" />;
}

/** 1. The request: Marina types her message; the composer below waits. */
export function SceneRequest({ run }: SceneProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const runner = useRunner();
  const text = t("landing.demo.incident.ask", { agent: lia.name });
  const [shown, setShown] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!run) return;
    const n = tokenCount(text);
    runner.start(async (r) => {
      for (let i = 1; i <= n; i++) {
        if (!r.alive()) return;
        setShown(i);
        await r.sleep(55);
      }
      if (r.alive()) setShown(undefined);
    });
  }, [run, runner, text]);
  return (
    <div className="lp-vbox">
      <div className="lp-float">
        <Message
          avatar={<Avatar name={marina.name} initials={marina.initials} />}
          author={marina.name}
          time={fmt.time(14, 21)}
        >
          <MessageText>
            <RichText text={text} upto={shown} />
            {shown !== undefined && <Caret ink />}
          </MessageText>
        </Message>
      </div>
      <div className="lp-composer lp-composer--static" aria-hidden="true">
        <div className="lp-pills">
          <span className="lp-cpill">
            <SampleAgent agent="lia" size="xs" />
            {lia.name}
          </span>
        </div>
        <div className="lp-row">
          <span className="lp-composer-ph">
            {t("landing.scenes.reply", { channel: t("landing.demo.channel.eng") })}
          </span>
          <span className="lp-send lp-send--on">
            <span className="lp-lbl">{t("landing.demo.send")}</span>
            <Kbd className="lp-lbl">↵</Kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 2. The router: a wire lights up toward the one agent who answers. */
export function SceneRouter({ run }: SceneProps) {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const path = useRef<SVGPathElement>(null);
  const [liaState, setLiaState] = useState<AgentState>("idle");
  useEffect(() => {
    if (!run) return;
    const p = path.current;
    if (p) {
      let len = 200;
      try {
        if (typeof p.getTotalLength === "function") len = p.getTotalLength() || 200;
      } catch {
        // No layout (tests): a fixed length.
      }
      p.style.transition = "none";
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = String(len);
      p.getBoundingClientRect();
      p.style.transition = reduced ? "none" : "stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1) .2s";
      p.style.strokeDashoffset = "0";
    }
    setLiaState("thinking");
  }, [run, reduced]);
  return (
    <div className="lp-vbox lp-router">
      <Chip icon="message" className="lp-router-quote">
        {t("landing.scenes.quote")}
      </Chip>
      <svg className="lp-wires lp-wires--short" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">
        <path className="lp-wire lp-wire--live" d="M150 0 V40" />
      </svg>
      <span className="lp-rnode">
        <Icon name="agent" />
        {t("landing.scenes.router")}{" "}
        <small>
          {MODELS.router} · {t("landing.ms", { n: 180 })}
        </small>
      </span>
      <svg className="lp-wires" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="lp-wire" d="M150 0 V100" />
        <path className="lp-wire" d="M150 0 C150 50 250 50 250 100" />
        <path ref={path} className="lp-wire lp-wire--live" d="M150 0 C150 50 50 50 50 100" />
      </svg>
      <div className="lp-ragents">
        <div>
          <SampleAgent agent="lia" size="lg" state={liaState} />
          <b>{lia.name}</b>
          {t("landing.scenes.answers")}
        </div>
        <div className="lp-off">
          <SampleAgent agent="teo" size="lg" />
          <b>{AGENTS.teo.name}</b>
          {t("landing.scenes.out")}
        </div>
        <div className="lp-off">
          <SampleAgent agent="bia" size="lg" />
          <b>{AGENTS.bia.name}</b>
          {t("landing.scenes.out")}
        </div>
      </div>
      <Chip icon="lock" className="lp-router-note">
        {t("landing.scenes.routerNote")}
      </Chip>
    </div>
  );
}

/** 3. The work: steps appear one by one, then the answer is typed. */
export function SceneWork({ run }: SceneProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const runner = useRunner();
  const labels = [
    t("landing.demo.incident.s1"),
    t("landing.demo.incident.s2"),
    t("landing.scenes.workStep3", { agent: lia.name }),
  ];
  const seconds = [4, 9, 26];
  const text = t("landing.scenes.workText");
  const [steps, setSteps] = useState<boolean[]>([]);
  const [done, setDone] = useState(false);
  const [shown, setShown] = useState<number | undefined>(0);
  const [state, setState] = useState<AgentState>("idle");
  useEffect(() => {
    if (!run) return;
    const n = tokenCount(text);
    runner.start(async (r) => {
      setSteps([]);
      setDone(false);
      setShown(0);
      setState("thinking");
      let acc: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        acc = [...acc, true];
        setSteps(acc);
        await r.sleep(850);
        if (!r.alive()) return;
        acc = acc.map((p, j) => (j === i ? false : p));
        setSteps(acc);
      }
      setDone(true);
      setState("writing");
      for (let i = 1; i <= n; i++) {
        if (!r.alive()) return;
        setShown(i);
        await r.sleep(60);
      }
      if (!r.alive()) return;
      setShown(undefined);
      setState("idle");
    });
  }, [run, runner, text]);
  return (
    <div className="lp-vbox">
      <div className="lp-float">
        <Message avatar={<SampleAgent agent="lia" state={state} />} author={lia.name} time={fmt.time(14, 21)} agent>
          <WorkSummary
            defaultOpen
            summary={done ? t("landing.demo.incident.summary") : t("landing.demo.working")}
            steps={steps.map((pending, i) => ({
              key: String(i),
              label: <RichText text={labels[i] ?? ""} />,
              pending,
              time: pending ? undefined : fmt.dur(seconds[i] ?? 0),
            }))}
          />
          {shown !== 0 && (
            <MessageText>
              <RichText text={text} upto={shown} />
              {shown !== undefined && <Caret />}
            </MessageText>
          )}
        </Message>
      </div>
    </div>
  );
}

/** 4. The approval: a working card; the agent answers either way. */
export function SceneApproval() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const joy = useJoy();
  const [decision, setDecision] = useState<"wait" | "yes" | "no">("wait");
  const decide = (d: "yes" | "no") => {
    setDecision(d);
    joy.trigger(1600);
  };
  const agentAvatar = <SampleAgent agent="lia" />;
  if (decision === "wait")
    return (
      <div className="lp-vbox">
        <ApprovalCard
          wide
          status="waiting"
          avatar={agentAvatar}
          who={null}
          statusLabel={t("landing.approval.waiting")}
          title={t("landing.approval.title", { agent: lia.name })}
          detail={t("landing.scenes.approvalDetail", { owner: marina.name, agent: lia.name })}
          actions={
            <>
              <Button variant="primary" size="sm" icon="check" onClick={() => decide("yes")}>
                {t("landing.approval.approve")}
              </Button>
              <Button size="sm" onClick={() => decide("no")}>
                {t("landing.approval.refuse")}
              </Button>
            </>
          }
        />
      </div>
    );
  const yes = decision === "yes";
  const label = { name: marina.short, time: fmt.time(14, 23) };
  return (
    <div className="lp-vbox">
      <ApprovalCard
        wide
        compact
        status={yes ? "approved" : "refused"}
        avatar={agentAvatar}
        who={null}
        statusLabel={yes ? t("landing.approval.approved", label) : t("landing.approval.refused", label)}
        title={t("landing.approval.decided")}
      />
      <div className="lp-float lp-enter">
        <Message
          avatar={<SampleAgent agent="lia" className={joy.className} />}
          author={lia.name}
          time={fmt.time(14, 25)}
          agent
        >
          <MessageText>{yes ? t("landing.scenes.yesShort") : t("landing.scenes.noShort")}</MessageText>
        </Message>
      </div>
      <Button variant="ghost" size="sm" icon="repeat" className="lp-start" onClick={() => setDecision("wait")}>
        {t("landing.scenes.again")}
      </Button>
    </div>
  );
}

const LEDGER = [
  { who: "router", model: MODELS.router, tokens: 412, cost: 0.0004 },
  { who: "investigation", model: MODELS.sonnet, tokens: 2188, cost: 0.013 },
  { who: "answer", model: MODELS.sonnet, tokens: 812, cost: 0.0049 },
  { who: "rollback", model: MODELS.sonnet, tokens: 1304, cost: 0.0079 },
] as const;

/** 5. The receipt: each call of this conversation lands in the ledger. */
export function SceneLedger({ run }: SceneProps) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const runner = useRunner();
  const [rows, setRows] = useState(0);
  const [used, setUsed] = useState(0);
  useEffect(() => {
    if (!run) return;
    runner.start(async (r) => {
      setRows(0);
      setUsed(0);
      await r.sleep(100);
      if (!r.alive()) return;
      setUsed(31.42);
      for (let i = 1; i <= LEDGER.length; i++) {
        if (!r.alive()) return;
        setRows(i);
        await r.sleep(380);
      }
    });
  }, [run, runner]);
  const month = fmt.month();
  return (
    <div className="lp-vbox">
      <div className="lp-float lp-float--pad">
        <table className="lp-ledger">
          <thead>
            <tr>
              <th>{t("landing.scenes.call")}</th>
              <th>{t("landing.scenes.model")}</th>
              <th>{t("landing.scenes.tokens")}</th>
              <th>{t("landing.scenes.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {LEDGER.slice(0, rows).map((row) => (
              <tr className="lp-new" key={row.who}>
                <td>
                  {row.who === "router"
                    ? t("landing.scenes.router")
                    : t(`landing.scenes.${row.who}`, { agent: lia.name })}
                </td>
                <td className="lp-faint">{row.model}</td>
                <td>{fmt.num(row.tokens)}</td>
                <td>{fmt.usd(row.cost, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="lp-ledger-budget">
          <div className="lp-ledger-budget__line">
            <span className="lp-muted">{t("landing.scenes.budget", { agent: lia.name, month })}</span>
            <span>
              <b>{fmt.usd(31.42)}</b>{" "}
              <span className="lp-faint">{t("landing.scenes.of", { cap: fmt.usd(50, 0) })}</span>
            </span>
          </div>
          <Meter value={used} max={50} label={t("landing.scenes.budget", { agent: lia.name, month })} />
        </div>
      </div>
      <Chip icon="check" className="lp-start">
        {t("landing.scenes.checked")}
      </Chip>
    </div>
  );
}
