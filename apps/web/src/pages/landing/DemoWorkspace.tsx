import {
  type AgentColor,
  type AgentState,
  Avatar,
  AvatarStack,
  Button,
  ditherTones,
  Icon,
  type IconName,
  Message,
  MessageText,
  PixelSpinner,
  Reaction,
  Reactions,
  Segmented,
  WorkSummary,
} from "@agenteschat/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST, type CastKey, type ChannelKey, PEOPLE, type PersonKey, STARTUP_AGENTS, STARTUP_CHANNELS } from "./cast";
import { useLanding } from "./context";
import { useFormat } from "./format";
import { type Run, useIntersection, useRunner } from "./hooks";
import { type Decision, LpApproval } from "./kit/Approval";
import { Consult } from "./kit/Consult";
import { MockSidebar } from "./kit/MockSidebar";
import { LpAvatar } from "./LpAvatar";
import { RichText, tokenCount } from "./rich";
import "./kit/kit.css";
import "./DemoWorkspace.css";

/**
 * "Agora é com você": the Pixelpress workspace running like the product
 * (docs/design/telas/LandingNova.html, #demo). Three scenarios, one per
 * channel; the visitor can stop Dev, write while it works, decide Atlas's
 * approval and write in the composer.
 */

type Scenario = "incident" | "routine" | "two";
const SCENARIOS: Scenario[] = ["incident", "routine", "two"];
const SC: Record<Scenario, { channel: ChannelKey; agent: CastKey; members: CastKey[]; icon: IconName }> = {
  incident: { channel: "engineering", agent: "dev", members: ["dev", "atlas"], icon: "alert" },
  routine: { channel: "metrics", agent: "nina", members: ["nina"], icon: "routines" },
  two: { channel: "launch", agent: "theo", members: ["theo", "ada"], icon: "message" },
};
const byChannel = (c: ChannelKey) => SCENARIOS.find((k) => SC[k].channel === c) ?? "incident";

interface Step {
  key: string;
  label: string;
  pending: boolean;
}
interface Work {
  steps: Step[];
  /** Null while it works. */
  summary: string | null;
  /** Shows "Parar" while it works. */
  stoppable: boolean;
  stopped?: boolean;
}
interface AgentItem {
  id: number;
  kind: "agent";
  agent: CastKey;
  time: string;
  state: AgentState;
  work?: Work;
  consult?: { to: CastKey; question: string; answer?: string };
  text?: string;
  /** Tokens shown while it types. */
  shown?: number;
  approval?: "wait" | Decision;
  file?: { chart?: AgentColor; title: string; sub: string };
  reacts?: { emoji: string; n: number; on: boolean }[];
  /** The fallback answer's "Entrar na lista". */
  cta?: boolean;
}
interface PersonItem {
  id: number;
  kind: "person";
  person: PersonKey | "you";
  text: string;
  time: string;
  /** "Dev leu agora": read by the agent mid-run. */
  seen?: CastKey;
}
interface SysItem {
  id: number;
  kind: "sys";
  icon?: IconName;
  agents?: CastKey[];
  text: string;
}
type Item = AgentItem | PersonItem | SysItem;
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type NewItem = WithoutId<Item>;

const IDLE: Record<CastKey, AgentState> = {
  dev: "idle",
  atlas: "idle",
  nina: "idle",
  theo: "idle",
  ada: "idle",
  sol: "idle",
  cora: "idle",
};
/** Thrown when a newer run (another scenario, Repetir) replaced this one. */
const CANCEL = Symbol("cancel");
/** Thrown when the visitor pressed "Parar". */
const STOP = Symbol("stop");

