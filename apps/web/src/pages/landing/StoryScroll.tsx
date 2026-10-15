import { type AgentState, cx } from "@agenteschat/ui";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useJoy } from "./hooks";
import { SampleAgent } from "./LpAvatar";
import { SceneApproval, SceneLedger, type SceneProps, SceneRequest, SceneRouter, SceneWork } from "./Scenes";

const STEPS = ["s1", "s2", "s3", "s4", "s5"] as const;
const SCENES: ComponentType<SceneProps>[] = [SceneRequest, SceneRouter, SceneWork, SceneApproval, SceneLedger];

const bump = (list: number[], i: number) => list.map((v, j) => (j === i ? v + 1 : v));

/**
 * "Como funciona": a sticky screen with five scenes driven by the scroll, and
 * a progress rail that ends in an agent (it thinks while the line travels and
 * celebrates when it arrives). Below 960px each step shows its scene inline.
 */
export function StoryScroll() {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const [runs, setRuns] = useState([1, 0, 0, 0, 0]);
  const [inlineRuns, setInlineRuns] = useState([0, 0, 0, 0, 0]);
  const screenCol = useRef<HTMLDivElement>(null);
  const steps = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    let current = -1;
    const inlineDone = new Set<number>();
    const desktop = () => {
      const col = screenCol.current;
      return !!col && getComputedStyle(col).display !== "none";
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.i);
          if (desktop()) {
            if (i === current) continue;
            current = i;
            setActive(i);
            setRuns((r) => bump(r, i));
          } else if (!inlineDone.has(i)) {
            inlineDone.add(i);
            setInlineRuns((r) => bump(r, i));
          }
        }
      },
      { rootMargin: "-40% 0px -40% 0px" },
    );
    for (const el of steps.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="lp-sec" id="como">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.how.eyebrow")}</span>
          <h2>{t("landing.how.title")}</h2>
          <p className="lp-lead">{t("landing.how.lead")}</p>
        </div>
        <div className="lp-story">
          <div className="lp-steps">
            <Rail />
            {STEPS.map((s, i) => {
              const Scene = SCENES[i] as ComponentType<SceneProps>;
              return (
                <article
                  key={s}
                  className={cx("lp-st", active === i && "lp-on")}
                  data-i={i}
                  ref={(el) => {
                    steps.current[i] = el;
                  }}
                >
                  <div className="lp-n">
                    <span>{i + 1}</span>
                    {t(`landing.how.${s}.n`)}
                  </div>
                  <h3>{t(`landing.how.${s}.title`)}</h3>
                  <p>{t(`landing.how.${s}.text`)}</p>
                  <div className="lp-inline-vis">
                    <div className="lp-vis lp-on">
                      <Scene run={inlineRuns[i] ?? 0} />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="lp-screen-col" ref={screenCol}>
            <div className="lp-screen">
              {SCENES.map((Scene, i) => (
                <div key={STEPS[i]} className={cx("lp-vis", active === i && "lp-on")} inert={active !== i}>
                  <Scene run={runs[i] ?? 0} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The progress line along the steps; it ends in an agent. */
function Rail() {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLElement>(null);
  const [state, setState] = useState<AgentState>("idle");
  const [done, setDone] = useState(false);
  const joy = useJoy();
  const { trigger } = joy;
  useEffect(() => {
    let arrived = false;
    const sync = () => {
      const el = box.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = r.height ? Math.min(1, Math.max(0, (window.innerHeight * 0.5 - r.top) / r.height)) : 0;
      if (fill.current) fill.current.style.height = `${(p * 100).toFixed(1)}%`;
      if (p >= 0.995 && !arrived) {
        arrived = true;
        setState("idle");
        trigger(1800);
        setDone(true);
      } else if (p < 0.995) {
        if (arrived) {
          arrived = false;
          setDone(false);
        }
        setState(p > 0.02 ? "thinking" : "idle");
      }
    };
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, [trigger]);
  return (
    <div className="lp-rail" ref={box}>
      <i ref={fill} />
      <span className={cx("lp-rail-end", done && "lp-done")}>
        <SampleAgent agent="lia" px={30} state={state} className={joy.className} />
        <span className="lp-lbl">{t("landing.how.railDone")}</span>
      </span>
    </div>
  );
}
