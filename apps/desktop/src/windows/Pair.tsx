/**
 * Pairing this computer from the welcome window, after the person said yes here. `PairOffer`: shown once after
 * sign-in for a workspace this computer doesn't work for yet (the card is the ask, so no system dialog follows).
 * `PairLinkSheet`: a pair link from the web, with who made it and where from, read from its server; Connect starts
 * the runner with the link and waits for its maker to let it in on the web.
 */
import type { DeviceAudience } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Checkbox, Icon, type IconName, PixelSpinner, Select } from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../app";
import { type LinkFailure, type LinkInfo, type PairTarget, pairWithLink, pairWithSession } from "../control/pair";
import { serverName } from "../control/server";
import { OrgTile } from "../ui/bits";
import { PrefCard, PrefRow } from "../ui/settings";
import { PeoplePicker } from "./prefs/ThisMac";

const AUDIENCE_ICON: Record<DeviceAudience["mode"], IconName> = {
  owner: "audienceOwner",
  everyone: "audienceEveryone",
  people: "audiencePeople",
};

/** A sheet of the welcome window's body: a title, what it says, the buttons at the bottom. */
function Sheet({
  lead,
  title,
  children,
  acts,
}: {
  lead?: ReactNode;
  title: string;
  children?: ReactNode;
  acts: ReactNode;
}) {
  return (
    <div className="dk-fr__sheet dk-pair">
      {lead}
      <h1>{title}</h1>
      {children}
      <div className="dk-fr__acts">{acts}</div>
    </div>
  );
}

/** The welcome window around a sheet shown outside the first run. */
const Framed = ({ children }: { children: ReactNode }) => (
  <div className="dk-fr" data-screen="pair">
    <div className="dk-fr__body">{children}</div>
  </div>
);

const Problem = ({ text }: { text: string }) => (
  <span className="dk-honest dk-fr__problem ac-iconline" role="alert">
    <Icon name="alert" size={16} />
    <span>{text}</span>
  </span>
);

const Waiting = ({ text }: { text: string }) => (
  <p className="dk-fr__question dk-fr__checking" aria-live="polite">
    <PixelSpinner size={14} color="sky" />
    <span className="dk-shimmer">{text}</span>
  </p>
);

/** "Let Acme's agents use this Mac?": who may use it, open at login, Not now or Allow. */
export function PairOffer({ target, onClose }: { target: PairTarget; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const [audience, setAudience] = useState<DeviceAudience>({ mode: "owner", userIds: [], roleIds: [] });
  const [picking, setPicking] = useState(false);
  const [atLogin, setAtLogin] = useState(true);
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  const [failed, setFailed] = useState<string | null>(null);
  const org = target.name;
  const lead = <OrgTile logo={target.logo} size="lg" />;

  const allow = async () => {
    setState("busy");
    setFailed(null);
    try {
      await pairWithSession(host, store, target, audience);
      if (atLogin) await host.setAutostart(true).catch(() => {});
      setState("done");
    } catch (err) {
      setFailed(errorText(t, err, i18n.language));
      setState("ask");
    }
  };

  if (state === "done") {
    return (
      <Framed>
        <Sheet
          lead={lead}
          title={t("desktop.pair.done", { org })}
          acts={
            <Button variant="primary" autoFocus onClick={onClose}>
              {t("desktop.common.close")}
            </Button>
          }
        />
      </Framed>
    );
  }
  const busy = state === "busy";
  return (
    <Framed>
      <Sheet
        lead={lead}
        title={t("desktop.pair.offerTitle", { org })}
        acts={
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t("desktop.pair.notNow")}
            </Button>
            {/* Never focused first: it opens by itself after sign-in, while the person may be typing. */}
            <Button variant="primary" loading={busy} onClick={() => void allow()}>
              {t("desktop.pair.allow")}
            </Button>
          </>
        }
      >
        <p className="dk-lead">{t("desktop.pair.offerBody")}</p>
        <PrefCard>
          <PrefRow
            lead={
              <span className="dk-logo">
                <Icon name={AUDIENCE_ICON[audience.mode]} size={16} />
              </span>
            }
            htmlFor="pair-who"
            title={t("desktop.prefs.thisMac.who")}
            end={
              <Select
                id="pair-who"
                size="sm"
                align="end"
                value={audience.mode}
                disabled={busy}
                onValueChange={(mode) => {
                  if (mode === "people") setPicking(true);
                  else setAudience({ mode, userIds: [], roleIds: [] });
                }}
                options={(["owner", "everyone", "people"] as const).map((mode) => ({
                  value: mode,
                  label:
                    mode === "everyone"
                      ? t("desktop.prefs.thisMac.everyone", { org })
                      : t(`desktop.prefs.thisMac.${mode}`),
                  leading: <Icon name={AUDIENCE_ICON[mode]} size={16} />,
                }))}
              />
            }
          />
          <PrefRow
            lead={<Checkbox id="pair-login" checked={atLogin} disabled={busy} onCheckedChange={setAtLogin} />}
            htmlFor="pair-login"
            title={t("desktop.pair.keepReady")}
          />
        </PrefCard>
        {failed && <Problem text={failed} />}
        {picking && (
          <PeoplePicker
            server={target.server}
            orgId={target.orgId}
            ownerUserId={null}
            value={audience.mode === "people" ? audience : { mode: "people", userIds: [], roleIds: [] }}
            saving={false}
            onCancel={() => setPicking(false)}
            onSave={(next) => {
              setAudience(next);
              setPicking(false);
            }}
          />
        )}
      </Sheet>
    </Framed>
  );
}

