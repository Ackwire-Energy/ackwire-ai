/**
 * First run and "Adicionar organização": sign in with a code the
 * computer shows and the person confirms in the browser (ADR 0036 §5), then, the first time only,
 * folders, tools and "open when the Mac starts". One simple question per screen. Also "Reconectar
 * este Mac" from the popover: the same code screen on the refused organization's home, which comes
 * back as the same computer (its agents and permissions). The sign-in goes to agentes.chat or to the
 * team's own server ("Seu servidor": its address, checked before it is used).
 */

import type { RunnerTools } from "@agenteschat/adapters/machine-protocol";
import type { ControlEvent, ControlStatus } from "@agenteschat/adapters/runner-control";
import {
  CLOUD_SERVER,
  checkServer,
  normalizeServer,
  type ServerProblem,
  serverHost,
} from "@agenteschat/client/lib/server";
import { Button, Chip, glowTones, Icon, Input, PixelSky, PixelSpinner, type SkyOptions, Switch } from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../app";
import { ControlError } from "../control/client";
import { SERVER_PREF, siteOf } from "../control/server";
import { type Home, orgName, pairedHomes, RECONNECT_PREF, reconnectTarget } from "../control/store";
import { chosenServer, readPref, useOnShown, writePref } from "../hooks";
import { BrandFace, CodeDigits, MacPortrait } from "../ui/bits";
import { useToast } from "../ui/Toast";
import { baseName, listNames, shortPath } from "../ui/time";

type Step = "hello" | "server" | "code" | "folders" | "tools" | "done";
type Failure = Extract<ControlEvent, { kind: "pair.failed" }>["code"];

const STEP_INDEX: Record<Step, number> = { hello: 0, server: 0, code: 1, folders: 2, tools: 3, done: 4 };

/** Why a server can't be used (`desktop.welcome.*`, each takes `{ host }`). */
const PROBLEM_TEXT: Record<ServerProblem, string> = {
  unreachable: "desktop.welcome.serverUnreachable",
  certificate: "desktop.welcome.serverCertificate",
  "not-agentes": "desktop.welcome.serverNotAgentes",
  "server-too-old": "desktop.welcome.serverTooOld",
  "app-too-old": "desktop.welcome.serverAppTooOld",
};

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

