/**
 * The welcome window: how the app finds its server. agentes.chat is the one big action; your own server is a
 * small line under it, leading to Connect (an address, or one found on this computer or the Tailscale
 * network, and the one-command setup for a server that has none yet) or to running agentes.chat on this
 * computer (on Windows, the two ways to run one for now). A connect link (`agenteschat://connect`) opens here
 * too: the server in large type, nothing changes before Connect. Choosing a server opens the main window there
 * and closes this one.
 */
import {
  CLOUD_SERVER,
  type ConnectLink,
  connectLink,
  parseConnectLink,
  type ServerCheck,
} from "@agenteschat/client/lib/server";
import { isEmail } from "@agenteschat/client/lib/text";
import {
  Button,
  Chip,
  Field,
  glowTones,
  Icon,
  InfoHint,
  Input,
  PixelSky,
  PixelSpinner,
  type SkyOptions,
  Switch,
} from "@agenteschat/ui";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "../app";
import {
  type Candidate,
  type ConnectProblem,
  connectOutcome,
  escapeAction,
  type FirstScreen,
  foundServers,
  INSTALL_COMMAND,
  INSTALL_COMMAND_LIVE,
  type LinkView,
  LOOK_MS,
  linkView,
  ownServerScreen,
  PROBLEM_TEXT,
  runHereScreen,
  typedServer,
  WSL_INSTALL_COMMAND,
} from "../control/first-run";
import {
  hereView,
  type LocalServerStatus,
  type SetupStep,
  type StepChange,
  setupSteps,
  stepStates,
  type Tailnet,
} from "../control/local-server";
import { appServer, serverKind, serverName } from "../control/server";
import { readPref, useOnShown, writePref } from "../hooks";
import { BrandFace, CommandCopy, HelpLink } from "../ui/bits";
import { CopyDiagnostics, ReachProblem, ReachRow, ServerTile } from "../ui/here";
import { hintFor, PrefRow } from "../ui/settings";
import { shortPath } from "../ui/time";

/** The sky as a horizon at the bottom of the first screen: the surface, then the sky. */
const HORIZON: SkyOptions = {
  pixel: 4,
  palette: (bg) => glowTones("sky", bg),
  light: 0,
  base: (u, v, t) => {
    const top = 1 - 0.7 * (0.8 + 0.2 * Math.sin(u * 4 + t * 0.4));
    const e = Math.max(0, Math.min(1, (v - top) / (1 - top)));
    return e * e * (3 - 2 * e) * 0.95;
  },
};

const PROBLEM_HOSTLESS: ReadonlySet<ConnectProblem> = new Set(["invalid"]);

