import { type AgentState, cx } from "@agenteschat/ui";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST } from "./cast";
import { useJoy } from "./hooks";
import { LpAvatar } from "./LpAvatar";
import { SceneApproval, SceneLedger, type SceneProps, SceneRequest, SceneWho, SceneWork } from "./Scenes";
import "./Story.css";

const STEPS = ["s1", "s2", "s3", "s4", "s5"] as const;
const SCENES: ComponentType<SceneProps>[] = [SceneRequest, SceneWho, SceneWork, SceneApproval, SceneLedger];

const bump = (list: number[], i: number) => list.map((v, j) => (j === i ? v + 1 : v));

/**
 * "01 · Como funciona": a sticky screen with five scenes driven by the
 * scroll, and a progress rail from the person who asks to the agent who
 * delivers (it works while the line travels and celebrates when it arrives).
 * Below 960px each step shows its scene inline, played once.
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
    let current = 0;
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
    <section className="lp-sec" id="conversa">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.story.eyebrow")}</span>
          <h2>{t("landing.story.title")}</h2>
          <p className="lp-lead">{t("landing.story.lead")}</p>
        </div>
        <div className="lp-story">
          <div className="lp-story-steps">
            <Rail />
            {STEPS.map((s, i) => {
              const Scene = SCENES[i] as ComponentType<SceneProps>;
              return (
                <article
                  key={s}
                  className={cx("lp-story-step", i === 0 && "lp-story-step--first", active === i && "lp-on")}
                  data-i={i}
                  ref={(el) => {
                    steps.current[i] = el;
                  }}
                >
                  <div className="lp-story-n">
                    <span>{i + 1}</span>
                    {t(`landing.story.${s}.n`)}
                  </div>
                  <h3>{t(`landing.story.${s}.title`)}</h3>
                  <p>{t(`landing.story.${s}.text`)}</p>
                  <div className="lp-story-inline">
                    <Scene run={inlineRuns[i] ?? 0} />
                  </div>
                </article>
              );
            })}
          </div>
          <div className="lp-story-screen-col" ref={screenCol}>
            <div className="lp-story-screen">
              {SCENES.map((Scene, i) => (
                <div key={STEPS[i]} className={cx("lp-story-vis", active === i && "lp-on")} inert={active !== i}>
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

/** The progress line along the steps: from the person who asks to the agent who delivers. */
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
    let frame = 0;
    const sync = () => {
      frame = 0;
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
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [trigger]);
  return (
    <div className="lp-story-rail" ref={box}>
      <span className="lp-story-rail-start">
        <LpAvatar look={CAST.ada.look} px={30} name={CAST.ada.name} />
      </span>
      <i ref={fill} />
      <span className={cx("lp-story-rail-end", done && "lp-done")}>
        <LpAvatar look={CAST.dev.look} px={30} name={CAST.dev.name} state={state} className={joy.className} />
        <span className="lp-story-rail-lbl">{t("landing.story.railDone")}</span>
      </span>
    </div>
  );
}