type LinkState =
  | { kind: "checking" }
  | { kind: "expired" }
  | { kind: "unreachable" }
  | { kind: "ask"; info: LinkInfo }
  | { kind: "waiting"; info: LinkInfo }
  | { kind: "done"; org: string }
  | { kind: "failed"; info: LinkInfo; code: LinkFailure };

const isFailure = (code: string): code is LinkFailure =>
  ["expired", "denied", "network", "internal", "link_invalid"].includes(code);

/** "Connect this Mac to Acme?": asked by, from, this Mac; Connect waits for the link's maker. */
export function PairLinkSheet({ server, code, onClose }: { server: string; code: string; onClose: () => void }) {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const [state, setState] = useState<LinkState>({ kind: "checking" });
  const [asked, setAsked] = useState(0);
  const from = serverName(server);
  // The sheet gone (Cancel, Esc, a newer link): the runner stops asking, even if it hadn't started yet.
  const pairing = useRef<{ cancel: () => Promise<void> } | null>(null);
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      void pairing.current?.cancel();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is Try again
  useEffect(() => {
    let live = true;
    setState({ kind: "checking" });
    host
      .pairLinkInfo(server, code)
      .then((info) => live && setState({ kind: "ask", info }))
      .catch((err: unknown) => live && setState({ kind: err === "link_expired" ? "expired" : "unreachable" }));
    return () => {
      live = false;
    };
  }, [host, server, code, asked]);

  const connect = async (info: LinkInfo) => {
    setState({ kind: "waiting", info });
    try {
      const started = await pairWithLink(store, server, code);
      pairing.current = started;
      if (gone.current) return void started.cancel();
      const org = await started.done;
      pairing.current = null;
      // Agents of a computer paired here work while the app runs.
      await host.setAutostart(true).catch(() => {});
      if (!gone.current) setState({ kind: "done", org });
    } catch (err) {
      pairing.current = null;
      const word = err instanceof Error ? err.message : "";
      if (gone.current || word === "canceled") return;
      setState({ kind: "failed", info, code: isFailure(word) ? word : "internal" });
    }
  };

  const close = (
    <Button variant="primary" autoFocus onClick={onClose}>
      {t("desktop.common.close")}
    </Button>
  );
  if (state.kind === "checking")
    return (
      <Sheet
        title={from}
        acts={
          <Button variant="ghost" onClick={onClose}>
            {t("desktop.common.cancel")}
          </Button>
        }
      >
        <Waiting text={t("desktop.link.checking")} />
      </Sheet>
    );
  if (state.kind === "expired")
    return (
      <Sheet title={from} acts={close}>
        <Problem text={t("desktop.pair.expired")} />
      </Sheet>
    );
  if (state.kind === "unreachable")
    return (
      <Sheet
        title={from}
        acts={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("desktop.common.cancel")}
            </Button>
            <Button variant="primary" icon="refresh" autoFocus onClick={() => setAsked((n) => n + 1)}>
              {t("desktop.common.retry")}
            </Button>
          </>
        }
      >
        <Problem text={t("desktop.prefs.thisMac.unreachable", { server: from })} />
      </Sheet>
    );
  if (state.kind === "done") return <Sheet title={t("desktop.pair.done", { org: state.org })} acts={close} />;

  const { info } = state;
  const computer = info.computer ?? snap.homes.find((h) => h.status?.machine)?.status?.machine?.name;
  const facts = (
    <PrefCard>
      <PrefRow title={t("desktop.pair.askedBy")} end={info.by} />
      <PrefRow title={t("desktop.pair.from")} end={from} />
      {computer && <PrefRow title={t("desktop.prefs.general.thisMac")} end={computer} />}
    </PrefCard>
  );
  const title = t("desktop.pair.linkTitle", { org: info.org });
  if (state.kind === "waiting")
    return (
      <Sheet
        title={title}
        acts={
          <Button variant="ghost" onClick={onClose}>
            {t("desktop.common.cancel")}
          </Button>
        }
      >
        {facts}
        <Waiting text={t("desktop.pair.waiting", { by: info.by })} />
      </Sheet>
    );
  if (state.kind === "failed") {
    const again = state.code === "network" || state.code === "internal";
    const text =
      state.code === "denied"
        ? t("desktop.pair.denied", { by: info.by })
        : state.code === "network"
          ? t("desktop.prefs.thisMac.unreachable", { server: from })
          : state.code === "internal"
            ? t("desktop.common.error")
            : t("desktop.pair.expired");
    return (
      <Sheet
        title={title}
        acts={
          again ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t("desktop.pair.notNow")}
              </Button>
              <Button variant="primary" icon="refresh" autoFocus onClick={() => void connect(info)}>
                {t("desktop.common.retry")}
              </Button>
            </>
          ) : (
            close
          )
        }
      >
        {facts}
        <Problem text={text} />
      </Sheet>
    );
  }
  return (
    <Sheet
      title={title}
      acts={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("desktop.pair.notNow")}
          </Button>
          {/* Never focused first: a page can open this link while the person types elsewhere, and Enter isn't a yes. */}
          <Button variant="primary" onClick={() => void connect(info)}>
            {t("desktop.link.connect")}
          </Button>
        </>
      }
    >
      {facts}
      <p className="dk-lead">{t("desktop.pair.linkBody", { org: info.org })}</p>
    </Sheet>
  );
}
