import { Button, Card, cx, Icon, type IconName, Message, MessageText } from "@agenteschat/ui";
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RailStep, StepRail } from "@/components/StepRail";
import { CAST, ORGS, PEOPLE, type PersonKey } from "./cast";
import { useJoy, useVisible } from "./hooks";
import { LpAvatar } from "./LpAvatar";
import "./onboarding.css";

/** How long each step stays before the next one (prototype: 3.4 s). */
const STEP_MS = 3400;
const ORG = ORGS.shop;
const REPO = `${ORG.slug}/loja`;
const HOST = CAST.ada;

type StepId = "company" | "about" | "code" | "agents" | "tools" | "team" | "ready";

type OptKey =
  | `landing.onboarding.steps.about.opts.${"shop" | "wiki"}`
  | `landing.onboarding.steps.code.opts.${"repo" | "none"}`
  | "landing.onboarding.steps.agents.opts.import"
  | `landing.onboarding.steps.tools.opts.${"three" | "later"}`;

/** A suggested answer: an agent's face, an icon, or a check when it has neither. */
interface Option {
  id: string;
  /** Its words, when it's not an agent, a person or the company's name. */
  text?: OptKey;
  agent?: "dev" | "theo" | "nina";
  person?: PersonKey;
  icon?: IconName;
  /** Not chosen by default on a step with several choices ("Trazer agentes de outros apps"). */
  extra?: boolean;
}

interface Step {
  id: StepId;
  options: Option[];
  /** Several answers chosen at once (agents, invites); otherwise only the first one. */
  multi?: boolean;
  /** Shows "Pular esta etapa". */
  skip?: boolean;
}

/** The onboarding, step by step (LandingNova.html "08 · Começar"). */
const STEPS: Step[] = [
  { id: "company", options: [{ id: "name" }] },
  {
    id: "about",
    skip: true,
    options: [
      { id: "shop", text: "landing.onboarding.steps.about.opts.shop" },
      { id: "wiki", text: "landing.onboarding.steps.about.opts.wiki", icon: "download" },
    ],
  },
  {
    id: "code",
    skip: true,
    options: [
      { id: "repo", text: "landing.onboarding.steps.code.opts.repo", icon: "code" },
      { id: "none", text: "landing.onboarding.steps.code.opts.none" },
    ],
  },
  {
    id: "agents",
    multi: true,
    options: [
      { id: "dev", agent: "dev" },
      { id: "theo", agent: "theo" },
      { id: "nina", agent: "nina" },
      { id: "import", text: "landing.onboarding.steps.agents.opts.import", icon: "download", extra: true },
    ],
  },
  {
    id: "tools",
    skip: true,
    options: [
      { id: "three", text: "landing.onboarding.steps.tools.opts.three", icon: "plug" },
      { id: "later", text: "landing.onboarding.steps.tools.opts.later" },
    ],
  },
  {
    id: "team",
    multi: true,
    skip: true,
    options: [
      { id: "marina", person: "marina", icon: "person" },
      { id: "rafael", person: "rafael", icon: "person" },
    ],
  },
  { id: "ready", options: [] },
];
const LAST = STEPS.length - 1;

const emailOf = (p: PersonKey) => `${PEOPLE[p].short.toLowerCase()}@${ORG.slug}.com.br`;

/**
 * "Começar": Ada hosts the onboarding, one question per step with the answer
 * already suggested, the rail on the left filling up. It plays by itself while
 * on screen (paused under the pointer or keyboard focus) and loops; every
 * button and rail step works.
 */
