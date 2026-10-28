import {
  type AgentColor,
  type AgentState,
  Avatar,
  Button,
  bodyTones,
  Chip,
  cx,
  Icon,
  type IconName,
  Message,
  MessageText,
  PixelSpinner,
} from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST, PEOPLE } from "./cast";
import { useLanding } from "./context";
import { useFormat } from "./format";
import { type Run, useIntersection, useJoy, useRunner } from "./hooks";
import { LpAvatar } from "./LpAvatar";
import "./computer.css";

/**
 * "02 · Computador": Camila asks Nina for September's
 * invoices; Nina's browser plays inside her message. She needs a login, you
 * take over (the password stays masked) and hand it back; she downloads,
 * checks against the sheet and saves to Drive. The point on the left follows.
 */

const nina = CAST.nina;
const camila = PEOPLE.camila;
const EMAIL = "financeiro@graonorte.com.br";
const URL_LOGIN = "portal.fornecedor.com/entrar";
const URL_LIST = "portal.fornecedor.com/notas?mes=09";
/** September's invoices: number, day, amount (BRL). */
const INVOICES: [string, number, number][] = [
  ["NF 4812", 2, 1240],
  ["NF 4840", 9, 860.5],
  ["NF 4877", 16, 2115],
  ["NF 4901", 23, 640],
  ["NF 4933", 30, 1998.9],
];
const POINTS = ["live", "login", "drive"] as const;
const BRAINS: ["where" | "subscription" | "code", IconName][] = [
  ["where", "computerMac"],
  ["subscription", "brainAgent"],
  ["code", "code"],
];

type Phase = "live" | "need" | "yours" | "ready" | "done";
type StepKey = "open" | "need" | "back" | "download" | "check" | "drive";

interface View {
  phase: Phase;
  /** The highlighted point on the left (-1: none). */
  point: number;
  page: "login" | "invoices";
  email: string;
  dots: number;
  focus: "email" | "password" | null;
  cursor: { x: string; y: number };
  steps: StepKey[];
  downloading: boolean;
}

const START: View = {
  phase: "live",
  point: 0,
  page: "login",
  email: "",
  dots: 0,
  focus: null,
  cursor: { x: "260px", y: 240 },
  steps: [],
  downloading: false,
};

/** How it ends: all there is with reduced motion. */
const END: View = {
  phase: "done",
  point: 2,
  page: "invoices",
  email: EMAIL,
  dots: 10,
  focus: null,
  cursor: { x: "calc(100% - 70px)", y: 28 },
  steps: ["open", "back", "download", "check", "drive"],
  downloading: true,
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** The card's header: a dithered band of the agent's sky, light on the left. Decorative. */
function HeadSky({ color }: { color: AgentColor }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    let g: CanvasRenderingContext2D | null = null;
    try {
      g = cv?.getContext("2d") ?? null;
    } catch {
      g = null;
    }
    if (!cv || !g) return;
    const W = 120;
    const H = 11;
    cv.width = W;
    cv.height = H;
    const tones = bodyTones(color, true);
    const last = tones.length - 1;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const f = Math.min(0.999, Math.max(0, 0.9 - (x / W) * 0.75 + Math.sin(x * 0.3) * 0.03)) * last;
        const lo = Math.floor(f);
        const tn = lo + (f - lo > (BAYER[(x & 3) + (y & 3) * 4] ?? 0.5) ? 1 : 0);
        g.fillStyle = tones[Math.min(last, tn)] ?? "#000";
        g.fillRect(x, y, 1, 1);
      }
  }, [color]);
  return <canvas ref={ref} className="lp-computer-sky" />;
}

