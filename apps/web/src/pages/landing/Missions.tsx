import { Button, Card, CardHeader, Chip, cx, Icon } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST, type CastKey, PEOPLE } from "./cast";
import { useLanding } from "./context";
import { useFormat } from "./format";
import { useIntersection, useJoy } from "./hooks";
import { LpAvatar } from "./LpAvatar";
import "./missions.css";

/**
 * "03 · Missões" (telas/LandingNova.html): a mission of days, its plan with
 * the agent on each step, what they report along the way and the decision
 * that waits for Rafael. The slider (or "Tocar") moves the mission through
 * its three days.
 */

/** Plan steps: key, agent, done at (0–100 on the slider). */
const PLAN: ["docs" | "find" | "keys" | "swap" | "compare" | "staging" | "prod", CastKey, number][] = [
  ["docs", "dev", 6],
  ["find", "dev", 18],
  ["keys", "atlas", 30],
  ["swap", "dev", 46],
  ["compare", "nina", 64],
  ["staging", "atlas", 80],
  ["prod", "atlas", 96],
];

/** What the agents report: shown at, agent, key, day, time, carries the decision. */
const FEED: {
  at: number;
  agent: CastKey;
  key: "plan" | "found" | "asked" | "tests" | "cents" | "staging" | "prod";
  day: number;
  h: number;
  m: number;
  decision?: true;
}[] = [
  { at: 2, agent: "dev", key: "plan", day: 1, h: 9, m: 12 },
  { at: 16, agent: "dev", key: "found", day: 1, h: 11, m: 40 },
  { at: 26, agent: "atlas", key: "asked", day: 1, h: 15, m: 5 },
  { at: 44, agent: "dev", key: "tests", day: 2, h: 10, m: 20 },
  { at: 58, agent: "nina", key: "cents", day: 2, h: 16, m: 48, decision: true },
  { at: 78, agent: "atlas", key: "staging", day: 3, h: 9, m: 30 },
  { at: 96, agent: "atlas", key: "prod", day: 3, h: 14, m: 2 },
];

/** Past this point the decision is already taken (the mission went on). */
const DECIDED_AT = 66;
const CELLS = 28;
/** Slider units per millisecond while playing (the whole mission in 12 s). */
const SPEED = 1 / 120;

const rafael = PEOPLE.rafael;

export function Missions() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { reduced } = useLanding();
  const joy = useJoy();
  const [v, setV] = useState(0);
  const [decided, setDecided] = useState(false);
  const raf = useRef(0);
  const plan = useRef<HTMLUListElement>(null);
  const prev = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Atlas is happy when the mission lands.
  useEffect(() => {
    if (v >= 96 && prev.current < 96) joy.trigger(1200);
    prev.current = v;
  }, [v, joy.trigger]);

  const play = () => {
    cancelAnimationFrame(raf.current);
    const from = v >= 100 ? 0 : v;
    if (reduced) {
      setV(100);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const next = Math.min(100, from + (now - t0) * SPEED);
      setV(next);
      if (next < 100) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  // Plays once, the first time the plan comes into view.
  useIntersection(
    plan,
    (on, observer) => {
      if (!on) return;
      observer.disconnect();
      play();
    },
    { threshold: 0.4 },
  );

  const dayLabel =
    v >= 100 ? t("landing.missions.delivered") : t("landing.missions.day", { day: v < 40 ? 1 : v < 70 ? 2 : 3 });
  const shown = FEED.filter((e) => v >= e.at).slice(-5);
  const done = decided || v >= DECIDED_AT;

  return (
    <section className="lp-sec" id="missoes">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.missions.eyebrow")}</span>
          <h2>{t("landing.missions.title")}</h2>
          <p className="lp-lead">{t("landing.missions.lead")}</p>
        </div>
        <div className="lp-missions">
          <Card className="lp-missions-card">
            <CardHeader
              icon="flag"
              title={t("landing.missions.mission.title")}
              subtitle={t("landing.missions.mission.meta", {
                person: rafael.short,
                a: CAST.dev.name,
                b: CAST.atlas.name,
                c: CAST.nina.name,
              })}
            />
            <ul ref={plan} className="lp-missions-plan">
              {PLAN.map(([key, agent, at], i) => {
                const isDone = v >= at;
                const isNow = !isDone && (i === 0 || v >= (PLAN[i - 1]?.[2] ?? 0));
                return (
                  <li key={key} className={cx(isDone && "is-done", isNow && "is-now")}>
                    <span className="lp-missions-bx" aria-hidden="true">
                      <Icon name="check" size={14} />
                    </span>
                    <span className="lp-missions-step">{t(`landing.missions.plan.${key}`)}</span>
                    <span className="lp-missions-who">
                      <LpAvatar look={CAST[agent].look} name={CAST[agent].name} px={20} />
                      {CAST[agent].name}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="lp-missions-prog" aria-hidden="true">
              {Array.from({ length: CELLS }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                <i key={i} className={cx(i / CELLS < v / 100 && "is-on")} />
              ))}
            </div>
            <div className="lp-missions-scrub">
              <span className="lp-missions-day">{dayLabel}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={0.5}
                value={v}
                aria-label={t("landing.missions.scrub")}
                aria-valuetext={dayLabel}
                onChange={(e) => {
                  cancelAnimationFrame(raf.current);
                  setV(Number(e.target.value));
                }}
              />
              <Button size="sm" icon="repeat" onClick={play}>
                {t("landing.missions.play")}
              </Button>
            </div>
          </Card>

          <Card className="lp-missions-card">
            <CardHeader
              icon="message"
              title={t("landing.missions.feed.title")}
              subtitle={t("landing.missions.feed.sub")}
            />
            <div className="lp-missions-feed">
              {shown.map((e) => {
                const a = CAST[e.agent];
                return (
                  <div key={e.key} className="lp-missions-ev lp-enter">
                    <LpAvatar
                      look={a.look}
                      name={a.name}
                      px={26}
                      className={e.agent === "atlas" && e.key === "prod" ? joy.className : undefined}
                    />
                    <div className="lp-missions-ev-body">
                      <b>{a.name}</b> {t(`landing.missions.feed.${e.key}`)}
                      <small>{t("landing.missions.when", { day: e.day, time: fmt.time(e.h, e.m) })}</small>
                      {e.decision && (
                        <div className="lp-missions-dec">
                          <b>{t("landing.missions.decision.lead", { name: rafael.short })}</b>{" "}
                          {t("landing.missions.decision.question")}
                          <div className="lp-missions-acts">
                            {done ? (
                              <Chip icon="check" tone="done">
                                {t("landing.missions.decision.accepted", { name: rafael.short })}
                              </Chip>
                            ) : (
                              <>
                                <Button variant="primary" size="sm" onClick={() => setDecided(true)}>
                                  {t("landing.missions.decision.accept")}
                                </Button>
                                <Button variant="ghost" size="sm">
                                  {t("landing.missions.decision.other")}
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}