export function Welcome() {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const [step, setStep] = useState<Step>("hello");
  /**
   * "org": connecting one more organization (no folders/tools steps); "reconnect": an organization
   * that refused this Mac, on its own home. Fixed when the flow starts.
   */
  const [mode, setMode] = useState<"first" | "org" | "reconnect">("first");
  /** "reconnect": the home and its organization's name. */
  const [target, setTarget] = useState<{ homeId: string; org: string } | null>(null);
  const [homeId, setHomeId] = useState<string | null>(null);
  const [code, setCode] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [tools, setTools] = useState<RunnerTools>({ claude: false, codex: false, commands: false });
  const [launch, setLaunch] = useState(true);
  const opened = useRef<string | null>(null);
  /** Where the sign-in goes ("Seu servidor"), and that screen's address, answer and way back. */
  const [server, setServer] = useState(chosenServer);
  const [address, setAddress] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [serverBack, setServerBack] = useState<Step>("hello");

  // The shell opens only the pages of known servers: this one too, from now on.
  useEffect(() => {
    void host.setServer(server).catch(() => {});
  }, [host, server]);

  const others = pairedHomes(snap).filter((h) => h.homeId !== homeId);
  const home: Home | undefined = homeId ? snap.homes.find((h) => h.homeId === homeId) : undefined;
  const executors: ControlStatus["executors"] = home?.status?.executors ?? {};

  const reset = () => {
    const snapshot = store.getSnapshot();
    const paired = pairedHomes(snapshot);
    const again = reconnectTarget(snapshot, readPref<string | null>(RECONNECT_PREF, null));
    writePref(RECONNECT_PREF, null);
    setTarget(again ? { homeId: again.homeId, org: orgName(again) } : null);
    setMode(again ? "reconnect" : paired.length > 0 ? "org" : "first");
    setStep(again || paired.length > 0 ? "code" : "hello");
    setHomeId(null);
    setCode(null);
    setFailure(null);
    setFolders([]);
    opened.current = null;
  };

  // Brought up again (from the popover or Preferences): start over unless a sign-in is under way
  // ("Reconectar este Mac" always starts over).
  useOnShown("welcome", () => {
    const reconnecting = readPref<string | null>(RECONNECT_PREF, null) !== null;
    if (reconnecting && step === "code" && homeId && mode !== "first") {
      void store.request(homeId, { type: "pair.cancel" }).catch(() => {});
      if (mode === "org") void store.removeHome(homeId).catch(() => {});
    } else if (step === "code" && homeId && !failure) return;
    if (step === "folders" || step === "tools") return;
    reset();
  });

  // In "org" mode the code screen is the first one: start right away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once per flow
  useEffect(() => {
    if (step === "code" && !homeId && !failure) void startPairing();
  }, [step, homeId, failure]);

  // Progress of the sign-in. The handler is read through a ref: events can arrive before the next render.
  const homeRef = useRef<string | null>(null);
  homeRef.current = homeId;
  const onEventRef = useRef<(id: string, event: ControlEvent) => void>(() => {});
  onEventRef.current = (id, event) => {
    if (id !== homeRef.current) return;
    if (event.kind === "pair.code") {
      setCode({ userCode: event.userCode, verificationUrl: event.verificationUrl });
      setFailure(null);
      // Open the browser once per code; "Abrir de novo" opens it again.
      if (opened.current !== event.userCode) {
        opened.current = event.userCode;
        void host.openExternal(event.verificationUrl).catch(() => {});
      }
    } else if (event.kind === "pair.done") {
      void afterPaired(id, event.org.name);
    } else if (event.kind === "pair.failed") {
      setFailure(event.code);
    }
  };
  useEffect(() => store.onEvent((id, event) => onEventRef.current(id, event)), [store]);

  async function startPairing() {
    setFailure(null);
    setCode(null);
    try {
      // Reconnect: the refused organization's own home (its runner sends the machine it was).
      // Else reuse a home left unpaired by an earlier attempt, or a new one.
      // A home whose runner never answered counts too: retrying must not leave empty homes behind.
      const spare = store.getSnapshot().homes.find((h) => !h.status?.paired);
      const id = mode === "reconnect" && target ? target.homeId : (spare?.homeId ?? (await store.addHome()));
      homeRef.current = id;
      setHomeId(id);
      // Reconnecting goes back to that organization's own server.
      const own = mode === "reconnect" ? store.home(id)?.status?.server : undefined;
      await store.request(id, { type: "pair.start", server: own ?? server });
    } catch (err) {
      // Connected again meanwhile (another flow): nothing to do here.
      if (err instanceof ControlError && err.code === "already_paired") {
        if (mode === "reconnect") void host.hideWindow("welcome").catch(() => {});
        return;
      }
      setFailure("internal");
    }
  }

  async function afterPaired(id: string, org: string) {
    toast(t("desktop.welcome.connected", { org }));
    await store.refresh(id);
    if (mode === "reconnect") {
      setStep("done");
      return;
    }
    if (mode === "org") {
      // Tools are for the whole computer: the new organization gets what the others have.
      const base = pairedHomes(store.getSnapshot()).find((h) => h.homeId !== id)?.access?.tools;
      if (base) {
        for (const tool of ["claude", "codex", "commands"] as const) {
          await store.request(id, { type: "tools.set", tool, on: base[tool] }).catch(() => {});
        }
      }
      setStep("done");
      return;
    }
    const status = store.home(id)?.status;
    setTools({ claude: !!status?.executors.claude, codex: !!status?.executors.codex, commands: false });
    setStep("folders");
  }

  async function cancel() {
    if (homeId) await store.request(homeId, { type: "pair.cancel" }).catch(() => {});
    if (mode === "org" || mode === "reconnect") {
      // A refused home stays as it was (Preferências can still remove it).
      if (homeId && mode === "org") await store.removeHome(homeId).catch(() => {});
      reset();
      void host.hideWindow("welcome").catch(() => {});
      return;
    }
    setHomeId(null);
    setCode(null);
    setFailure(null);
    setStep("hello");
  }

  /** "Trocar": the server screen, then back where it was opened (a sign-in under way starts over there). */
  async function openServer() {
    if (homeId) await store.request(homeId, { type: "pair.cancel" }).catch(() => {});
    setHomeId(null);
    setCode(null);
    setFailure(null);
    opened.current = null;
    setAddress(server === CLOUD_SERVER ? "" : serverHost(server));
    setServerError(null);
    setServerBack(step);
    setStep("server");
  }

  function chooseServer(next: string) {
    writePref(SERVER_PREF, next === CLOUD_SERVER ? null : next);
    setServer(next);
    setStep(serverBack);
  }

  /** The address typed: checked before anything changes. */
  async function submitAddress() {
    const typed = normalizeServer(address);
    if (!typed) return setServerError(t("desktop.welcome.serverInvalid"));
    setChecking(true);
    setServerError(null);
    const check = await checkServer(typed);
    setChecking(false);
    if (check.ok) return chooseServer(check.server);
    setServerError(t(PROBLEM_TEXT[check.problem], { host: serverHost(typed) }));
  }

  async function addFolder() {
    if (!homeId) return;
    const path = await host.pickFolder().catch(() => null);
    if (!path) return;
    try {
      await store.request(homeId, { type: "folders.add", path, agents: [] });
      setFolders((f) => (f.includes(path) ? f : [...f, path]));
    } catch (err) {
      toast(
        err instanceof ControlError && err.code === "invalid_path"
          ? t("desktop.prefs.folders.invalid")
          : t("desktop.common.error"),
        "alert",
      );
    }
  }

  async function saveTools() {
    if (!homeId) return;
    for (const tool of ["claude", "codex", "commands"] as const) {
      await store.request(homeId, { type: "tools.set", tool, on: tools[tool] }).catch(() => {});
    }
    host
      .autostart()
      .then(setLaunch)
      .catch(() => {});
    setStep("done");
  }

  async function finish() {
    await host.setAutostart(launch).catch(() => {});
    reset();
    await host.hideWindow("welcome").catch(() => {});
    await host.showWindow("popover").catch(() => {});
  }

  const idx = STEP_INDEX[step];
  const steps =
    mode === "first" && idx > 0 ? (
      <div className="dk-steps" role="img" aria-label={t("desktop.welcome.stepOf", { n: idx })}>
        {[1, 2, 3, 4].map((i) => (
          <i key={i} data-on={i <= idx || undefined} />
        ))}
      </div>
    ) : null;

  let body: ReactNode = null;
  let foot: ReactNode = null;
  // The server this sign-in goes to: a reconnect goes back to that organization's own.
  const pairingHost = serverHost((mode === "reconnect" ? home?.status?.server : undefined) ?? server);
  const serverLine = (
    <span className="dk-help dk-server-line">
      {t("desktop.welcome.serverLine", { host: serverHost(server) })} ·{" "}
      <button type="button" className="dk-link" onClick={() => void openServer()}>
        {t("desktop.welcome.serverChange")}
      </button>
    </span>
  );

  if (step === "hello") {
    body = (
      <div className="dk-hello">
        <span className="dk-hello__mark">
          <MacPortrait state="online" size={144} />
        </span>
        <h1>{t("desktop.welcome.helloTitle")}</h1>
        <p className="dk-lead">{t("desktop.welcome.helloLead")}</p>
        <div className="dk-hello__acts">
          <Button
            variant="primary"
            className="dk-btn-lg"
            onClick={() => {
              setStep("code");
            }}
          >
            {t("desktop.welcome.signIn", { host: serverHost(server) })}
            <Icon name="arrowRight" size={16} />
          </Button>
          <span className="dk-help">
            {t("desktop.welcome.noAccount")}{" "}
            <button type="button" className="dk-link" onClick={() => void host.openExternal(server)}>
              {t("desktop.welcome.createAccount", { host: serverHost(server) })}
            </button>
          </span>
        </div>
        {serverLine}
      </div>
    );
  } else if (step === "server") {
    body = (
      <>
        <h1>{t("desktop.welcome.serverTitle")}</h1>
        <p className="dk-lead">{t("desktop.welcome.serverLead")}</p>
        <form
          className="dk-server-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitAddress();
          }}
        >
          <Input
            autoFocus
            value={address}
            placeholder={t("desktop.welcome.serverPlaceholder")}
            aria-label={t("desktop.welcome.serverLabel")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            invalid={serverError !== null}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        {serverError && (
          <span className="dk-honest dk-server-error">
            <Icon name="alert" size={16} />
            <span>{serverError}</span>
          </span>
        )}
      </>
    );
    foot = (
      <>
        <span className="dk-help dk-foot__note">
          {server !== CLOUD_SERVER && (
            <button type="button" className="dk-link" onClick={() => chooseServer(CLOUD_SERVER)}>
              {t("desktop.welcome.serverBackTo", { host: serverHost(CLOUD_SERVER) })}
            </button>
          )}
        </span>
        <Button variant="ghost" onClick={() => setStep(serverBack)}>
          {t("desktop.common.back")}
        </Button>
        <Button
          variant="primary"
          loading={checking}
          disabled={checking || !address.trim()}
          onClick={() => void submitAddress()}
        >
          {t("desktop.welcome.serverUse")}
        </Button>
      </>
    );
  } else if (step === "code") {
    const failText = failure
      ? t(
          failure === "expired"
            ? "desktop.welcome.failedExpired"
            : failure === "denied"
              ? "desktop.welcome.failedDenied"
              : failure === "network"
                ? "desktop.welcome.failedNetwork"
                : "desktop.welcome.failedInternal",
          { host: pairingHost },
        )
      : null;
    body = (
      <>
        {steps}
        <h1>
          {mode === "reconnect"
            ? t("desktop.welcome.reconnectTitle", { org: target?.org ?? "" })
            : mode === "org"
              ? t("desktop.welcome.orgTitle")
              : t("desktop.welcome.codeTitle")}
        </h1>
        <p className="dk-lead">
          {!code
            ? t("desktop.welcome.codeLeadPreparing")
            : mode === "reconnect"
              ? t("desktop.welcome.reconnectLead", { host: pairingHost })
              : mode === "org"
                ? t("desktop.welcome.orgLead", { host: pairingHost })
                : t("desktop.welcome.codeLead", { host: pairingHost })}
        </p>
        <div className="dk-codebox">
          {code ? <CodeDigits code={code.userCode} /> : <span className="dk-code dk-code--empty">···&nbsp;···</span>}
        </div>
        {failText ? (
          <div className="dk-fail">
            <span className="dk-honest">
              <Icon name="alert" size={16} />
              <span>{failText}</span>
            </span>
            <Button size="sm" onClick={() => void startPairing()}>
              {t("desktop.welcome.newCode")}
            </Button>
          </div>
        ) : (
          <p className="dk-waitline">
            <PixelSpinner size={14} color="sky" />
            <span className="dk-shimmer">{code ? t("desktop.welcome.waiting") : t("desktop.welcome.preparing")}</span>
          </p>
        )}
        {mode === "org" && serverLine}
        {mode === "org" && others.length > 0 && (
          <div className="dk-note">
            <Icon name="info" size={16} />
            <span>
              {t("desktop.welcome.orgAlready", {
                orgs: listNames(
                  others.map((h) => orgName(h)),
                  i18n.language,
                ),
              })}
            </span>
          </div>
        )}
      </>
    );
    foot = (
      <>
        <span className="dk-help dk-foot__note">
          {code && (
            <>
              {t("desktop.welcome.notOpened")}{" "}
              <button type="button" className="dk-link" onClick={() => void host.openExternal(code.verificationUrl)}>
                {t("desktop.welcome.openAgain")}
              </button>
            </>
          )}
        </span>
        <Button variant="ghost" onClick={() => void cancel()}>
          {mode === "first" ? t("desktop.common.back") : t("desktop.common.cancel")}
        </Button>
      </>
    );
  } else if (step === "folders") {
    body = (
      <>
        {steps}
        <h1>{t("desktop.welcome.foldersTitle")}</h1>
        <p className="dk-lead">{t("desktop.welcome.foldersLead")}</p>
        <div className="dk-picklist">
          {folders.map((p) => (
            <div key={p} className="dk-pick">
              <span className="dk-logo dk-logo--soft">
                <Icon name="drive" size={16} />
              </span>
              <span className="dk-pick__text">
                <b>{baseName(p)}</b>
                <span className="dk-path">{shortPath(p)}</span>
              </span>
              <Icon name="check" size={16} />
            </div>
          ))}
          <button type="button" className="dk-pick dk-pick--add" onClick={() => void addFolder()}>
            <span className="dk-logo dk-logo--soft">
              <Icon name="plus" size={16} />
            </span>
            <span className="dk-pick__text">
              <b>{t("desktop.welcome.chooseFolder")}</b>
            </span>
          </button>
        </div>
        {folders.length > 0 && <p className="dk-help dk-under">{t("desktop.welcome.foldersAgentsNote")}</p>}
      </>
    );
    foot = (
      <>
        <span className="dk-help dk-foot__note">
          {folders.length
            ? t("desktop.welcome.foldersCount", { count: folders.length })
            : t("desktop.welcome.foldersNone")}
        </span>
        {folders.length === 0 && (
          <Button variant="ghost" onClick={() => setStep("tools")}>
            {t("desktop.common.skip")}
          </Button>
        )}
        <Button variant="primary" onClick={() => setStep("tools")}>
          {t("desktop.common.continue")}
        </Button>
      </>
    );
  } else if (step === "tools") {
    body = (
      <>
        {steps}
        <h1>{t("desktop.welcome.toolsTitle")}</h1>
        <p className="dk-lead">{t("desktop.welcome.toolsLead")}</p>
        <div className="dk-picklist dk-picklist--tools">
          <ToolRow
            id="claude"
            icon="executorClaude"
            name={t("desktop.tools.claudeName")}
            desc={executors.claude ? t("desktop.tools.claudeDesc") : t("desktop.tools.notInstalled")}
            found={!!executors.claude}
            on={tools.claude}
            onChange={(on) => setTools((x) => ({ ...x, claude: on }))}
          />
          <ToolRow
            id="codex"
            icon="executorCodex"
            name={t("desktop.tools.codexName")}
            desc={executors.codex ? t("desktop.tools.codexDesc") : t("desktop.tools.notInstalled")}
            found={!!executors.codex}
            on={tools.codex}
            onChange={(on) => setTools((x) => ({ ...x, codex: on }))}
          />
          <ToolRow
            id="commands"
            icon="code"
            name={t("desktop.tools.commandsName")}
            desc={t("desktop.tools.commandsDesc")}
            on={tools.commands}
            onChange={(on) => setTools((x) => ({ ...x, commands: on }))}
            warning={tools.commands ? t("desktop.tools.commandsWarn") : undefined}
          />
        </div>
      </>
    );
    foot = (
      <>
        <span className="dk-foot__note" />
        <Button variant="ghost" onClick={() => setStep("folders")}>
          {t("desktop.common.back")}
        </Button>
        <Button variant="primary" onClick={() => void saveTools()}>
          {t("desktop.common.continue")}
        </Button>
      </>
    );
  } else {
    const count = pairedHomes(snap).length;
    body = (
      <>
        {steps}
        <span className="dk-done__mark">
          <MacPortrait state="online" size={96} />
        </span>
        <h1>
          {mode === "reconnect"
            ? t("desktop.welcome.reconnectDone", { org: target?.org ?? "" })
            : mode === "org"
              ? t("desktop.welcome.orgDone", { count })
              : t("desktop.welcome.doneTitle")}
        </h1>
        <p className="dk-lead">{t("desktop.welcome.doneLead")}</p>
        <div className="dk-mini" aria-hidden="true">
          <div className="dk-mini__bar">
            <span className="dk-mini__icon">
              <BrandFace size="xs" />
            </span>
          </div>
          <span className="dk-mini__arrow">
            <Icon name="arrowUp" size={18} />
            agentes
          </span>
        </div>
        {mode === "first" && (
          <div className="dk-picklist dk-picklist--tools">
            <div className="dk-tl">
              <span className="dk-tl__text">
                <label htmlFor="launch">
                  <b>{t("desktop.welcome.launchTitle")}</b>
                </label>
                <small>{t("desktop.welcome.launchDesc")}</small>
              </span>
              <Switch id="launch" checked={launch} onCheckedChange={setLaunch} />
            </div>
          </div>
        )}
      </>
    );
    const site = siteOf(home ? [home] : [], server);
    foot = (
      <>
        <span className="dk-foot__note" />
        <Button icon="external" onClick={() => void host.openExternal(site)}>
          {t("desktop.tray.openSite", { host: serverHost(site) })}
        </Button>
        <Button variant="primary" onClick={() => void finish()}>
          {t("desktop.welcome.finish")}
        </Button>
      </>
    );
  }

  return (
    <div className="dk-wel">
      <div className="dk-wel__body" key={step}>
        {body}
      </div>
      {foot && <div className="dk-wel__foot">{foot}</div>}
      {step === "hello" && (
        <span className="dk-wel__horizon" aria-hidden="true">
          <PixelSky options={HORIZON} />
        </span>
      )}
    </div>
  );
}

