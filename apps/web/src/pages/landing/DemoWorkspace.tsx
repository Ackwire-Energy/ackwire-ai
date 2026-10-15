import {
  type AgentState,
  ApprovalCard,
  Avatar,
  AvatarStack,
  Button,
  CountBadge,
  cx,
  Icon,
  type IconName,
  Kbd,
  Mention,
  Message,
  MessageText,
  Reaction,
  Reactions,
  Segmented,
  WorkSummary,
} from "@agenteschat/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanding } from "./context";
import { AGENT_KEYS, AGENTS, type AgentKey, MODELS, ORG, PEOPLE, type PersonKey } from "./data";
import { useFormat } from "./format";
import { type Run, useIntersection, useRunner } from "./hooks";
import { SampleAgent } from "./LpAvatar";
import { RichText, tokenCount } from "./rich";
import { Caret } from "./Scenes";

type Scenario = "incidente" | "relatorio" | "roteador";
const SCENARIOS: Scenario[] = ["incidente", "relatorio", "roteador"];
const SC: Record<
  Scenario,
  { channel: "eng" | "data" | "marketing"; agent: AgentKey; members: (AgentKey | PersonKey)[]; icon: IconName }
> = {
  incidente: { channel: "eng", agent: "lia", members: ["marina", "rafael", "lia", "teo"], icon: "alert" },
  relatorio: { channel: "data", agent: "teo", members: ["camila", "marina", "teo"], icon: "routines" },
  roteador: { channel: "marketing", agent: "bia", members: ["rafael", "camila", "bia", "lia"], icon: "members" },
};
const ROLE: Record<AgentKey, "eng" | "data" | "content"> = { lia: "eng", teo: "data", bia: "content" };
const isAgent = (k: string): k is AgentKey => k in AGENTS;

interface Step {
  label: string;
  time?: string;
  pending: boolean;
}
interface AgentItem {
  id: number;
  kind: "agent";
  agent: AgentKey;
  time: string;
  state: AgentState;
  work?: { steps: Step[]; summary: string | null; open: boolean };
  text?: string;
  shown?: number;
  approval?: "wait" | "yes" | "no";
  file?: { kind: "chart" | "doc"; title: string; sub: string };
  meta?: string;
  reacts?: { icon: IconName; label: string; n: number; on: boolean }[];
  cta?: boolean;
}
interface PersonItem {
  id: number;
  kind: "person";
  person: PersonKey | "you";
  text: string;
  /** The visitor's own words: shown as typed, after a mention of `mention`. */
  mention?: string;
  time: string;
}
interface SysItem {
  id: number;
  kind: "sys";
  icon: IconName;
  text: string;
}
type Item = AgentItem | PersonItem | SysItem;
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type NewItem = WithoutId<Item>;

const idle: Record<AgentKey, AgentState> = { lia: "idle", teo: "idle", bia: "idle" };

