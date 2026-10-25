/**
 * The server here's own controls, shared by the first run, Preferences and the popover: reach through
 * Tailscale by what Tailscale is doing on this computer, why reach didn't turn on, and "Copy diagnostics".
 */
import { Button, Icon, Switch } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useHost } from "../app";
import { REASON_TEXT, type ServeProblem, type Tailnet } from "../control/local-server";
import { useToast } from "./Toast";

/** "Reach it from your phone and teammates": by what Tailscale is doing on this computer. */
export function ReachRow({
  tailnet,
  on,
  onChange,
  busy,
}: {
  tailnet: Tailnet;
  on: boolean;
  onChange: (on: boolean) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const host = useHost();
  const usable = tailnet.state === "on" || on;
  return (
    <div className="dk-crow" data-top>
      <span className="dk-crow__text">
        <label htmlFor="here-reach" className="dk-crow__title">
          {t("desktop.here.reach")}
        </label>
        <small>
          <span>
            {tailnet.state === "on" || on
              ? t("desktop.here.reachText")
              : tailnet.state === "off"
                ? t("desktop.here.reachOff")
                : t("desktop.here.reachMissing")}
            {!usable && (tailnet.state === "missing" || host.platform === "mac") && (
              <>
                {" "}
                <button
                  type="button"
                  className="dk-link"
                  onClick={() =>
                    void host.openTailscale(tailnet.state === "missing" ? "download" : "app").catch(() => {})
                  }
                >
                  {tailnet.state === "missing" ? t("desktop.here.getTailscale") : t("desktop.here.openTailscale")}
                </button>
              </>
            )}
          </span>
        </small>
      </span>
      <span className="dk-crow__end">
        <Switch id="here-reach" checked={on} disabled={!usable || busy} onCheckedChange={onChange} />
      </span>
    </div>
  );
}

/** Why reach didn't turn on, with "Turn it on" where the tailnet's admin page fixes it. */
export function ReachProblem({ problem, text }: { problem: ServeProblem; text: "fail" | "prefs" }) {
  const { t } = useTranslation();
  const host = useHost();
  const reason = t(REASON_TEXT[problem.reason]);
  return (
    <span className="dk-honest dk-fr__problem" role="alert">
      <Icon name="alert" size={16} />
      <span>
        {text === "fail" ? t("desktop.here.fail.reach", { reason }) : t("desktop.server.reachFailed", { reason })}
        {problem.reason === "https" && (
          <>
            {" "}
            <button type="button" className="dk-link" onClick={() => void host.openTailscale("https").catch(() => {})}>
              {t("desktop.here.turnOn")}
            </button>
          </>
        )}
      </span>
    </span>
  );
}

/** Copies what the app knows about the server here (versions, its state, the end of its log). */
export function CopyDiagnostics({ size = "sm" }: { size?: "sm" | "md" }) {
  const { t } = useTranslation();
  const host = useHost();
  const toast = useToast();
  return (
    <Button
      size={size}
      icon="copy"
      onClick={() =>
        void host
          .localDiagnostics()
          .then((text) => navigator.clipboard.writeText(text))
          .then(() => toast(t("desktop.common.copied"), "check"))
          .catch(() => toast(t("desktop.common.error"), "alert"))
      }
    >
      {t("desktop.here.copyDiagnostics")}
    </Button>
  );
}
