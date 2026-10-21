import { ApiError } from "@agenteschat/client";
import { type AgentState, Button, cx, Logo, Segmented, setGaze } from "@agenteschat/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { type LocaleCode, setLocale } from "@/i18n";
import { loadAnalytics, track } from "@/lib/analytics";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useTheme } from "@/lib/theme";
import { Bento } from "./Bento";
import { Closing } from "./Closing";
import { Computer } from "./Computer";
import { Control } from "./Control";
import { type AimRegistry, LandingContext, type LandingContextValue } from "./context";
import { DemoWorkspace } from "./DemoWorkspace";
import { Devices } from "./Devices";
import { GIANT_LOOKS } from "./data";
import { Faq } from "./Faq";
import { Hero } from "./Hero";
import { readReducedMotion, useJoy } from "./hooks";
import { LpIcon } from "./icons";
import { Missions } from "./Missions";
import { Onboarding } from "./Onboarding";
import { StoryScroll } from "./StoryScroll";
import { Team } from "./Team";
import { type JoinResult, type LinkProblem, Waitlist } from "./Waitlist";
import "./landing.css";

const SECTIONS = [
  ["conversa", "conversation"],
  ["computador", "computer"],
  ["missoes", "missions"],
  ["equipe", "team"],
  ["controle", "control"],
  ["perguntas", "faq"],
] as const;
const hash = (id: string) => `#${id}`;
/** Who made it (a name and a handle, never translated). */
const AUTHOR = "Walter (@wescld)";
const AUTHOR_URL = "https://wescld.com";

/**
 * The public landing page (signed-out `/`). Dark by default; the only call to
 * action is the waiting list. Everything is scoped under `.lp`.
 */
export function LandingPage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const { preference, setPreference } = useTheme();
  const [reduced] = useState(readReducedMotion);
  const [theme, setTheme] = useState<"light" | "dark">(preference === "light" ? "light" : "dark");

  // Agents that turn toward the pointer: the engine's gaze, for avatars inside a registered element.
  const locked = useRef(false);
  const aim = useMemo<AimRegistry>(
    () => ({
      register(el) {
        el.setAttribute("data-gaze", "");
        return () => el.removeAttribute("data-gaze");
      },
      at: (x: number, y: number) => setGaze({ x, y }),
      lock(on) {
        locked.current = on;
      },
    }),
    [],
  );
  useEffect(() => () => setGaze(null), []);
  // The page behind the landing takes its background, so no app-theme strip shows at the edges or in the scroll bounce.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const html = document.documentElement;
    const bg = root.current ? getComputedStyle(root.current).backgroundColor : "";
    const before = { bg: html.style.backgroundColor, scheme: html.style.colorScheme };
    html.style.backgroundColor = bg;
    html.style.colorScheme = theme;
    // The phone's status bar too (theme-color), back to the app's colors on the way out.
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const colors = metas.map((m) => m.content);
    for (const m of metas) if (bg) m.content = bg;
    return () => {
      html.style.backgroundColor = before.bg;
      html.style.colorScheme = before.scheme;
      metas.forEach((m, i) => {
        m.content = colors[i] ?? m.content;
      });
    };
  }, [theme]);
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

  const locale: LocaleCode = i18n.language === "en" ? "en" : "pt-BR";
  const languages = useMemo(
    () => [
      { value: "pt-BR" as const, label: t("landing.nav.langPt") },
      { value: "en" as const, label: t("landing.nav.langEn") },
    ],
    [t],
  );

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

  useEffect(loadAnalytics, []);

  // The waiting list (both forms share it).
  const [joined, setJoined] = useState<string | null>(() => storage.get(STORAGE_KEYS.waitlist));
  const [confirmed, setConfirmed] = useState(() => storage.get(STORAGE_KEYS.waitlistConfirmed) === "1");
  const [linkProblem, setLinkProblem] = useState<LinkProblem | null>(null);
  const [celebrate, setCelebrate] = useState(0);

  // Opened from the confirmation email (`/?confirm=…`): confirm, then drop the token from the address.
  const { confirm: confirmToken } = useSearch({ strict: false });
  const navigate = useNavigate();
  const confirming = useRef<string | null>(null);
  const hop = giantJoy.trigger;
  useEffect(() => {
    if (!confirmToken || confirming.current === confirmToken) return;
    confirming.current = confirmToken;
    void api.waitlist.confirm({ token: confirmToken }).then(
      () => {
        storage.set(STORAGE_KEYS.waitlistConfirmed, "1");
        track("waitlist_confirmed");
        setConfirmed(true);
        setLinkProblem(null);
        hop(2400);
        setCelebrate((c) => c + 1);
      },
      (error) => {
        const expired = error instanceof ApiError && error.code === "invalid_token";
        track("waitlist_confirm_failed", { reason: expired ? "expired" : "error" });
        if (expired) {
          // Back to the form, so they can ask for a new link.
          storage.remove(STORAGE_KEYS.waitlist);
          setJoined(null);
        }
        setLinkProblem(expired ? "expired" : "confirmFailed");
      },
    );
    void navigate({ to: "/", search: {}, replace: true });
  }, [api, confirmToken, hop, navigate]);
  const join = async (email: string): Promise<JoinResult> => {
    busy.current = true;
    clearTimeout(typingTimer.current);
    setGiantState("thinking");
    try {
      await api.waitlist.join({ email, locale });
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
    track("waitlist_joined", { locale });
    setJoined(email);
    setLinkProblem(null);
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
      <div className="lp" data-theme={theme} ref={root}>
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
          <Segmented
            size="sm"
            className="lp-lang"
            label={t("landing.nav.language")}
            value={locale}
            options={languages}
            onValueChange={(code) => setLocale(code, i18n)}
          />
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
            onCelebrate={() => giantJoy.trigger(1600)}
            waitlistRef={heroSlot}
            waitlist={
              <Waitlist
                ref={heroSlot}
                variant="hero"
                joined={joined}
                confirmed={confirmed}
                linkProblem={linkProblem}
                look={doneLook}
                onJoin={join}
                onTyping={onTyping}
                onFocusInput={onFocusHero}
              />
            }
          />
          <StoryScroll />
          <DemoWorkspace />
          <Computer />
          <Missions />
          <Team />
          <Bento />
          <Devices />
          <Control />
          <Onboarding />
          <Faq />
          <Closing
            celebrate={celebrate}
            waitlistRef={finalSlot}
            waitlist={
              <Waitlist
                ref={finalSlot}
                variant="final"
                joined={joined}
                confirmed={confirmed}
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
            <span className="lp-footer__by">
              {t("landing.footerBy")}{" "}
              <a href={AUTHOR_URL} target="_blank" rel="noopener">
                {AUTHOR}
              </a>
            </span>
          </div>
        </footer>
      </div>
    </LandingContext.Provider>
  );
}