/** The playable demo: a sample workspace with three scenarios, a working approval and a composer. */
export function DemoWorkspace() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { scrollTo } = useLanding();
  const runner = useRunner();
  const inputId = useId();
  const win = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const seq = useRef(1);
  const started = useRef(false);
  const replies = useRef(0);
  const approveRef = useRef<((choice: "yes" | "no" | "cancel") => void) | null>(null);
  const [scenario, setScenario] = useState<Scenario>("incidente");
  const [items, setItems] = useState<Item[]>(() => [
    {
      id: 1,
      kind: "person",
      person: "marina",
      text: t("landing.demo.incident.ask", { agent: AGENTS.lia.name }),
      time: fmt.time(14, 21),
    },
  ]);
  const [side, setSide] = useState(idle);
  const [pending, setPending] = useState(0);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const el = feed.current;
    if (el && items.length) el.scrollTop = el.scrollHeight;
  }, [items]);

  const add = (item: NewItem) => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { ...item, id } as Item]);
    return id;
  };
  const patch = (id: number, fn: (a: AgentItem) => AgentItem) =>
    setItems((xs) => xs.map((x) => (x.id === id && x.kind === "agent" ? fn(x) : x)));
  const sideState = (k: AgentKey, s: AgentState) => setSide((prev) => ({ ...prev, [k]: s }));
  const agentMsg = (agent: AgentKey, h: number, m: number) =>
    add({ kind: "agent", agent, time: fmt.time(h, m), state: "idle" });

  /** Steps one by one (each with a spinner, then a check and its time); the list closes at the end. */
  async function work(r: Run, id: number, key: AgentKey, steps: [string, number][], summary: string) {
    patch(id, (a) => ({ ...a, state: "thinking", work: { steps: [], summary: null, open: true } }));
    sideState(key, "thinking");
    let acc: Step[] = [];
    const setSteps = (list: Step[]) =>
      patch(id, (a) => ({ ...a, work: { ...(a.work ?? { summary: null, open: true }), steps: list } }));
    for (const [label, seconds] of steps) {
      if (!r.alive()) return false;
      acc = [...acc, { label, pending: true }];
      setSteps(acc);
      await r.sleep(850 + Math.random() * 450);
      if (!r.alive()) return false;
      const last = acc.length - 1;
      acc = acc.map((s, i) => (i === last ? { ...s, pending: false, time: fmt.dur(seconds) } : s));
      setSteps(acc);
    }
    patch(id, (a) => ({ ...a, work: a.work && { ...a.work, summary } }));
    await r.sleep(300);
    if (!r.alive()) return false;
    patch(id, (a) => ({ ...a, work: a.work && { ...a.work, open: false } }));
    return true;
  }

  /** The answer, token by token, with the writing eyes. */
  async function stream(r: Run, id: number, key: AgentKey, text: string) {
    patch(id, (a) => ({ ...a, state: "writing", text, shown: 0 }));
    sideState(key, "writing");
    const n = tokenCount(text);
    for (let i = 1; i <= n; i++) {
      if (!r.alive()) return false;
      patch(id, (a) => ({ ...a, shown: i }));
      await r.sleep(36 + Math.random() * 36);
    }
    if (!r.alive()) return false;
    patch(id, (a) => ({ ...a, state: "idle", shown: undefined }));
    sideState(key, "idle");
    return true;
  }

  const meta = (model: string, tokens: number, cost: number) =>
    t("landing.meta", { model, tokens: fmt.num(tokens), cost: fmt.usd(cost, 3) });

  const scripts: Record<Scenario, (r: Run) => Promise<void>> = {
    async incidente(r) {
      const lia = AGENTS.lia.name;
      add({
        kind: "person",
        person: "marina",
        text: t("landing.demo.incident.ask", { agent: lia }),
        time: fmt.time(14, 21),
      });
      await r.sleep(900);
      if (!r.alive()) return;
      const a = agentMsg("lia", 14, 21);
      const steps: [string, number][] = [
        [t("landing.demo.incident.s1"), 4],
        [t("landing.demo.incident.s2"), 9],
        [t("landing.demo.incident.s3", { agent: lia }), 26],
      ];
      if (!(await work(r, a, "lia", steps, t("landing.demo.incident.summary")))) return;
      if (!(await stream(r, a, "lia", t("landing.demo.incident.reply")))) return;
      await r.sleep(400);
      if (!r.alive()) return;
      patch(a, (x) => ({ ...x, approval: "wait" }));
      setPending(1);
      const choice = await new Promise<"yes" | "no" | "cancel">((resolve) => {
        approveRef.current = resolve;
      });
      approveRef.current = null;
      if (!r.alive() || choice === "cancel") return;
      setPending(0);
      patch(a, (x) => ({ ...x, approval: choice }));
      await r.sleep(700);
      if (!r.alive()) return;
      const b = agentMsg("lia", 14, 25);
      if (choice === "yes") {
        const yes: [string, number][] = [
          [t("landing.demo.incident.yes1"), 108],
          [t("landing.demo.incident.yes2"), 6],
          [t("landing.demo.incident.yes3"), 2],
        ];
        if (!(await work(r, b, "lia", yes, t("landing.demo.incident.yesSummary")))) return;
        if (!(await stream(r, b, "lia", t("landing.demo.incident.yesReply", { reviewer: PEOPLE.rafael.short }))))
          return;
      } else {
        const no: [string, number][] = [
          [t("landing.demo.incident.no1", { agent: lia }), 48],
          [t("landing.demo.incident.no2"), 22],
          [t("landing.demo.incident.no3"), 3],
        ];
        if (!(await work(r, b, "lia", no, t("landing.demo.incident.noSummary")))) return;
        if (!(await stream(r, b, "lia", t("landing.demo.incident.noReply")))) return;
      }
      patch(b, (x) => ({
        ...x,
        meta: meta(MODELS.sonnet, 3412, 0.021),
        reacts: [
          { icon: "check", label: t("landing.demo.agree"), n: 2, on: false },
          { icon: "approve", label: t("landing.demo.thanks"), n: 1, on: false },
        ],
      }));
    },
    async relatorio(r) {
      const teo = AGENTS.teo.name;
      add({ kind: "sys", icon: "routines", text: t("landing.demo.routineScene.sys") });
      await r.sleep(700);
      if (!r.alive()) return;
      const a = agentMsg("teo", 9, 0);
      const steps: [string, number][] = [
        [t("landing.demo.routineScene.s1"), 7],
        [t("landing.demo.routineScene.s2"), 3],
        [t("landing.demo.routineScene.s3"), 8],
      ];
      if (!(await work(r, a, "teo", steps, t("landing.demo.routineScene.summary")))) return;
      if (!(await stream(r, a, "teo", t("landing.demo.routineScene.reply")))) return;
      patch(a, (x) => ({
        ...x,
        file: {
          kind: "chart",
          title: t("landing.demo.routineScene.fileTitle"),
          sub: t("landing.demo.routineScene.fileSub"),
        },
        meta: meta(MODELS.haiku, 2104, 0.003),
      }));
      await r.sleep(1400);
      if (!r.alive()) return;
      add({
        kind: "person",
        person: "camila",
        text: t("landing.demo.routineScene.ask", { agent: teo }),
        time: fmt.time(9, 14),
      });
      await r.sleep(800);
      if (!r.alive()) return;
      const b = agentMsg("teo", 9, 14);
      const steps2: [string, number][] = [
        [t("landing.demo.routineScene.t1"), 5],
        [t("landing.demo.routineScene.t2"), 4],
      ];
      if (!(await work(r, b, "teo", steps2, t("landing.demo.routineScene.summary2")))) return;
      if (!(await stream(r, b, "teo", t("landing.demo.routineScene.reply2")))) return;
      patch(b, (x) => ({ ...x, reacts: [{ icon: "check", label: t("landing.demo.agree"), n: 1, on: false }] }));
    },
    async roteador(r) {
      add({ kind: "person", person: "rafael", text: t("landing.demo.routerScene.ask"), time: fmt.time(11, 2) });
      await r.sleep(1000);
      if (!r.alive()) return;
      add({
        kind: "sys",
        icon: "agent",
        text: t("landing.demo.routerScene.sys", { a: AGENTS.bia.name, b: AGENTS.lia.name }),
      });
      await r.sleep(700);
      if (!r.alive()) return;
      const a = agentMsg("bia", 11, 2);
      const steps: [string, number][] = [
        [t("landing.demo.routerScene.s1"), 3],
        [t("landing.demo.routerScene.s2"), 2],
      ];
      if (!(await work(r, a, "bia", steps, t("landing.demo.routerScene.summary")))) return;
      if (!(await stream(r, a, "bia", t("landing.demo.routerScene.reply")))) return;
      await r.sleep(500);
      if (!r.alive()) return;
      const l = agentMsg("lia", 11, 3);
      patch(l, (x) => ({ ...x, state: "thinking" }));
      sideState("lia", "thinking");
      await r.sleep(1300);
      if (!r.alive()) return;
      if (!(await stream(r, l, "lia", t("landing.demo.routerScene.liaReply")))) return;
      await r.sleep(600);
      if (!r.alive()) return;
      const b = agentMsg("bia", 11, 4);
      const steps2: [string, number][] = [
        [t("landing.demo.routerScene.t1"), 4],
        [t("landing.demo.routerScene.t2"), 1],
      ];
      if (!(await work(r, b, "bia", steps2, t("landing.demo.routerScene.summary2")))) return;
      if (!(await stream(r, b, "bia", t("landing.demo.routerScene.reply2")))) return;
      patch(b, (x) => ({
        ...x,
        file: {
          kind: "doc",
          title: t("landing.demo.routerScene.fileTitle"),
          sub: t("landing.demo.routerScene.fileSub"),
        },
        meta: meta(MODELS.sonnet, 4880, 0.029),
      }));
    },
  };

  const play = (key: Scenario) => {
    started.current = true;
    approveRef.current?.("cancel");
    approveRef.current = null;
    setPending(0);
    setItems([]);
    setSide(idle);
    setScenario(key);
    runner.start((r) => scripts[key](r));
  };

  useIntersection(
    win,
    (visible, observer) => {
      if (visible && !started.current) {
        observer.disconnect();
        play("incidente");
      }
    },
    { threshold: 0.35 },
  );

  const current = SC[scenario].agent;
  const send = async () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    started.current = true;
    const r = runner.join();
    const now = fmt.timeOf(new Date());
    const agent = current;
    add({ kind: "person", person: "you", mention: AGENTS[agent].name, text: value, time: now });
    await r.sleep(700);
    if (!r.alive()) return;
    const id = add({ kind: "agent", agent, time: now, state: "thinking" });
    sideState(agent, "thinking");
    await r.sleep(1200);
    if (!r.alive()) return;
    const line = replies.current++ % 2 === 0 ? t("landing.demo.fallback1") : t("landing.demo.fallback2");
    if (!(await stream(r, id, agent, line))) return;
    patch(id, (x) => ({ ...x, cta: true }));
  };

  const toggleReact = (id: number, index: number) =>
    patch(id, (a) => ({ ...a, reacts: a.reacts?.map((x, i) => (i === index ? { ...x, on: !x.on } : x)) }));

  const writeTo = AGENTS[current].feminine ? "landing.demo.writeToF" : "landing.demo.writeToM";

  return (
    <section className="lp-sec lp-sec--flush" id="demo">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.demo.eyebrow")}</span>
          <h2>{t("landing.demo.title")}</h2>
          <p className="lp-lead">{t("landing.demo.lead")}</p>
        </div>
        <div className="lp-demo-bar">
          <Segmented
            label={t("landing.demo.scenario")}
            value={scenario}
            onValueChange={(v) => play(v)}
            options={SCENARIOS.map((k) => ({
              value: k,
              label: (
                <>
                  <Icon name={SC[k].icon} size={16} />
                  {k === "incidente"
                    ? t("landing.demo.incidentTab")
                    : k === "relatorio"
                      ? t("landing.demo.routine")
                      : t("landing.demo.two")}
                </>
              ),
            }))}
          />
          <Button variant="ghost" size="sm" icon="repeat" onClick={() => play(scenario)}>
            {t("landing.demo.replay")}
          </Button>
        </div>
        <div className="lp-win" ref={win}>
          <aside className="lp-side" aria-label={t("landing.demo.sidebar")}>
            <div className="lp-org">
              <i>{ORG.initial}</i>
              {ORG.name}
            </div>
            <div className="lp-grp">{t("landing.demo.channels")}</div>
            {SCENARIOS.map((k) => (
              <button key={k} type="button" aria-current={scenario === k ? "true" : undefined} onClick={() => play(k)}>
                <Icon name="channel" size={16} />
                {t(`landing.demo.channel.${SC[k].channel}`)}
              </button>
            ))}
            <div className="lp-grp">{t("landing.demo.agents")}</div>
            {AGENT_KEYS.map((k) => (
              <div className="lp-agent-row" key={k}>
                <SampleAgent agent={k} size="sm" state={side[k]} />
                {AGENTS[k].name}
                <small>{t(`landing.demo.role.${ROLE[k]}`)}</small>
              </div>
            ))}
            <div className="lp-appr">
              <Icon name="approve" size={16} />
              {t("landing.demo.approvals")}
              <CountBadge data-n={pending}>{pending}</CountBadge>
            </div>
          </aside>
          <div className="lp-main">
            <div className="lp-ch-head">
              <Icon name="channel" />
              <h3>{t(`landing.demo.channel.${SC[scenario].channel}`)}</h3>
              <AvatarStack className="lp-members">
                {SC[scenario].members.map((m) =>
                  isAgent(m) ? (
                    <SampleAgent key={m} agent={m} size="sm" />
                  ) : (
                    <Avatar key={m} name={PEOPLE[m].name} initials={PEOPLE[m].initials} size="sm" />
                  ),
                )}
              </AvatarStack>
            </div>
            <div className="lp-feed" ref={feed} aria-live="polite">
              {items.map((it) => (
                <FeedItem
                  key={it.id}
                  item={it}
                  onDecide={(choice) => approveRef.current?.(choice)}
                  onReact={(i) => toggleReact(it.id, i)}
                  onJoin={() => scrollTo("lista")}
                />
              ))}
            </div>
            <div className="lp-composer-wrap">
              <form
                className="lp-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <div className="lp-pills">
                  <span className="lp-cpill">
                    <SampleAgent agent={current} size="xs" />
                    {AGENTS[current].name}
                  </span>
                </div>
                <div className="lp-row">
                  <label htmlFor={inputId} className="lp-sr">
                    {t("landing.demo.message")}
                  </label>
                  <input
                    id={inputId}
                    autoComplete="off"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={t(writeTo, { name: AGENTS[current].name })}
                  />
                  <button
                    type="submit"
                    className={cx("lp-send", draft.trim() && "lp-send--on")}
                    aria-label={t("landing.demo.send")}
                  >
                    <Icon name="send" size={16} />
                    <span className="lp-lbl">{t("landing.demo.send")}</span>
                    <Kbd className="lp-lbl">↵</Kbd>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FeedItem({
  item,
  onDecide,
  onReact,
  onJoin,
}: {
  item: Item;
  onDecide: (choice: "yes" | "no") => void;
  onReact: (index: number) => void;
  onJoin: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  if (item.kind === "sys")
    return (
      <div className="lp-sys lp-enter">
        <Icon name={item.icon} size={16} />
        <span>
          <RichText text={item.text} />
        </span>
      </div>
    );
  if (item.kind === "person") {
    const you = item.person === "you";
    const name = you ? t("landing.demo.you") : PEOPLE[item.person as PersonKey].name;
    const initials = you ? t("landing.demo.youInitials") : PEOPLE[item.person as PersonKey].initials;
    return (
      <Message entering avatar={<Avatar name={name} initials={initials} />} author={name} time={item.time}>
        <MessageText>
          {item.mention !== undefined ? (
            <>
              <Mention>@{item.mention}</Mention> {item.text}
            </>
          ) : (
            <RichText text={item.text} />
          )}
        </MessageText>
      </Message>
    );
  }
  const owner = PEOPLE.marina;
  const agent = AGENTS[item.agent].name;
  const decided = { name: owner.short, time: fmt.time(14, 23) };
  return (
    <Message
      entering
      agent
      avatar={<SampleAgent agent={item.agent} state={item.state} />}
      author={agent}
      time={item.time}
    >
      {item.work && (
        <WorkSummary
          key={String(item.work.open)}
          defaultOpen={item.work.open}
          summary={item.work.summary ?? t("landing.demo.working")}
          steps={item.work.steps.map((s, i) => ({
            key: String(i),
            label: <RichText text={s.label} />,
            pending: s.pending,
            time: s.time,
          }))}
        />
      )}
      {item.text !== undefined && item.shown !== 0 && (
        <MessageText>
          <RichText text={item.text} upto={item.shown} />
          {item.shown !== undefined && <Caret />}
        </MessageText>
      )}
      {item.approval === "wait" && (
        <ApprovalCard
          className="lp-demo-approval"
          status="waiting"
          who={null}
          statusLabel={t("landing.approval.waiting")}
          title={t("landing.approval.title", { agent })}
          detail={t("landing.approval.detail", { owner: owner.name, agent })}
          actions={
            <>
              <Button variant="primary" size="sm" icon="check" onClick={() => onDecide("yes")}>
                {t("landing.approval.approve")}
              </Button>
              <Button size="sm" onClick={() => onDecide("no")}>
                {t("landing.approval.refuse")}
              </Button>
              <span className="lp-hint">
                <Icon name="approve" size={14} />
                {t("landing.approval.hint", { name: owner.short })}
              </span>
            </>
          }
        />
      )}
      {(item.approval === "yes" || item.approval === "no") && (
        <ApprovalCard
          className="lp-demo-approval"
          compact
          status={item.approval === "yes" ? "approved" : "refused"}
          who={null}
          statusLabel={
            item.approval === "yes" ? t("landing.approval.approved", decided) : t("landing.approval.refused", decided)
          }
          title={t("landing.approval.decided")}
        />
      )}
      {item.file && (
        <div className="lp-file">
          {item.file.kind === "chart" ? (
            <span className="lp-thumb">
              {[45, 62, 51, 78, 92].map((h) => (
                <i key={h} style={{ height: `${h}%` }} />
              ))}
            </span>
          ) : (
            <span className="lp-thumb lp-thumb--doc">
              <i style={{ width: "70%" }} />
              <i />
              <i style={{ width: "85%" }} />
              <i style={{ width: "55%" }} />
            </span>
          )}
          <div>
            <b>{item.file.title}</b>
            <span>{item.file.sub}</span>
          </div>
        </div>
      )}
      {item.meta && <div className="lp-meta">{item.meta}</div>}
      {item.reacts && (
        <Reactions label={t("landing.demo.reactions")}>
          {item.reacts.map((r, i) => (
            <Reaction
              key={r.label}
              pressed={r.on}
              count={r.n + (r.on ? 1 : 0)}
              label={t("landing.demo.react", { label: r.label, n: r.n + (r.on ? 1 : 0) })}
              onClick={() => onReact(i)}
            >
              <Icon name={r.icon} size={14} />
            </Reaction>
          ))}
        </Reactions>
      )}
      {item.cta && (
        <div className="lp-cta">
          <Button size="sm" icon="agent" onClick={onJoin}>
            {t("landing.demo.join")}
          </Button>
        </div>
      )}
    </Message>
  );
}