export function Onboarding() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisible(ref, { threshold: 0.35 });
  const [step, setStep] = useState(0);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  // Bumped when the tab was hidden at the tick, so the timer arms again.
  const [tick, setTick] = useState(0);
  const joy = useJoy();
  const { trigger } = joy;

  const next = () => setStep((s) => (s + 1) % STEPS.length);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new step (and each retry tick) arms the timer again
  useEffect(() => {
    if (!visible || hover || focus) return;
    const timer = setTimeout(() => {
      if (document.hidden) setTick((n) => n + 1);
      else setStep((s) => (s + 1) % STEPS.length);
    }, STEP_MS);
    return () => clearTimeout(timer);
  }, [step, visible, hover, focus, tick]);

  useEffect(() => {
    if (step === LAST) trigger(2400);
  }, [step, trigger]);

  // What was answered, under a done step on the rail.
  const answer = (id: StepId): string | undefined => {
    switch (id) {
      case "company":
        return ORG.name;
      case "code":
        return REPO;
      case "about":
      case "agents":
      case "tools":
      case "team":
        return t(`landing.onboarding.steps.${id}.answer`);
      default:
        return undefined;
    }
  };
  const rail: RailStep[] = STEPS.map((s, i) => ({
    id: s.id,
    name: t(`landing.onboarding.steps.${s.id}.name`),
    done: i < step,
    disabled: false,
    value: answer(s.id),
  }));

  // Keyboard focus inside pauses it (a mouse click doesn't: leaving with the pointer resumes).
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.matches(":focus-visible")) setFocus(true);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
  };

  const current = STEPS[step] as Step;
  return (
    <section className="lp-sec" id="comecar">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.onboarding.eyebrow")}</span>
          <h2>{t("landing.onboarding.title")}</h2>
          <p className="lp-lead">{t("landing.onboarding.lead")}</p>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only pause the autoplay */}
        <div
          className="lp-onb-frame"
          ref={ref}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <Card as="div" className="lp-onb">
            <div className="lp-onb-rail">
              <StepRail
                label={t("landing.onboarding.rail")}
                steps={rail}
                current={step}
                onGo={setStep}
                doneLabel={t("landing.onboarding.done")}
              />
            </div>
            <div className="lp-onb-pane">
              {/* Every step sits in the same cell (only one shows), so the card is as tall as the tallest one. */}
              <div className="lp-onb-stack">
                {STEPS.map((s, i) =>
                  i === step ? (
                    <Ask key={`now-${s.id}`} step={s} joyClass={joy.className} />
                  ) : (
                    <Ask key={s.id} step={s} ghost />
                  ),
                )}
              </div>
              <div className="lp-onb-go">
                {current.skip && (
                  <Button variant="ghost" size="sm" onClick={next}>
                    {t("landing.onboarding.skip")}
                  </Button>
                )}
                <Button variant="primary" size="sm" kbd={["↵"]} onClick={next}>
                  {t(`landing.onboarding.steps.${current.id}.cta`)}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}

/**
 * Ada's question and the suggested answers. A `ghost` copy keeps its place
 * (hidden, without the live avatars) so switching steps never moves the page.
 */
function Ask({ step, ghost, joyClass }: { step: Step; ghost?: boolean; joyClass?: string }) {
  const { t } = useTranslation();
  const id = step.id;
  const say =
    id === "about"
      ? t("landing.onboarding.steps.about.say", { org: ORG.name })
      : id === "ready"
        ? t("landing.onboarding.steps.ready.say", { name: CAST.dev.name })
        : t(`landing.onboarding.steps.${id}.say`);
  const label = (o: Option): string => {
    if (o.person) return emailOf(o.person);
    if (o.agent) return t(`landing.onboarding.steps.agents.opts.${o.agent}`, { name: CAST[o.agent].name });
    if (o.text === "landing.onboarding.steps.code.opts.repo") return t(o.text, { repo: REPO });
    return o.text ? t(o.text) : ORG.name;
  };
  return (
    <div className={cx("lp-onb-ask", ghost && "lp-onb-ask--ghost")} aria-hidden={ghost || undefined} inert={ghost}>
      <Message
        agent
        entering={!ghost}
        avatar={
          ghost ? <span className="lp-onb-ph" /> : <LpAvatar look={HOST.look} name={HOST.name} className={joyClass} />
        }
        author={HOST.name}
        time={t("landing.when.now")}
      >
        <MessageText>{say}</MessageText>
      </Message>
      {step.options.length > 0 && (
        <ul className="lp-onb-opts">
          {step.options.map((o, i) => {
            const chosen = step.multi ? !o.extra : i === 0;
            return (
              <li
                key={o.id}
                className="lp-onb-opt"
                data-chosen={chosen || undefined}
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <span className="lp-onb-lead">
                  {o.agent ? (
                    ghost ? (
                      <span className="lp-onb-ph lp-onb-ph--sm" />
                    ) : (
                      <LpAvatar look={CAST[o.agent].look} name={CAST[o.agent].name} px={26} />
                    )
                  ) : (
                    <Icon name={o.icon ?? "check"} />
                  )}
                </span>
                <span className="lp-onb-label">{label(o)}</span>
                {chosen && <span className="ac-visually-hidden">{t("landing.onboarding.selected")}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