export function FirstRun() {
  const host = useHost();
  const [screen, setScreen] = useState<FirstScreen>("choose");
  const [trail, setTrail] = useState<FirstScreen[]>([]);
  const [link, setLink] = useState<{ raw: string; parsed: ConnectLink | null; view: LinkView } | null>(null);
  // This build carries the server (Mac and Linux): "Run agentes.chat on this computer" is offered.
  const [canRunHere, setCanRunHere] = useState(false);
  // agentes.chat is being set up here: Esc leaves it on screen.
  const settingUp = useRef(false);
  const setSettingUp = useCallback((busy: boolean) => {
    settingUp.current = busy;
  }, []);
  const linkSeq = useRef(0);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const go = useCallback(
    (next: FirstScreen) => {
      setTrail((t) => [...t, screen]);
      setScreen(next);
    },
    [screen],
  );
  const back = useCallback(() => {
    setTrail((t) => {
      const prev = t[t.length - 1];
      if (prev) setScreen(prev);
      return t.slice(0, -1);
    });
  }, []);

  const finish = useCallback(
    async (server: string, page?: string) => {
      await host.chooseServer(server, page);
      await host.hideWindow("welcome").catch(() => {});
    },
    [host],
  );

  /** A server confirmed in large type (a link, or a typed address whose own address is another host). */
  const confirm = useCallback(
    async (server: string) => {
      const { current } = await host.servers();
      const view: LinkView = {
        kind: "ask",
        server,
        question: "question",
        button: "connect",
        leave: current && current !== server ? serverName(current) : null,
      };
      setLink({ raw: "", parsed: { server }, view });
      go("link");
    },
    [host, go],
  );

  /** A connect link: checked before it shows; the newest one replaces any still on screen. */
  const openLink = useCallback(
    async (raw: string) => {
      const seq = ++linkSeq.current;
      const parsed = parseConnectLink(raw, { allowHttp: "loopback" });
      const list = await host.servers();
      setLink({ raw, parsed, view: linkView(parsed, "checking", list.current) });
      // Cancel comes back to where the person was.
      const from = screenRef.current;
      if (from !== "link") setTrail((t) => [...t, from]);
      setScreen("link");
      if (!parsed) return;
      const check = await host.checkServer(parsed.server);
      if (seq !== linkSeq.current) return;
      const view = linkView(parsed, check, list.current);
      if (view.kind === "front") {
        await finish(view.server);
        return;
      }
      setLink({ raw, parsed, view });
    },
    [host, finish],
  );

  useEffect(() => {
    void host
      .localServer()
      .then((s) => setCanRunHere(s.bundled && host.platform !== "windows"))
      .catch(() => {});
  }, [host]);

  // The server the menu bar app was told to sign in to ("Server: … · Change"): it opens, as chosen then.
  useEffect(() => {
    const old = appServer(readPref<string | null>("server", null) ?? "");
    if (!old) return;
    writePref("server", null);
    void host.servers().then(({ current }) => {
      if (!current) void finish(old);
    });
  }, [host, finish]);

  // A link waiting when the window opens, and any that arrives while it's open.
  useEffect(() => {
    const take = () =>
      void host
        .takeLink()
        .then((raw) => {
          if (raw) void openLink(raw);
        })
        .catch(() => {});
    take();
    return host.onLink(take);
  }, [host, openLink]);

  // Opened again ("Add a server…"): from the start, unless a link is on screen.
  useOnShown("welcome", () => {
    if (screen === "link") return;
    setTrail([]);
    setScreen("choose");
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const action = escapeAction(trail.length, settingUp.current);
      if (action === "back") back();
      else if (action === "close")
        void host.servers().then(({ current }) => {
          if (current) void host.hideWindow("welcome").catch(() => {});
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host, trail, back]);

  return (
    <div className="dk-fr" data-screen={screen}>
      <div className="dk-fr__body" key={screen}>
        {screen === "choose" && (
          <Choose
            onCloud={(page) => void finish(CLOUD_SERVER, page)}
            onOwn={() => go(ownServerScreen(host.platform, canRunHere))}
          />
        )}
        {screen === "own" && (
          <Own onBack={back} onConnect={() => go("connect")} onHere={() => go(runHereScreen(host.platform))} />
        )}
        {screen === "connect" && (
          <Connect
            onBack={back}
            backLabel={trail[trail.length - 1] === "own" ? "own" : "choose"}
            onUse={finish}
            onConfirm={confirm}
          />
        )}
        {screen === "here" && (
          <RunHere onBack={back} onUse={finish} onConfirm={confirm} onLink={openLink} onBusy={setSettingUp} />
        )}
        {screen === "windows" && <WindowsWays onBack={back} onConnect={() => go("connect")} />}
        {screen === "link" && link && (
          <LinkSheet
            view={link.view}
            onRetry={() => void (link.raw ? openLink(link.raw) : link.parsed && confirm(link.parsed.server))}
            onAccept={(server, page) => void finish(server, page)}
            onCancel={() => {
              setLink(null);
              void host.servers().then(({ current }) => {
                if (current) void host.hideWindow("welcome").catch(() => {});
                else if (trail.length > 0) back();
                else setScreen("choose");
              });
            }}
          />
        )}
      </div>
      {screen === "choose" && (
        <span className="dk-wel__horizon" aria-hidden="true">
          <PixelSky options={HORIZON} />
        </span>
      )}
    </div>
  );
}

/** agentes.chat, big; your own server, small. */
function Choose({ onCloud, onOwn }: { onCloud: (page: string) => void; onOwn: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="dk-fr__hello">
        <span className="dk-fr__mark">
          <BrandFace size="xl" />
        </span>
        <h1>{t("desktop.first.title")}</h1>
        <p className="dk-lead">{t("desktop.first.lead")}</p>
        <Button variant="primary" className="dk-btn-lg dk-fr__cloud" autoFocus onClick={() => onCloud("/login")}>
          {t("desktop.first.cloud")}
          <Icon name="arrowRight" size={16} />
        </Button>
        <span className="dk-help">
          {t("desktop.first.create")}{" "}
          <button type="button" className="ac-link dk-link" onClick={() => onCloud("/signup")}>
            {t("desktop.first.createLink")}
          </button>
        </span>
      </div>
      <button type="button" className="dk-fr__own" onClick={onOwn}>
        {t("desktop.first.own")}
        <Icon name="chevronRight" size={14} />
      </button>
    </>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="dk-fr__back" onClick={onClick}>
      <Icon name="chevronLeft" size={14} />
      {label}
    </button>
  );
}

/** The two ways to use your own server. */
function Own({ onBack, onConnect, onHere }: { onBack: () => void; onConnect: () => void; onHere: () => void }) {
  const { t } = useTranslation();
  const host = useHost();
  const later = host.platform === "windows";
  return (
    <>
      <BackLink label={t("desktop.own.back")} onClick={onBack} />
      <h1>{t("desktop.own.title")}</h1>
      <p className="dk-lead">{t("desktop.own.lead")}</p>
      <div className="dk-fr__cards">
        <button type="button" className="dk-fr__card" onClick={onConnect}>
          <span className="dk-fr__card-art" aria-hidden="true">
            <Icon name="computer" size={18} />
            <Icon name="arrowRight" size={14} />
            <Icon name="computerLinux" size={18} />
          </span>
          <b>{t("desktop.own.connect")}</b>
          <small>{t("desktop.own.connectText")}</small>
          <Icon name="chevronRight" size={16} className="dk-fr__card-go" />
        </button>
        <button type="button" className="dk-fr__card" data-later={later || undefined} onClick={onHere}>
          <span className="dk-fr__card-art" aria-hidden="true">
            <Icon name={host.platform === "windows" ? "computerWindows" : "computer"} size={18} />
          </span>
          <b>{t("desktop.own.here")}</b>
          <small>{later ? t("desktop.own.hereLater") : t("desktop.own.hereText")}</small>
          <Icon name="chevronRight" size={16} className="dk-fr__card-go" />
        </button>
      </div>
      {!later && (
        <p className="dk-help dk-fr__which">
          <HelpLink slug="run-on-your-computer" section="who">
            {t("desktop.own.which")}
          </HelpLink>
        </p>
      )}
    </>
  );
}

function ProblemLine({ problem, host }: { problem: ConnectProblem; host: string }) {
  const { t } = useTranslation();
  return (
    <span className="dk-honest dk-fr__problem ac-iconline" role="alert">
      <Icon name="alert" size={16} />
      <span>{t(PROBLEM_TEXT[problem], PROBLEM_HOSTLESS.has(problem) ? {} : { host })}</span>
    </span>
  );
}

/** The address, what was found, and the one-command setup for a server that has none yet. */
function Connect({
  onBack,
  backLabel,
  onUse,
  onConfirm,
}: {
  onBack: () => void;
  backLabel: "own" | "choose";
  onUse: (server: string) => Promise<void>;
  onConfirm: (server: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const host = useHost();
  const [address, setAddress] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ problem: ConnectProblem; host: string } | null>(null);
  const [looking, setLooking] = useState(true);
  const [found, setFound] = useState<Candidate[]>([]);

  // Discovery: this computer and the Tailscale network, for at most LOOK_MS; only servers that answered show.
  useEffect(() => {
    let live = true;
    const budget = new Promise<"late">((r) => setTimeout(() => r("late"), LOOK_MS));
    void (async () => {
      const candidates = await Promise.race([host.discover().catch(() => [] as Candidate[]), budget]);
      if (candidates === "late") return live && setLooking(false);
      const checks: (ServerCheck | null)[] = candidates.map(() => null);
      await Promise.race([
        Promise.all(
          candidates.map(async (c, i) => {
            checks[i] = await host.checkServer(c.server).catch(() => null);
          }),
        ),
        budget,
      ]);
      if (!live) return;
      setFound(foundServers(candidates, checks));
      setLooking(false);
    })();
    return () => {
      live = false;
    };
  }, [host]);

  const submit = async (input: string) => {
    if (checking) return;
    const typed = typedServer(input);
    if (!typed.ok) return setProblem({ problem: typed.problem, host: typed.host });
    setProblem(null);
    setChecking(typed.server);
    const check = await host.checkServer(typed.server);
    setChecking(null);
    const outcome = connectOutcome(typed.server, check);
    if (outcome.kind === "problem") setProblem(outcome);
    else if (outcome.kind === "use") await onUse(outcome.server);
    else await onConfirm(outcome.server);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim()) void submit(address);
  };
  const none = hintFor(t, t("desktop.connect.none"), t("desktop.connect.noneText"));

  return (
    <>
      <BackLink label={backLabel === "own" ? t("desktop.own.title") : t("desktop.own.back")} onClick={onBack} />
      <h1>{t("desktop.connect.title")}</h1>
      <p className="dk-lead">{t("desktop.connect.lead")}</p>
      <form className="dk-fr__form" onSubmit={onSubmit}>
        <Input
          autoFocus
          value={address}
          placeholder={t("desktop.connect.placeholder")}
          aria-label={t("desktop.connect.label")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          invalid={problem !== null}
          onChange={(e) => {
            setAddress(e.target.value);
            setProblem(null);
          }}
        />
        <Button type="submit" variant="primary" disabled={!address.trim() || checking !== null}>
          {checking ? (
            <>
              <PixelSpinner size={14} color="sky" />
              {t("desktop.connect.checking")}
            </>
          ) : (
            t("desktop.connect.go")
          )}
        </Button>
      </form>
      {problem && <ProblemLine problem={problem.problem} host={problem.host} />}
      {looking ? (
        <p className="dk-fr__looking" aria-live="polite">
          <PixelSpinner size={14} color="sky" />
          <span className="dk-shimmer">{t("desktop.connect.looking")}</span>
        </p>
      ) : (
        found.length > 0 && (
          <section className="dk-fr__found" aria-label={t("desktop.connect.found")}>
            <h2 className="dk-ctitle">{t("desktop.connect.found")}</h2>
            {found.map((f) => (
              <div key={f.server} className="dk-fr__foundrow">
                <ServerTile kind={f.where} />
                <span className="dk-fr__foundtext">
                  {/* This computer by its name; its address too when it answers at more than one. */}
                  <b>{f.where === "tailnet" ? serverName(f.server) : t("desktop.link.chipHere")}</b>
                  <small>
                    {f.where === "tailnet"
                      ? t("desktop.connect.foundTailnet")
                      : found.filter((o) => o.where === "here").length > 1
                        ? `${t("desktop.connect.foundHere")} · ${serverName(f.server)}`
                        : t("desktop.connect.foundHere")}
                  </small>
                </span>
                <Button size="sm" disabled={checking !== null} onClick={() => void submit(f.server)}>
                  {t("desktop.connect.use")}
                </Button>
              </div>
            ))}
          </section>
        )
      )}
      {INSTALL_COMMAND_LIVE && (
        <section className="dk-fr__none" aria-label={t("desktop.connect.none")}>
          <span className="ac-hintline">
            <h2>{t("desktop.connect.none")}</h2>
            <InfoHint name={none.name}>{none.text}</InfoHint>
          </span>
          <CommandCopy command={INSTALL_COMMAND} />
        </section>
      )}
    </>
  );
}

/**
 * agentes.chat on this computer, inside the app: the owner's name and email (until the owner exists), reach
 * through Tailscale (off), usage statistics (on; as they were, for one that ran here before), then Start, and the
 * steps as the app runs them, each problem on its own step. One installed from the terminal already runs here:
 * Use it (its owner page while it waits for one); installed but not running: it starts there. The app runs it
 * already: open it.
 */
function RunHere({
  onBack,
  onUse,
  onConfirm,
  onLink,
  onBusy,
}: {
  onBack: () => void;
  onUse: (server: string) => Promise<void>;
  onConfirm: (server: string) => Promise<void>;
  onLink: (raw: string) => Promise<void>;
  /** Setting it up now (Esc leaves the steps on screen). */
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const host = useHost();
  const [status, setStatus] = useState<LocalServerStatus | null>(null);
  // A server (a Docker install) answering on this computer when the app doesn't run one: checked once.
  const [answering, setAnswering] = useState<string | null | undefined>(undefined);
  const [tailnet, setTailnet] = useState<Tailnet>({ state: "missing" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [reach, setReach] = useState(false);
  const [usage, setUsage] = useState(true);
  // Start was pressed with a field missing: each one says what it needs.
  const [tried, setTried] = useState(false);
  const [setup, setSetup] = useState<{ steps: SetupStep[]; changes: StepChange[] } | null>(null);
  const [problem, setProblem] = useState<{ problem: ConnectProblem; host: string } | null>(null);
  const [checking, setChecking] = useState(false);
  // Reach ended with a warning: the window stays until the person read it (the main window is already open).
  const warned = useRef(false);

  const read = useCallback(() => {
    void host
      .localServer()
      .then((s) => {
        setStatus(s);
        if (s.systemName) setName((n) => n || (s.systemName ?? ""));
        // One that ran here before starts again as it was.
        setReach(s.reach);
        setUsage(s.usage);
      })
      .catch(() => {});
    void host
      .checkServer("http://127.0.0.1:3000")
      .then((c) => setAnswering(c.ok ? c.server : null))
      .catch(() => setAnswering(null));
  }, [host]);
  useEffect(read, [read]);
  // Left mid-setup (a link arrived): the setup goes on in the app, and Esc works again on what shows.
  useEffect(() => () => onBusy(false), [onBusy]);

  // Tailscale, each time the window comes to the front (the person may have just connected it).
  useEffect(() => {
    const read = () =>
      void host
        .tailscale()
        .then(setTailnet)
        .catch(() => setTailnet({ state: "missing" }));
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [host]);

  useEffect(
    () =>
      host.onSetupStep((c) => {
        if (c.state === "warn") warned.current = true;
        setSetup((s) => (s ? { ...s, changes: [...s.changes, c] } : s));
      }),
    [host],
  );

  if (!status || answering === undefined) {
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.title")}</h1>
        <p className="dk-fr__looking" aria-live="polite">
          <PixelSpinner size={14} color="sky" />
        </p>
      </>
    );
  }
  const view = hereView(status, answering);

  if (view.kind === "running") {
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.running")}</h1>
        <p className="dk-lead">{t("desktop.here.runningText", { url: view.server })}</p>
        <div className="dk-fr__end" data-near>
          <Button variant="primary" autoFocus onClick={() => void onUse(view.server)}>
            {t("desktop.here.openIt")}
          </Button>
        </div>
      </>
    );
  }

  if (view.kind === "stopped") {
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.notRunning")}</h1>
        <p className="dk-lead">{t("desktop.here.notRunningText", { path: shortPath(status.dir) })}</p>
        <div className="dk-fr__end" data-near>
          <Button variant="primary" icon="refresh" autoFocus onClick={read}>
            {t("desktop.common.retry")}
          </Button>
        </div>
      </>
    );
  }

  if (view.kind === "already") {
    const use = async () => {
      if (view.claim) return onLink(connectLink(view.server, { claim: view.claim }));
      setChecking(true);
      const outcome = connectOutcome(view.server, await host.checkServer(view.server));
      setChecking(false);
      if (outcome.kind === "problem") setProblem(outcome);
      else if (outcome.kind === "use") await onUse(outcome.server);
      else await onConfirm(outcome.server);
    };
    return (
      <>
        <BackLink label={t("desktop.own.title")} onClick={onBack} />
        <h1>{t("desktop.here.already")}</h1>
        <p className="dk-lead">{t("desktop.here.alreadyText", { url: view.server })}</p>
        {problem && <ProblemLine problem={problem.problem} host={problem.host} />}
        <div className="dk-fr__end" data-near>
          <Button variant="primary" autoFocus loading={checking} onClick={() => void use()}>
            {t("desktop.here.useIt")}
          </Button>
        </div>
      </>
    );
  }

  const start = async () => {
    const choice = view.ask ? { name: name.trim(), email: email.trim(), reach, usage } : { reach, usage };
    setSetup({ steps: setupSteps(reach), changes: [] });
    warned.current = false;
    onBusy(true);
    try {
      await host.installLocalServer(choice);
      if (!warned.current) await host.hideWindow("welcome").catch(() => {});
    } catch {
      // The failed step says it; Try again starts over, keeping what was done.
    } finally {
      onBusy(false);
    }
  };

  if (setup) {
    return (
      <HereSetup
        steps={setup.steps}
        changes={setup.changes}
        onRetry={() => void start()}
        onContinue={() => void host.hideWindow("welcome").catch(() => {})}
      />
    );
  }

  const nameOk = name.trim().length > 0;
  const emailOk = isEmail(email);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!view.ask || (nameOk && emailOk)) void start();
    else setTried(true);
  };
  return (
    <>
      <BackLink label={t("desktop.own.title")} onClick={onBack} />
      <h1 className="dk-fr__h1sm">{t("desktop.here.title")}</h1>
      <p className="dk-lead dk-fr__wide">
        {view.ask ? t("desktop.here.how") : t("desktop.here.again", { path: shortPath(status.dir) })}
      </p>
      <form className="dk-fr__here" onSubmit={submit} noValidate>
        {view.ask && (
          <div className="dk-fr__who">
            <Field label={t("desktop.here.name")} error={tried && !nameOk ? t("desktop.here.nameNeeded") : undefined}>
              <Input
                autoFocus
                value={name}
                maxLength={100}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label={t("desktop.here.email")}
              error={tried && !emailOk ? t("desktop.here.emailNeeded") : undefined}
            >
              <Input
                type="email"
                inputMode="email"
                value={email}
                maxLength={254}
                autoComplete="email"
                spellCheck={false}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          </div>
        )}
        <div className="dk-card">
          <ReachRow tailnet={tailnet} on={reach} onChange={setReach} />
          <PrefRow
            title={t("desktop.here.usage")}
            hint={hintFor(t, t("desktop.here.usage"), t("desktop.here.usageText"))}
            htmlFor="here-usage"
            end={
              <Switch id="here-usage" aria-describedby="here-usage-hint" checked={usage} onCheckedChange={setUsage} />
            }
          />
        </div>
        <div className="dk-fr__end">
          <Button type="submit" variant="primary" autoFocus={!view.ask}>
            {t("desktop.here.start")}
          </Button>
        </div>
      </form>
    </>
  );
}

/** Each step as it runs; a failed step says what happened, reach failing never stops the rest. */
function HereSetup({
  steps,
  changes,
  onRetry,
  onContinue,
}: {
  steps: SetupStep[];
  changes: StepChange[];
  onRetry: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const states = stepStates(steps, changes);
  const done = steps.filter((s) => states[s] === "done" || states[s] === "warn").length;
  const reachProblem = changes.find((c) => c.step === "reach" && c.state === "warn")?.reason;
  return (
    <>
      <h1 className="dk-fr__h1sm">{t("desktop.here.setting")}</h1>
      <ol className="dk-fr__steps" aria-live="polite">
        {steps.map((step) => {
          const state = states[step];
          return (
            <li key={step} className="ac-iconline" data-state={state}>
              <span className="dk-fr__stepmark" aria-hidden="true">
                {state === "active" ? (
                  <PixelSpinner size={16} color="sky" />
                ) : state === "done" ? (
                  <Icon name="check" size={16} />
                ) : state === "failed" ? (
                  <Icon name="close" size={16} />
                ) : state === "warn" ? (
                  <Icon name="alert" size={16} />
                ) : (
                  <span className="dk-fr__stepdot" />
                )}
              </span>
              <span className="dk-fr__steptext">
                <span className="dk-fr__stepname">
                  <b className={state === "active" ? "dk-shimmer" : undefined}>{t(`desktop.here.step.${step}`)}</b>
                  {step === "database" && <small>{t("desktop.here.step.databaseNote")}</small>}
                  {/* The marks are drawn: screen readers hear the state as words. */}
                  {state !== "todo" && (
                    <span className="ac-visually-hidden">{t(`desktop.here.stepState.${state}`)}</span>
                  )}
                </span>
                {state === "failed" && (
                  <span className="dk-fr__stepfail">
                    <span className="dk-honest ac-iconline">
                      <Icon name="alert" size={16} />
                      {step === "account" ? t("desktop.here.fail.account") : t("desktop.here.fail.start")}
                    </span>
                    <span className="dk-fr__stepacts">
                      <CopyDiagnostics />
                      <Button size="sm" variant="primary" icon="refresh" autoFocus onClick={onRetry}>
                        {t("desktop.common.retry")}
                      </Button>
                    </span>
                  </span>
                )}
                {step === "reach" && reachProblem && <ReachProblem problem={reachProblem} text="fail" />}
              </span>
            </li>
          );
        })}
      </ol>
      <div
        className="dk-fr__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-label={t("desktop.here.setting")}
      >
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      {done === steps.length && reachProblem && (
        <div className="dk-fr__end" data-near>
          <Button variant="primary" autoFocus onClick={onContinue}>
            {t("desktop.common.continue")}
          </Button>
        </div>
      )}
    </>
  );
}

/** On Windows, the two ways to run a server for now. */
function WindowsWays({ onBack, onConnect }: { onBack: () => void; onConnect: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <BackLink label={t("desktop.own.title")} onClick={onBack} />
      <h1>{t("desktop.here.win.title")}</h1>
      {INSTALL_COMMAND_LIVE ? (
        <>
          <p className="dk-lead">{t("desktop.here.win.lead")}</p>
          <ol className="dk-fr__ways">
            <li>
              <span className="dk-fr__num">1</span>
              <p>{t("desktop.here.win.other")}</p>
            </li>
            <li>
              <span className="dk-fr__num">2</span>
              <div>
                <p>{t("desktop.here.win.wsl")}</p>
                <CommandCopy command={WSL_INSTALL_COMMAND} />
              </div>
            </li>
          </ol>
        </>
      ) : (
        <p className="dk-lead">{t("desktop.here.win.later")}</p>
      )}
      <div className="dk-fr__end">
        <Button variant="primary" onClick={onConnect}>
          {t("desktop.connect.title")}
        </Button>
      </div>
    </>
  );
}

/** L: a server in large type, asked about before anything changes. */
function LinkSheet({
  view,
  onRetry,
  onAccept,
  onCancel,
}: {
  view: LinkView;
  onRetry: () => void;
  onAccept: (server: string, page?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const server = view.kind === "notALink" ? null : view.server;
  const kind = server ? serverKind(server) : null;
  let body: ReactNode;
  let acts: ReactNode;
  if (view.kind === "notALink") {
    body = <p className="dk-fr__question">{t("desktop.link.notALink")}</p>;
    acts = (
      <Button variant="primary" autoFocus onClick={onCancel}>
        {t("desktop.common.close")}
      </Button>
    );
  } else if (view.kind === "checking" || view.kind === "front") {
    body = (
      <p className="dk-fr__question dk-fr__checking" aria-live="polite">
        <PixelSpinner size={14} color="sky" />
        <span className="dk-shimmer">{t("desktop.link.checking")}</span>
      </p>
    );
    acts = (
      <>
        <Button variant="ghost" onClick={onCancel}>
          {t("desktop.common.cancel")}
        </Button>
        <Button variant="primary" disabled>
          {t("desktop.link.connect")}
        </Button>
      </>
    );
  } else if (view.kind === "problem") {
    body = <ProblemLine problem={view.problem} host={serverName(view.server)} />;
    acts = (
      <>
        <Button variant="ghost" onClick={onCancel}>
          {t("desktop.common.cancel")}
        </Button>
        <Button variant="primary" icon="refresh" autoFocus onClick={onRetry}>
          {t("desktop.common.retry")}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <p className="dk-fr__question">{t(`desktop.link.${view.question}`)}</p>
        {view.leave && <p className="dk-help">{t("desktop.link.leave", { current: view.leave })}</p>}
      </>
    );
    acts = (
      <>
        <Button variant="ghost" onClick={onCancel}>
          {t("desktop.common.cancel")}
        </Button>
        <Button variant="primary" autoFocus onClick={() => onAccept(view.server, view.page)}>
          {t(`desktop.link.${view.button}`)}
        </Button>
      </>
    );
  }
  return (
    <div className="dk-fr__sheet">
      {server && (
        <div className="dk-fr__server">
          <span className="dk-fr__host">{serverName(server)}</span>
          {(kind === "tailnet" || kind === "here") && (
            <Chip icon={kind === "tailnet" ? "globe" : "computer"}>
              {kind === "tailnet" ? t("desktop.link.chipTailnet") : t("desktop.link.chipHere")}
            </Chip>
          )}
        </div>
      )}
      {body}
      <div className="dk-fr__acts">{acts}</div>
    </div>
  );
}