export function Computer() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { reduced } = useLanding();
  const runner = useRunner();
  const joy = useJoy();
  const [view, setView] = useState<View>(reduced ? END : START);
  const [state, setState] = useState<AgentState>("idle");
  const card = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const started = useRef(false);
  const pending = useRef(false);
  /** Ends the current wait for a person (the take-over and hand-back buttons). */
  const release = useRef<(() => void) | null>(null);
  const agent = nina.name;

  // Waits for the button or, when nobody clicks, for `ms`.
  const waitFor = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(id);
        if (release.current === done) release.current = null;
        resolve();
      };
      const id = setTimeout(done, ms);
      release.current = done;
    });

  const script = async (r: Run) => {
    const set = (patch: Partial<View>) => {
      if (r.alive()) setView((v) => ({ ...v, ...patch }));
    };
    const go = async (ms: number) => {
      await r.sleep(ms);
      return r.alive();
    };
    setView({ ...START, steps: ["open"] });
    setState("thinking");
    if (!(await go(700))) return;
    set({ cursor: { x: "120px", y: 92 } });
    if (!(await go(800))) return;
    set({ focus: "email" });
    for (let i = 1; i <= EMAIL.length; i++) {
      set({ email: EMAIL.slice(0, i) });
      if (!(await go(45))) return;
    }
    set({ focus: null });
    if (!(await go(400))) return;
    set({ cursor: { x: "120px", y: 152 } });
    if (!(await go(800))) return;
    setState("waiting");
    set({ phase: "need", point: 1, steps: ["open", "need"] });
    await waitFor(6000);
    if (!r.alive()) return;
    set({ phase: "yours", focus: "password" });
    for (let i = 1; i <= 10; i++) {
      set({ dots: i });
      if (!(await go(90))) return;
    }
    if (!(await go(400))) return;
    set({ phase: "ready" });
    await waitFor(3500);
    if (!r.alive()) return;
    setState("thinking");
    set({
      phase: "live",
      point: -1,
      page: "invoices",
      focus: null,
      steps: ["open", "back"],
      cursor: { x: "120px", y: 150 },
    });
    if (!(await go(700))) return;
    set({ cursor: { x: "calc(100% - 70px)", y: 28 } });
    if (!(await go(900))) return;
    set({ downloading: true });
    if (!(await go(700))) return;
    set({ steps: ["open", "back", "download"] });
    if (!(await go(900))) return;
    set({ steps: ["open", "back", "download", "check"], point: 2 });
    if (!(await go(900))) return;
    set(END);
    setState("idle");
    joy.trigger(2200);
    // Plays again while on screen.
    if (!(await go(6000))) return;
    if (visible.current) runner.start(script);
    else pending.current = true;
  };

  useIntersection(
    card,
    (on) => {
      visible.current = on;
      // With reduced motion it shows how it ends from the start, and nothing plays.
      if (on && !reduced && (!started.current || pending.current)) {
        started.current = true;
        pending.current = false;
        runner.start(script);
      }
    },
    { threshold: 0.3 },
  );

  const g = { agent };
  const yours = view.phase === "yours" || view.phase === "ready";
  const head =
    view.phase === "need"
      ? t("landing.computer.head.need", g)
      : yours
        ? t("landing.computer.head.yours", g)
        : view.phase === "done"
          ? t("landing.computer.head.done", g)
          : t("landing.computer.head.live", g);
  const money = new Intl.NumberFormat(fmt.locale, { style: "currency", currency: "BRL" });
  const date = new Intl.DateTimeFormat(fmt.locale, { day: "2-digit", month: "2-digit" });

  return (
    <section className="lp-sec" id="computador">
      <div className="lp-wrap lp-computer">
        <div className="lp-computer-side">
          <div className="lp-sec-head lp-sec-head--flush">
            <span className="lp-eyebrow">{t("landing.computer.eyebrow")}</span>
            <h2>{t("landing.computer.title")}</h2>
            <p className="lp-lead">{t("landing.computer.lead")}</p>
          </div>
          <ol className="lp-computer-points">
            {POINTS.map((p, i) => (
              <li key={p} className={cx(view.point === i && "is-on")}>
                <span className="lp-computer-n">{String(i + 1).padStart(2, "0")}</span>
                <span>
                  <b>{t(`landing.computer.points.${p}.title`)}</b>
                  {t(`landing.computer.points.${p}.text`)}
                </span>
              </li>
            ))}
          </ol>
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of chips */}
          <div className="lp-computer-brains" role="group" aria-label={t("landing.computer.brains.label")}>
            {BRAINS.map(([key, icon]) => (
              <Chip key={key} icon={icon}>
                {t(`landing.computer.brains.${key}`)}
              </Chip>
            ))}
          </div>
        </div>

        <div className="lp-computer-chat">
          <Message
            avatar={<Avatar name={camila.name} initials={camila.initials} />}
            author={camila.short}
            time={fmt.time(10, 12)}
          >
            <MessageText>{t("landing.computer.ask", g)}</MessageText>
          </Message>
          <Message
            agent
            avatar={<LpAvatar look={nina.look} name={agent} state={state} className={joy.className} />}
            author={agent}
            time={fmt.time(10, 12)}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, like the app's card */}
            <div ref={card} className="lp-computer-card" role="group" aria-label={t("landing.computer.card", g)}>
              <div className="lp-computer-head">
                <HeadSky color={nina.color} />
                <LpAvatar look={nina.look} name={agent} px={24} state={state} />
                <span className="lp-computer-title" aria-live="polite">
                  {head}
                </span>
                <span className="lp-computer-r">
                  {view.phase === "done" ? (
                    <>
                      <Icon name="check" size={14} />
                      {fmt.dur(130)}
                    </>
                  ) : view.phase === "live" ? (
                    <>
                      <PixelSpinner size={14} />
                      {t("landing.computer.liveNow")}
                    </>
                  ) : (
                    t("landing.computer.waiting")
                  )}
                </span>
              </div>
              <div className="lp-computer-url">
                <Icon name="lock" size={14} />
                <span>{view.page === "login" ? URL_LOGIN : URL_LIST}</span>
              </div>
              <div className="lp-computer-view">
                {view.page === "login" ? (
                  <div className="lp-computer-site" aria-hidden="true">
                    <div className="lp-computer-bar">
                      <i />
                      {t("landing.computer.site.name")}
                    </div>
                    <span className="lp-computer-label">{t("landing.computer.site.email")}</span>
                    <div className={cx("lp-computer-field", view.focus === "email" && "is-focus")}>{view.email}</div>
                    <span className="lp-computer-label">{t("landing.computer.site.password")}</span>
                    <div className={cx("lp-computer-field", view.focus === "password" && "is-focus")}>
                      {"•".repeat(view.dots)}
                    </div>
                    <div className="lp-computer-go">{t("landing.computer.site.signIn")}</div>
                  </div>
                ) : (
                  <div className="lp-computer-site" aria-hidden="true">
                    <div className="lp-computer-bar">
                      <i />
                      {t("landing.computer.site.invoices")}
                      <span className="lp-computer-dl">
                        {t(view.downloading ? "landing.computer.site.downloading" : "landing.computer.site.download")}
                      </span>
                    </div>
                    <table>
                      <tbody>
                        {INVOICES.map(([nf, day, amount]) => (
                          <tr key={nf}>
                            <td>{nf}</td>
                            <td>{date.format(new Date(2026, 8, day))}</td>
                            <td>{money.format(amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <span
                  className="lp-computer-cursor"
                  style={{ left: view.cursor.x, top: view.cursor.y }}
                  aria-hidden="true"
                >
                  <Icon name="pointer" size={18} />
                </span>
                {yours && (
                  <span className="lp-computer-mine">
                    <Icon name="pointer" size={14} />
                    {t("landing.computer.handoff.control")}
                  </span>
                )}
                {view.phase === "need" && (
                  <div className="lp-computer-handoff">
                    <div className="lp-computer-box">
                      <div className="lp-computer-box-t">
                        <LpAvatar look={nina.look} name={agent} size="xs" state="waiting" />
                        {t("landing.computer.handoff.title")}
                      </div>
                      <p>{t("landing.computer.handoff.text", g)}</p>
                      <Button variant="primary" size="sm" onClick={() => release.current?.()}>
                        {t("landing.computer.handoff.take")}
                      </Button>
                    </div>
                  </div>
                )}
                {view.phase === "ready" && (
                  <div className="lp-computer-handoff lp-computer-handoff--bare">
                    <div className="lp-computer-box lp-computer-box--row">
                      <span>{t("landing.computer.handoff.ready")}</span>
                      <Button variant="primary" size="sm" onClick={() => release.current?.()}>
                        {t("landing.computer.handoff.giveBack", g)}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              <ul className="lp-computer-steps">
                {view.steps.map((s) => (
                  <li key={s} className="lp-enter">
                    {s === "need" ? (
                      <PixelSpinner size={14} color={nina.color} />
                    ) : (
                      <Icon name="check" size={14} className="lp-computer-ok" />
                    )}
                    {t(`landing.computer.steps.${s}`)}
                  </li>
                ))}
              </ul>
            </div>
          </Message>
        </div>
      </div>
    </section>
  );
}