export function DemoWorkspace() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { scrollTo } = useLanding();
  const runner = useRunner();
  const inputId = useId();
  const win = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const started = useRef(false);
  const replies = useRef(0);
  const decideRef = useRef<((choice: Decision | "cancel") => void) | null>(null);
  /** Set while Dev works: messages sent now are read mid-run. */
  const midRef = useRef<((personId: number, text: string) => void) | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const joyTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [scenario, setScenario] = useState<Scenario>("incident");
  const [items, setItems] = useState<Item[]>([]);
  const [side, setSide] = useState(IDLE);
  const [typing, setTyping] = useState<CastKey | null>(null);
  const [joy, setJoy] = useState<Partial<Record<CastKey, boolean>>>({});
  const [pending, setPending] = useState(0);
  const [draft, setDraft] = useState("");

  // Only the feed scrolls, never the page.
  useEffect(() => {
    const el = feed.current;
    if (el && items.length) el.scrollTop = el.scrollHeight;
  }, [items]);

  useEffect(() => {
    const timers = joyTimers.current;
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, []);

  const add = (item: NewItem) => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { ...item, id } as Item]);
    return id;
  };
  const patch = (id: number, fn: (a: AgentItem) => AgentItem) =>
    setItems((xs) => xs.map((x) => (x.id === id && x.kind === "agent" ? fn(x) : x)));
  const sideState = (key: CastKey, s: AgentState) => setSide((prev) => ({ ...prev, [key]: s }));
  /** Busy in the sidebar ("trabalhando") and in the line under the feed. */
  const working = (key: CastKey, on: boolean) => {
    sideState(key, on ? "thinking" : "idle");
    setTyping((cur) => (on ? key : cur === key ? null : cur));
  };
  const happy = (key: CastKey, ms = 1400) => {
    setJoy((j) => ({ ...j, [key]: true }));
    const id = setTimeout(() => {
      joyTimers.current.delete(id);
      setJoy((j) => ({ ...j, [key]: false }));
    }, ms);
    joyTimers.current.add(id);
  };
  const agentMsg = (agent: CastKey, time: string) => add({ kind: "agent", agent, time, state: "idle" });
  const at = (h: number, m: number) => fmt.time(h, m);

  const waiter = (r: Run) => async (ms: number) => {
    await r.sleep(ms);
    if (!r.alive()) throw CANCEL;
  };

  const startWork = (id: number, stoppable = false) =>
    patch(id, (a) => ({ ...a, state: "thinking", work: { steps: [], summary: null, stoppable } }));
  const endWork = (id: number, summary: string) =>
    patch(id, (a) => ({ ...a, state: "idle", work: a.work && { ...a.work, summary } }));
  const setSteps = (id: number, fn: (steps: Step[]) => Step[]) =>
    patch(id, (a) => (a.work ? { ...a, work: { ...a.work, steps: fn(a.work.steps) } } : a));

  /** One step: a spinner while it runs, then the check. */
  async function step(id: number, label: string, ms: number, go: (ms: number) => Promise<void>) {
    const key = `s${++seq.current}`;
    setSteps(id, (s) => [...s, { key, label, pending: true }]);
    await go(ms);
    setSteps(id, (s) => s.map((x) => (x.key === key ? { ...x, pending: false } : x)));
  }

  /** The answer, token by token, with the writing eyes. */
  async function stream(r: Run, id: number, text: string) {
    const wait = waiter(r);
    patch(id, (a) => ({ ...a, state: "writing", text, shown: 0 }));
    const n = tokenCount(text);
    for (let i = 1; i <= n; i++) {
      patch(id, (a) => ({ ...a, shown: i }));
      await wait(28 + Math.random() * 30);
    }
    patch(id, (a) => ({ ...a, state: "idle", shown: undefined }));
  }

  const scripts: Record<Scenario, (r: Run) => Promise<void>> = {
    async incident(r) {
      const wait = waiter(r);
      add({ kind: "person", person: "marina", text: t("landing.demo.incident.ask"), time: at(14, 21) });
      await wait(1000);
      add({ kind: "sys", agents: ["dev"], text: t("landing.demo.joined", { name: CAST.dev.name }) });
      working("dev", true);
      await wait(500);
      const m1 = agentMsg("dev", at(14, 21));
      startWork(m1, true);

      // "Parar" ends the current wait right away; messages sent now are read mid-run.
      let stopped = false;
      let halt = () => {};
      const halted = new Promise<void>((resolve) => {
        halt = resolve;
      });
      stopRef.current = () => {
        stopped = true;
        halt();
      };
      midRef.current = (personId, text) => {
        setItems((xs) => xs.map((x) => (x.id === personId && x.kind === "person" ? { ...x, seen: "dev" } : x)));
        const short = text.length > 40 ? `${text.slice(0, 40)}…` : text;
        void r.sleep(700).then(() => {
          if (!r.alive()) return;
          const key = `s${++seq.current}`;
          const considered = { key, label: t("landing.demo.considered", { text: short }), pending: false };
          // Before the step still running, so the list reads in order.
          setSteps(m1, (s) => {
            const idx = s.findIndex((x) => x.pending);
            return idx < 0 ? [...s, considered] : [...s.slice(0, idx), considered, ...s.slice(idx)];
          });
        });
      };
      const go = async (ms: number) => {
        await Promise.race([r.sleep(ms), halted]);
        if (!r.alive()) throw CANCEL;
        if (stopped) throw STOP;
      };
      try {
        await step(m1, t("landing.demo.incident.s1"), 900, go);
        await step(m1, t("landing.demo.incident.s2"), 1000, go);
        await go(700);
        patch(m1, (a) => ({ ...a, consult: { to: "atlas", question: t("landing.demo.incident.consultQ") } }));
        sideState("atlas", "thinking");
        await go(1500);
        patch(m1, (a) => ({
          ...a,
          consult: a.consult && { ...a.consult, answer: t("landing.demo.incident.consultA") },
        }));
        sideState("atlas", "idle");
        await step(m1, t("landing.demo.incident.s3"), 1400, go);
        await go(900);
      } catch (e) {
        if (e !== STOP) throw e;
        midRef.current = null;
        stopRef.current = null;
        sideState("atlas", "idle");
        patch(m1, (a) => ({
          ...a,
          state: "idle",
          consult: a.consult?.answer ? a.consult : undefined,
          work: a.work && { ...a.work, stopped: true, steps: a.work.steps.filter((s) => !s.pending) },
        }));
        working("dev", false);
        const m = agentMsg("dev", at(14, 22));
        await stream(r, m, t("landing.demo.incident.stoppedReply"));
        return;
      }
      midRef.current = null;
      stopRef.current = null;
      endWork(m1, t("landing.demo.incident.summary"));
      working("dev", false);
      happy("dev");
      const m1b = agentMsg("dev", at(14, 22));
      await stream(r, m1b, t("landing.demo.incident.reply"));
      await wait(1300);

      const m2 = agentMsg("atlas", at(14, 23));
      patch(m2, (a) => ({ ...a, approval: "wait" }));
      setPending(1);
      const choice = await new Promise<Decision | "cancel">((resolve) => {
        decideRef.current = resolve;
      });
      decideRef.current = null;
      if (choice === "cancel" || !r.alive()) throw CANCEL;
      setPending(0);
      patch(m2, (a) => ({ ...a, approval: choice }));
      if (choice === "no") {
        await wait(700);
        const m = agentMsg("dev", at(14, 24));
        await stream(r, m, t("landing.demo.incident.noReply"));
        return;
      }
      working("atlas", true);
      await wait(500);
      const m3 = agentMsg("atlas", at(14, 24));
      startWork(m3);
      await step(m3, t("landing.demo.incident.yes1"), 800, wait);
      await step(m3, t("landing.demo.incident.yes2"), 900, wait);
      await step(m3, t("landing.demo.incident.yes3"), 700, wait);
      endWork(m3, t("landing.demo.incident.yesSummary"));
      await stream(r, m3, t("landing.demo.incident.yesReply"));
      working("atlas", false);
      happy("atlas", 2400);
      patch(m3, (a) => ({
        ...a,
        reacts: [
          { emoji: "🎉", n: 3, on: false },
          { emoji: "🙏", n: 2, on: false },
        ],
      }));
    },

    async routine(r) {
      const wait = waiter(r);
      add({ kind: "sys", icon: "routines", text: t("landing.demo.routine.sys") });
      working("nina", true);
      await wait(500);
      const m1 = agentMsg("nina", at(9, 0));
      startWork(m1);
      await step(m1, t("landing.demo.routine.s1"), 800, wait);
      await step(m1, t("landing.demo.routine.s2"), 800, wait);
      await step(m1, t("landing.demo.routine.s3"), 800, wait);
      endWork(m1, t("landing.demo.routine.summary"));
      await stream(r, m1, t("landing.demo.routine.reply"));
      working("nina", false);
      patch(m1, (a) => ({
        ...a,
        file: {
          chart: CAST.nina.color,
          title: t("landing.demo.routine.fileTitle"),
          sub: t("landing.demo.routine.fileSub"),
        },
        reacts: [{ emoji: "👍", n: 4, on: false }],
      }));
      await wait(1800);
      add({ kind: "person", person: "marina", text: t("landing.demo.routine.ask"), time: at(9, 14) });
      await wait(700);
      working("nina", true);
      const m2 = agentMsg("nina", at(9, 14));
      startWork(m2);
      await step(m2, t("landing.demo.routine.s1"), 800, wait);
      await step(m2, t("landing.demo.routine.t2"), 800, wait);
      endWork(m2, t("landing.demo.routine.summary2"));
      await stream(r, m2, t("landing.demo.routine.reply2"));
      working("nina", false);
      happy("nina");
    },

    async two(r) {
      const wait = waiter(r);
      add({ kind: "person", person: "marina", text: t("landing.demo.two.ask"), time: at(10, 2) });
      await wait(1000);
      add({
        kind: "sys",
        agents: ["theo", "ada"],
        text: t("landing.demo.joinedTwo", { a: CAST.theo.name, b: CAST.ada.name }),
      });
      working("theo", true);
      await wait(500);
      const m1 = agentMsg("theo", at(10, 2));
      startWork(m1);
      await step(m1, t("landing.demo.two.s1"), 800, wait);
      await step(m1, t("landing.demo.two.s2"), 800, wait);
      endWork(m1, t("landing.demo.two.summary"));
      await stream(r, m1, t("landing.demo.two.reply"));
      working("theo", false);
      await wait(1300);

      // Ada checks a fact with Dev in private before chiming in.
      sideState("ada", "thinking");
      const m2 = agentMsg("ada", at(10, 3));
      patch(m2, (a) => ({ ...a, state: "thinking", consult: { to: "dev", question: t("landing.demo.two.consultQ") } }));
      await wait(1500);
      patch(m2, (a) => ({ ...a, consult: a.consult && { ...a.consult, answer: t("landing.demo.two.consultA") } }));
      await stream(r, m2, t("landing.demo.two.adaReply"));
      sideState("ada", "idle");
      await wait(1300);

      working("theo", true);
      const m3 = agentMsg("theo", at(10, 5));
      startWork(m3);
      await step(m3, t("landing.demo.two.t1"), 800, wait);
      await step(m3, t("landing.demo.two.t2"), 800, wait);
      endWork(m3, t("landing.demo.two.summary2"));
      await stream(r, m3, t("landing.demo.two.reply2"));
      working("theo", false);
      happy("theo");
      patch(m3, (a) => ({
        ...a,
        file: { title: t("landing.demo.two.fileTitle"), sub: t("landing.demo.two.fileSub") },
        reacts: [
          { emoji: "🔥", n: 2, on: false },
          { emoji: "👍", n: 3, on: false },
        ],
      }));
    },
  };

  const play = (key: Scenario) => {
    started.current = true;
    decideRef.current?.("cancel");
    decideRef.current = null;
    midRef.current = null;
    stopRef.current = null;
    setPending(0);
    setItems([]);
    setSide(IDLE);
    setTyping(null);
    setScenario(key);
    runner.start(async (r) => {
      try {
        await waiter(r)(400);
        await scripts[key](r);
      } catch (e) {
        if (e !== CANCEL) throw e;
      }
    });
  };

  useIntersection(
    win,
    (visible, observer) => {
      if (visible && !started.current) {
        observer.disconnect();
        play("incident");
      }
    },
    { threshold: 0.35 },
  );

  const send = async () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    const now = t("landing.when.now");
    const personId = add({ kind: "person", person: "you", text: value, time: now });
    if (midRef.current) {
      midRef.current(personId, value);
      return;
    }
    started.current = true;
    const r = runner.join();
    const wait = waiter(r);
    const agent = SC[scenario].agent;
    try {
      await wait(500);
      working(agent, true);
      await wait(1400);
      const id = agentMsg(agent, now);
      const line = replies.current++ % 2 === 0 ? t("landing.demo.fallback1") : t("landing.demo.fallback2");
      await stream(r, id, line);
      working(agent, false);
      patch(id, (a) => ({ ...a, cta: true }));
    } catch (e) {
      if (e !== CANCEL) throw e;
    }
  };

  const toggleReact = (id: number, index: number) =>
    patch(id, (a) => ({ ...a, reacts: a.reacts?.map((x, i) => (i === index ? { ...x, on: !x.on } : x)) }));

  const channel = t(`landing.channel.${SC[scenario].channel}`);

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
                <span className="lp-demo-tab">
                  <Icon name={SC[k].icon} size={16} className="lp-demo-tab__ic" />
                  {t(`landing.demo.tab.${k}`)}
                </span>
              ),
            }))}
          />
          <Button variant="ghost" size="sm" icon="repeat" onClick={() => play(scenario)}>
            {t("landing.demo.replay")}
          </Button>
        </div>
        <div className="lp-demo-win" ref={win}>
          <MockSidebar
            org="startup"
            channels={STARTUP_CHANNELS.map((key) => ({ key }))}
            active={SC[scenario].channel}
            onChannel={(c) => play(byChannel(c))}
            agents={STARTUP_AGENTS}
            states={side}
            tools={["notifications", "approvals", "issues"]}
            approvals={pending}
            label={t("landing.demo.sidebar")}
            className="lp-demo-side"
          />
          <div className="lp-demo-chan">
            <div className="lp-demo-head">
              <Icon name="channel" />
              <h3>{channel}</h3>
              <AvatarStack className="lp-demo-members">
                <Avatar name={PEOPLE.marina.name} initials={PEOPLE.marina.initials} size="sm" />
                {SC[scenario].members.map((k) => (
                  <LpAvatar key={k} look={CAST[k].look} size="sm" name={CAST[k].name} />
                ))}
              </AvatarStack>
            </div>
            <div className="lp-demo-feed" ref={feed} aria-live="polite">
              {items.map((it) => (
                <FeedItem
                  key={it.id}
                  item={it}
                  joy={it.kind === "agent" && !!joy[it.agent]}
                  onDecide={(choice) => decideRef.current?.(choice)}
                  onStop={() => stopRef.current?.()}
                  onReact={(i) => toggleReact(it.id, i)}
                  onJoin={() => scrollTo("lista")}
                />
              ))}
            </div>
            <div className="lp-demo-typing" aria-hidden="true">
              {typing && (
                <>
                  <PixelSpinner size={14} color={CAST[typing].color} />
                  {t("landing.demo.isWorking", { name: CAST[typing].name })}
                </>
              )}
            </div>
            <form
              className="lp-demo-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label htmlFor={inputId} className="lp-sr">
                {t("landing.demo.message")}
              </label>
              <input
                id={inputId}
                autoComplete="off"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("landing.demo.placeholder", { channel })}
              />
              <Button
                type="submit"
                variant={draft.trim() ? "primary" : "default"}
                size="sm"
                icon="send"
                iconOnly
                aria-label={t("landing.demo.send")}
              />
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}

