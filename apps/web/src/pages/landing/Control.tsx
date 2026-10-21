import { agentGradient, Card, CardFooter, CardHeader } from "@agenteschat/ui";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST, type CastKey } from "./cast";
import { useJoy } from "./hooks";
import { type Decision, LpApproval } from "./kit/Approval";
import { LpAvatar } from "./LpAvatar";
import "./control.css";

/** Each agent's share of its monthly budget (%): usage in percent, money only for admins. */
const BUDGETS: [CastKey, number][] = [
  ["dev", 72],
  ["atlas", 41],
  ["nina", 92],
  ["theo", 23],
];
const CELLS = 20;
/** Above this the bar turns to the warning color. */
const HOT = 85;
/** How long the decided card stays before the request comes back. */
const RESET_MS = 3500;

/** "07 · Controle": the exact action (a live request), a person behind every agent, keys nobody sees. */
export function Control() {
  const { t } = useTranslation();
  return (
    <section className="lp-sec" id="controle">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.control.eyebrow")}</span>
          <h2>{t("landing.control.title")}</h2>
          <p className="lp-lead">{t("landing.control.lead")}</p>
        </div>
        <div className="lp-ctrl">
          <Card className="lp-ctrl-card">
            <CardHeader icon="approve" title={t("landing.control.exactTitle")} />
            <p className="lp-ctrl-text">{t("landing.control.exact")}</p>
            <ExactRequest />
          </Card>
          <Card className="lp-ctrl-card">
            <CardHeader icon="person" title={t("landing.control.ownerTitle")} />
            <p className="lp-ctrl-text">{t("landing.control.owner")}</p>
            <div className="lp-ctrl-bud">
              {BUDGETS.map(([key, pct]) => (
                <Budget key={key} agent={key} pct={pct} />
              ))}
            </div>
          </Card>
          <Card className="lp-ctrl-card">
            <CardHeader icon="lock" title={t("landing.control.keysTitle")} />
            <p className="lp-ctrl-text">{t("landing.control.keys")}</p>
            <div className="lp-ctrl-push">
              <CardFooter icon="check">{t("landing.control.lesson")}</CardFooter>
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}

/**
 * Theo's request with the exact rows. Decided, the card keeps the height it
 * had (the page never moves) and the request comes back after a few seconds.
 */
function ExactRequest() {
  const { t } = useTranslation();
  const joy = useJoy();
  const box = useRef<HTMLDivElement>(null);
  const [decided, setDecided] = useState<Decision | undefined>();
  const [minHeight, setMinHeight] = useState<number | undefined>();

  useEffect(() => {
    if (!decided) return;
    const id = setTimeout(() => {
      setDecided(undefined);
      setMinHeight(undefined);
    }, RESET_MS);
    return () => clearTimeout(id);
  }, [decided]);

  const decide = (choice: Decision) => {
    setMinHeight(box.current?.offsetHeight);
    setDecided(choice);
    if (choice === "yes") joy.trigger();
  };
  const theo = CAST.theo;
  return (
    <div className="lp-ctrl-appr" ref={box} style={minHeight ? { minHeight } : undefined}>
      <LpApproval
        who={<LpAvatar look={theo.look} size="xs" name={theo.name} className={joy.className} />}
        title={t("landing.control.ask.title")}
        rows={[
          [t("landing.control.ask.to"), t("landing.control.ask.toValue")],
          [t("landing.control.ask.subject"), t("landing.control.ask.subjectValue")],
        ]}
        color={theo.color}
        fuse={9 / 24}
        waitingLabel={t("landing.approval.expires", { h: 9 })}
        decided={decided}
        decidedLabel={decided === "yes" ? t("landing.control.ask.approved") : t("landing.approval.refusedYou")}
        onDecide={decide}
        hint={null}
      />
    </div>
  );
}

/** One agent's usage this month as a pixel bar (in its color, warm when close to the limit). */
function Budget({ agent, pct }: { agent: CastKey; pct: number }) {
  const { t } = useTranslation();
  const a = CAST[agent];
  const on = Math.round((pct / 100) * CELLS);
  const style = { "--lp-ctrl-c": agentGradient(a.color)[1] } as CSSProperties;
  return (
    <div className="lp-ctrl-bud__row">
      <LpAvatar look={a.look} size="sm" name={a.name} />
      <span className="lp-ctrl-bud__name">{a.name}</span>
      {/* biome-ignore lint/a11y/useSemanticElements: the native <meter> has a native look we never show */}
      <span
        className="lp-ctrl-bud__bar"
        role="meter"
        aria-label={t("landing.control.usage", { agent: a.name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        style={style}
      >
        {Array.from({ length: CELLS }, (_, i) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed cells
            key={i}
            className={i < on ? (pct > HOT ? "is-hot" : "is-on") : undefined}
          />
        ))}
      </span>
      <span className="lp-ctrl-bud__pc">{pct}%</span>
    </div>
  );
}