function ToolRow({
  id,
  icon,
  name,
  desc,
  found,
  on,
  onChange,
  warning,
}: {
  id: string;
  icon: "executorClaude" | "executorCodex" | "code";
  name: string;
  desc: string;
  /** Claude Code / Codex: whether it is installed here (absent for Comandos). */
  found?: boolean;
  on: boolean;
  onChange: (on: boolean) => void;
  warning?: string;
}) {
  const { t } = useTranslation();
  const missing = found === false;
  return (
    <div className="dk-tl">
      <span className="dk-logo">
        <Icon name={icon} size={16} />
      </span>
      <span className="dk-tl__text">
        <label htmlFor={`tool-${id}`}>
          <b>
            {name}
            {found !== undefined &&
              (found ? (
                <Chip icon="check" tone="done">
                  {t("desktop.tools.found")}
                </Chip>
              ) : (
                <Chip icon="dash">{t("desktop.tools.notFound")}</Chip>
              ))}
          </b>
        </label>
        <small>{desc}</small>
        {warning && (
          <span className="dk-honest">
            <Icon name="alert" size={14} />
            <span>{warning}</span>
          </span>
        )}
      </span>
      <Switch id={`tool-${id}`} checked={on && !missing} disabled={missing} onCheckedChange={onChange} />
    </div>
  );
}
