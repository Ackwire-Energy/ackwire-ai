import type { AgentAppearance } from "@agenteschat/ui";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CREW } from "./data";
import { useAimRef, useJoy } from "./hooks";
import { LpAvatar } from "./LpAvatar";
import { PixelSky } from "./PixelSky";
import { CLOSING_SKY } from "./sky";

/** The closing sky: the second waiting list form and the agent crew (they celebrate when someone joins). */
export function Closing({
  waitlist,
  waitlistRef,
  celebrate,
}: {
  waitlist: ReactNode;
  waitlistRef: RefObject<HTMLDivElement | null>;
  /** Bumped on every successful join. */
  celebrate: number;
}) {
  const { t } = useTranslation();
  const h2 = useRef<HTMLHeadingElement>(null);
  const lead = useRef<HTMLParagraphElement>(null);
  const calm = useCallback(() => [h2.current, lead.current, waitlistRef.current], [waitlistRef]);
  return (
    <section className="lp-closing" id="lista">
      <div className="lp-sky">
        <PixelSky options={{ pixel: 4, sprites: true, calmV: 6 / 7, calm, ...CLOSING_SKY }} />
        <div className="lp-in">
          <h2 ref={h2}>{t("landing.closing.title")}</h2>
          <p className="lp-lead" ref={lead}>
            {t("landing.closing.lead")}
          </p>
          {waitlist}
        </div>
        <div className="lp-crew" aria-hidden="true">
          {CREW.map(([look, px], i) => (
            <CrewMember key={`${look.color}-${px}`} look={look} px={px} index={i} celebrate={celebrate} />
          ))}
        </div>
      </div>
    </section>
  );
}

function CrewMember({
  look,
  px,
  index,
  celebrate,
}: {
  look: AgentAppearance;
  px: number;
  index: number;
  celebrate: number;
}) {
  const aimRef = useAimRef();
  const joy = useJoy();
  const { trigger } = joy;
  useEffect(() => {
    if (!celebrate) return;
    const id = setTimeout(() => trigger(1800), index * 90);
    return () => clearTimeout(id);
  }, [celebrate, index, trigger]);
  // Decorative (the crew is aria-hidden): a hover or a click makes one hop.
  const ref = useCallback(
    (el: HTMLSpanElement | null) => {
      if (!el) return;
      const unaim = aimRef(el);
      const hop = () => trigger(900);
      el.addEventListener("pointerenter", hop);
      el.addEventListener("click", hop);
      return () => {
        unaim?.();
        el.removeEventListener("pointerenter", hop);
        el.removeEventListener("click", hop);
      };
    },
    [aimRef, trigger],
  );
  const size = `clamp(${Math.round(px * 0.45)}px, ${(px / 12).toFixed(1)}vw, ${px}px)`;
  return (
    <span className="lp-crew-m" ref={ref}>
      <LpAvatar look={look} px={size} className={joy.className} />
    </span>
  );
}
