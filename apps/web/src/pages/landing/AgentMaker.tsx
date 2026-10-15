import {
  type AgentColor,
  type AgentEyes,
  Avatar,
  Button,
  Chip,
  Icon,
  Message,
  MessageText,
  Meter,
} from "@agenteschat/ui";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanding } from "./context";
import { AGENTS, GRAD, LP_ACCESSORIES, LP_COLORS, LP_EYES, type LpAccessory, MODELS, PEOPLE } from "./data";
import { useFormat } from "./format";
import { useAimRef, useIntersection, useJoy } from "./hooks";
import { LpIcon } from "./icons";
import { LpAvatar } from "./LpAvatar";
import { RichText } from "./rich";
import { drawGlow, glowPalette } from "./sky";

const one = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)] as T;

/** "Monte o seu": the agent customizer, with a dithered glow in the chosen color. */
export function AgentMaker() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { theme } = useLanding();
  const aimRef = useAimRef();
  const nameId = useId();
  const joy = useJoy();
  const [name, setName] = useState(AGENTS.lia.name);
  const [color, setColor] = useState<AgentColor>("sky");
  const [eyes, setEyes] = useState<AgentEyes>("round");
  const [accessory, setAccessory] = useState<LpAccessory>("none");
  const [writing, setWriting] = useState(false);
  const writingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(writingTimer.current), []);

  const canvas = useRef<HTMLCanvasElement>(null);
  const palette = useMemo(() => glowPalette(color, theme), [color, theme]);
  useEffect(() => {
    const c = canvas.current;
    const host = c?.parentElement;
    if (!c || !host) return;
    const draw = () => drawGlow(c, palette);
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [palette]);

  const meterRef = useRef<HTMLElement>(null);
  const [budget, setBudget] = useState(0);
  useIntersection(meterRef, (visible) => visible && setBudget(31.4), { threshold: 0.5 });

  const look = { color, eyes, accessory };
  const shown = name.trim() || t("landing.maker.noName");
  const marina = PEOPLE.marina;
  const pick = (fn: () => void) => {
    fn();
    joy.trigger(700);
  };

  return (
    <section className="lp-sec lp-sec--flush" id="rosto">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.maker.eyebrow")}</span>
          <h2>{t("landing.maker.title")}</h2>
          <p className="lp-lead">{t("landing.maker.lead")}</p>
        </div>
        <div className="lp-maker">
          <div className="lp-mk-stage">
            <div className="lp-mk-hero">
              <canvas ref={canvas} />
              <button
                type="button"
                className="lp-mk-av"
                ref={aimRef}
                aria-label={t("landing.maker.preview")}
                onClick={() => joy.trigger()}
              >
                <LpAvatar look={look} px={150} state={writing ? "writing" : undefined} className={joy.className} />
              </button>
            </div>
            <div className="lp-mk-card">
              <div>
                <h3>{shown}</h3>
                <div className="lp-role">{t("landing.maker.role")}</div>
              </div>
              <dl className="lp-kv">
                <dt>{t("landing.maker.owner")}</dt>
                <dd>
                  <Avatar name={marina.name} initials={marina.initials} size="sm" />
                  {marina.name}
                </dd>
                <dt>{t("landing.maker.model")}</dt>
                <dd>
                  {MODELS.sonnet} <span className="lp-faint">· {t("landing.maker.orgKey")}</span>
                </dd>
                <dt>{t("landing.maker.canUse")}</dt>
                <dd>
                  <span className="lp-scope">
                    <Icon name="pullRequest" size={14} />
                    {t("landing.maker.github")}
                  </span>
                  <span className="lp-scope">
                    <Icon name="alert" size={14} />
                    {t("landing.maker.sentry")}
                  </span>
                </dd>
                <dt>{t("landing.maker.asks")}</dt>
                <dd>
                  <Chip icon="waiting" tone="waiting">
                    {t("landing.maker.merge")}
                  </Chip>
                  <Chip icon="waiting" tone="waiting">
                    {t("landing.maker.deploy")}
                  </Chip>
                  <Chip icon="waiting" tone="waiting">
                    {t("landing.maker.rollback")}
                  </Chip>
                </dd>
                <dt>{t("landing.maker.budget")}</dt>
                <dd className="lp-kv-budget" ref={meterRef}>
                  <span className="lp-muted">
                    <RichText
                      text={t("landing.maker.budgetOf", {
                        used: fmt.usd(31.4),
                        cap: fmt.usd(50, 0),
                        month: fmt.month(),
                      })}
                    />
                  </span>
                  <Meter value={budget} max={50} label={t("landing.maker.budget")} />
                </dd>
              </dl>
            </div>
          </div>
          <div className="lp-mk-controls">
            <div className="lp-ctl">
              <label htmlFor={nameId} className="lp-lab">
                {t("landing.maker.name")}
              </label>
              <input
                id={nameId}
                className="lp-field"
                value={name}
                maxLength={18}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  setWriting(true);
                  clearTimeout(writingTimer.current);
                  writingTimer.current = setTimeout(() => setWriting(false), 600);
                }}
              />
            </div>
            <Options legend={t("landing.maker.color")}>
              {LP_COLORS.map((c) => (
                <Option
                  key={c}
                  label={t(`landing.maker.colors.${c}`)}
                  pressed={color === c}
                  onClick={() => pick(() => setColor(c))}
                >
                  <span
                    className="lp-sw"
                    style={{
                      background:
                        c === "sky"
                          ? "linear-gradient(160deg,var(--agent2),var(--agent))"
                          : `linear-gradient(160deg,${GRAD[c][0]},${GRAD[c][1]})`,
                    }}
                  />
                </Option>
              ))}
            </Options>
            <Options legend={t("landing.maker.eyes")}>
              {LP_EYES.map((e) => (
                <Option
                  key={e}
                  label={t(`landing.maker.eyesNames.${e}`)}
                  pressed={eyes === e}
                  onClick={() => pick(() => setEyes(e))}
                >
                  <LpAvatar look={{ color, eyes: e }} px={26} />
                </Option>
              ))}
            </Options>
            <Options legend={t("landing.maker.accessory")}>
              {LP_ACCESSORIES.map((a) => (
                <Option
                  key={a}
                  label={t(`landing.maker.accessories.${a}`)}
                  pressed={accessory === a}
                  onClick={() => pick(() => setAccessory(a))}
                >
                  <LpAvatar look={{ color, accessory: a }} px={26} />
                </Option>
              ))}
            </Options>
            <div className="lp-ctl">
              <span className="lp-lab">{t("landing.maker.inChat")}</span>
              <div className="lp-mk-prev">
                <Message avatar={<LpAvatar look={look} />} author={shown} time={t("landing.when.now")} agent>
                  <MessageText>{t("landing.maker.hello")}</MessageText>
                </Message>
              </div>
            </div>
            <div>
              <Button
                onClick={() =>
                  pick(() => {
                    setColor(one(LP_COLORS));
                    setEyes(one(LP_EYES));
                    setAccessory(one(LP_ACCESSORIES));
                  })
                }
              >
                <LpIcon name="shuffle" size={16} />
                {t("landing.maker.random")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Options({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="lp-ctl">
      <legend className="lp-lab">{legend}</legend>
      <div className="lp-opts">{children}</div>
    </fieldset>
  );
}

function Option({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="lp-opt" aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
