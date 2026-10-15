import { type AgentState, Button, cx, Logo } from "@agenteschat/ui";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ApiError } from "@/api/http";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useTheme } from "@/lib/theme";
import { AgentMaker } from "./AgentMaker";
import { Bento } from "./Bento";
import { Closing } from "./Closing";
import { type AimRegistry, LandingContext, type LandingContextValue } from "./context";
import { DemoWorkspace } from "./DemoWorkspace";
import { GIANT_LOOKS } from "./data";
import { Faq } from "./Faq";
import { Hero } from "./Hero";
import { readReducedMotion, useJoy } from "./hooks";
import { LpIcon } from "./icons";
import { LiveLedger } from "./LiveLedger";
import { StoryScroll } from "./StoryScroll";
import { type JoinResult, Waitlist } from "./Waitlist";
import "./landing.css";

const SECTIONS = [
  ["como", "how"],
  ["demo", "demo"],
  ["rosto", "agents"],
  ["controle", "control"],
  ["perguntas", "faq"],
] as const;
const hash = (id: string) => `#${id}`;

/**
 * The public landing page (signed-out `/`), ported from the approved
 * prototype docs/design/telas/Landing.html. Dark by default; the only call to
 * action is the waiting list. Everything is scoped under `.lp`.
 */
export function LandingPage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const { preference, setPreference } = useTheme();
  const [reduced] = useState(readReducedMotion);
  const [theme, setTheme] = useState<"light" | "dark">(preference === "light" ? "light" : "dark");

  // Eyes that follow the pointer.
  const aimEls = useRef(new Set<HTMLElement>());
  const locked = useRef(false);
  const aim = useMemo<AimRegistry>(() => {
    const at = (x: number, y: number) => {
      for (const el of aimEls.current) {
        const av = el.classList.contains("ac-avatar") ? el : el.querySelector<HTMLElement>(".ac-avatar");
        const face = av?.querySelector<HTMLElement>(".ac-avatar__face");
        if (!av || !face) continue;
        if (av.classList.contains("ac-avatar--thinking")) {
          face.style.transform = "";
          continue;
        }
        const r = av.getBoundingClientRect();
        if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
        const dx = x - (r.left + r.width / 2);
        const dy = y - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 320);
        face.style.transform = `translate(${(dx / d) * k * r.width * 0.075}px, ${(dy / d) * k * r.height * 0.055}px)`;
      }
    };
    return {
      register(el) {
        aimEls.current.add(el);
        return () => {
          aimEls.current.delete(el);
        };
      },
      at,
      lock(on) {
        locked.current = on;
      },
    };
  }, []);
  useEffect(() => {
    if (reduced) return;
    const onMove = (e: PointerEvent) => {
      if (!locked.current) aim.at(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [aim, reduced]);

  const scrollTo = useCallback((id: string) => {
    if (id === "top") window.scrollTo({ top: 0, behavior: "smooth" });
    else document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const ctx = useMemo<LandingContextValue>(() => ({ reduced, aim, scrollTo, theme }), [reduced, aim, scrollTo, theme]);
  const go = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    scrollTo(id);
  };

  // The nav pill hides on the way down and comes back on the way up.
  const [navHidden, setNavHidden] = useState(false);
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > 400 && y > lastY + 4) setNavHidden(true);
      else if (y < lastY - 4 || y < 400) setNavHidden(false);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    setPreference(next);
  };

  // The giant: a click cycles its look and makes it hop; it writes while someone types the email.
  const [giantLook, setGiantLook] = useState(0);
  const [giantState, setGiantState] = useState<AgentState>("idle");
  const giantJoy = useJoy();
  const busy = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typingTimer.current), []);
  const onTyping = () => {
    if (busy.current) return;
    setGiantState("writing");
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      if (!busy.current) setGiantState("idle");
    }, 700);
  };

  // The waiting list (both forms share it).
  const [joined, setJoined] = useState<string | null>(() => storage.get(STORAGE_KEYS.waitlist));
  const [celebrate, setCelebrate] = useState(0);
  const join = async (email: string): Promise<JoinResult> => {
    busy.current = true;
    clearTimeout(typingTimer.current);
    setGiantState("thinking");
    try {
      await api.waitlist.join({ email, locale: i18n.language === "en" ? "en" : "pt-BR" });
    } catch (error) {
      busy.current = false;
      setGiantState("idle");
      if (error instanceof ApiError) {
        if (error.code === "invalid_email") return "invalid";
        if (error.status === 429 || error.code === "rate_limited") return "rate";
      }
      return "failed";
    }
    busy.current = false;
    storage.set(STORAGE_KEYS.waitlist, email);
    setJoined(email);
    setGiantState("idle");
    giantJoy.trigger(2400);
    setCelebrate((c) => c + 1);
    return "ok";
  };
  const heroSlot = useRef<HTMLDivElement>(null);
  const finalSlot = useRef<HTMLDivElement>(null);
  const doneLook = GIANT_LOOKS[giantLook] ?? {};
  const onFocusHero = (input: HTMLInputElement | null) => {
    aim.lock(!!input);
    if (input) {
      const r = input.getBoundingClientRect();
      aim.at(r.left + 60, r.top + r.height / 2);
    }
  };

  return (
    <LandingContext.Provider value={ctx}>
      <div className="lp" data-theme={theme}>
        <header className={cx("lp-nav", navHidden && "lp-nav--hide")}>
          <a className="lp-logo" href={hash("top")} onClick={go("top")}>
            <Logo variant="expanded" size={21} />
          </a>
          <nav className="lp-links" aria-label={t("landing.nav.sections")}>
            {SECTIONS.map(([id, key]) => (
              <a key={id} href={hash(id)} onClick={go(id)}>
                {t(`landing.nav.${key}`)}
              </a>
            ))}
          </nav>
          <Button variant="ghost" className="lp-theme-btn" aria-label={t("landing.nav.theme")} onClick={toggleTheme}>
            <LpIcon name={theme === "light" ? "moon" : "sun"} />
          </Button>
          <Button asChild variant="primary" size="sm">
            <a href={hash("lista")} onClick={go("lista")}>
              {t("landing.nav.join")}
            </a>
          </Button>
        </header>

        <main id="top">
          <Hero
            giantLook={giantLook}
            giantState={giantState}
            giantJoy={giantJoy.className}
            onGiantClick={() => {
              setGiantLook((i) => (i + 1) % GIANT_LOOKS.length);
              giantJoy.trigger(900);
            }}
            waitlistRef={heroSlot}
            waitlist={
              <Waitlist
                ref={heroSlot}
                variant="hero"
                joined={joined}
                look={doneLook}
                onJoin={join}
                onTyping={onTyping}
                onFocusInput={onFocusHero}
              />
            }
          />
          <StoryScroll />
          <DemoWorkspace />
          <AgentMaker />
          <Bento />
          <LiveLedger />
          <Faq />
          <Closing
            celebrate={celebrate}
            waitlistRef={finalSlot}
            waitlist={
              <Waitlist
                ref={finalSlot}
                variant="final"
                joined={joined}
                look={doneLook}
                onJoin={join}
                onTyping={onTyping}
              />
            }
          />
        </main>

        <footer className="lp-footer">
          <div className="lp-wrap">
            <Logo variant="expanded" size={18} />
            <span>{t("landing.footer")}</span>
          </div>
        </footer>
      </div>
    </LandingContext.Provider>
  );
}