function FeedItem({
  item,
  joy,
  onDecide,
  onStop,
  onReact,
  onJoin,
}: {
  item: Item;
  joy: boolean;
  onDecide: (choice: Decision) => void;
  onStop: () => void;
  onReact: (index: number) => void;
  onJoin: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  if (item.kind === "sys")
    return (
      <div className="lp-demo-sys lp-enter">
        {item.icon && <Icon name={item.icon} size={16} />}
        {item.agents?.map((k) => (
          <LpAvatar key={k} look={CAST[k].look} size="xs" name={CAST[k].name} />
        ))}
        <span>
          <RichText text={item.text} />
        </span>
      </div>
    );

  if (item.kind === "person") {
    const you = item.person === "you";
    const person = item.person === "you" ? null : PEOPLE[item.person];
    const name = person ? person.short : t("landing.you");
    const initials = person ? person.initials : t("landing.youInitials");
    return (
      <Message entering avatar={<Avatar name={name} initials={initials} />} author={name} time={item.time}>
        <MessageText>{you ? item.text : <RichText text={item.text} />}</MessageText>
        {item.seen && (
          <div className="lp-demo-seen lp-enter">
            <LpAvatar look={CAST[item.seen].look} size="xs" name={CAST[item.seen].name} />
            {t("landing.read", { name: CAST[item.seen].name })}
          </div>
        )}
      </Message>
    );
  }

  const agent = CAST[item.agent];
  const work = item.work;
  const running = !!work && work.summary === null && !work.stopped;
  return (
    <Message
      entering
      agent
      avatar={
        <LpAvatar look={agent.look} state={item.state} name={agent.name} className={joy ? "lp-joy" : undefined} />
      }
      author={agent.name}
      time={item.time}
    >
      {work && (
        <div className="lp-demo-work">
          <WorkSummary
            defaultOpen
            summary={
              work.stopped ? (
                <span className="lp-demo-run">
                  <Icon name="stop" size={14} />
                  {t("landing.stopped")}
                </span>
              ) : work.summary !== null ? (
                <RichText text={work.summary} />
              ) : (
                <span className="lp-demo-run">
                  <PixelSpinner size={14} color={agent.color} />
                  {t("landing.working")}
                </span>
              )
            }
            steps={work.steps.map((s) => ({ key: s.key, label: s.label, pending: s.pending }))}
          />
          {running && work.stoppable && (
            <Button variant="ghost" size="sm" icon="stop" className="lp-demo-stop" onClick={onStop}>
              {t("landing.stop")}
            </Button>
          )}
        </div>
      )}
      {item.consult && (
        <Consult from={item.agent} to={item.consult.to} question={item.consult.question} answer={item.consult.answer} />
      )}
      {item.text !== undefined && item.shown !== 0 && (
        <MessageText>
          <RichText text={item.text} upto={item.shown} />
          {item.shown !== undefined && <span className="lp-demo-caret" aria-hidden="true" />}
        </MessageText>
      )}
      {item.approval && (
        <LpApproval
          className="lp-demo-approval"
          who={<b>{agent.name}</b>}
          title={t("landing.demo.incident.approval")}
          detail={t("landing.demo.incident.approvalDetail")}
          rows={[
            [t("landing.approval.action"), t("landing.demo.incident.action")],
            [t("landing.approval.service"), "compressor-api"],
            [t("landing.approval.who"), t("landing.approval.youDecide")],
          ]}
          color={agent.color}
          fuse={23 / 24}
          waitingLabel={t("landing.approval.expires", { h: 24 })}
          decided={item.approval === "wait" ? undefined : item.approval}
          decidedLabel={
            item.approval === "yes"
              ? t("landing.approval.decidedYou", { time: fmt.time(14, 24) })
              : t("landing.demo.incident.refused", { agent: agent.name })
          }
          onDecide={onDecide}
        />
      )}
      {item.file && (
        <div className="lp-demo-file lp-enter">
          {item.file.chart ? (
            <PixelBars color={item.file.chart} />
          ) : (
            <span className="lp-demo-file__th">
              <Icon name="file" size={18} />
            </span>
          )}
          <div>
            <b>{item.file.title}</b>
            <small>{item.file.sub}</small>
          </div>
        </div>
      )}
      {item.reacts && (
        <Reactions label={t("landing.demo.reactions")}>
          {item.reacts.map((r, i) => {
            const n = r.n + (r.on ? 1 : 0);
            return (
              <Reaction
                key={r.emoji}
                pressed={r.on}
                count={n}
                label={t("landing.demo.react", { emoji: r.emoji, n })}
                onClick={() => onReact(i)}
              >
                <span aria-hidden="true">{r.emoji}</span>
              </Reaction>
            );
          })}
        </Reactions>
      )}
      {item.cta && (
        <div className="lp-demo-cta">
          <Button size="sm" onClick={onJoin}>
            {t("landing.nav.join")}
          </Button>
        </div>
      )}
    </Message>
  );
}

/** 4×4 Bayer thresholds, like the pixel sky. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const BARS = [0.42, 0.5, 0.46, 0.58, 0.55, 0.63, 0.6, 0.7, 0.66, 0.74, 0.79, 0.9];

/** The report's chart in pixels, dithered in the agent's color (deep at the base, light on top). */
function PixelBars({ color }: { color: AgentColor }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const g = cv?.getContext?.("2d");
    if (!cv || !g) return;
    const W = 96;
    const H = 44;
    cv.width = W;
    cv.height = H;
    g.clearRect(0, 0, W, H);
    const tones = ditherTones(color);
    const last = tones.length - 1;
    BARS.forEach((v, i) => {
      const h = Math.round(v * (H - 2));
      const x0 = 1 + i * 8;
      for (let y = H - h; y < H; y++)
        for (let x = x0; x < x0 + 6; x++) {
          const f = ((y - (H - h)) / h) * (last + 0.99);
          const lo = Math.floor(f);
          const tone = lo + (f - lo > (BAYER[(x & 3) + (y & 3) * 4] ?? 0.5) ? 1 : 0);
          if (i !== BARS.length - 1 && ((x + y) & 1) !== 0 && f <= 1) continue;
          g.fillStyle = tones[Math.max(0, last - Math.min(last, tone))] ?? "#888";
          g.fillRect(x, y, 1, 1);
        }
    });
  }, [color]);
  return <canvas ref={ref} className="lp-demo-file__chart" />;
}
