import { useCompleteOAuth } from "@agenteschat/client";
import { safeRedirect } from "@agenteschat/client/lib/guards";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { useToast } from "@/lib/toast";

/**
 * In the app's window: a connector's sign-in that the browser handed back, finished with the window's session
 * (`POST …/connectors/oauth/complete`), then on to where it started with `?connected=…` (Conectores says it).
 * Refused at the provider or not finished: Conectores, with why.
 */
export function DesktopConnectorPage({
  org,
  state,
  code,
  error,
}: {
  org?: string;
  state?: string;
  code?: string;
  error?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const complete = useCompleteOAuth(org ?? "");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Replacing this page: the code it carried leaves the history.
    const go = (href: string) => void navigate({ href, replace: true });
    const fail = (reason: string) => {
      toast.show(t("connectors.errorToast", { reason }), "error");
      go(org ? `/org/${encodeURIComponent(org)}/settings/connectors` : "/");
    };
    if (!org || error || !state || !code) return fail(error ?? "missing_code");
    complete.mutate(
      { state, code },
      {
        onSuccess: (done) => {
          const to = safeRedirect(done.returnTo) ?? `/org/${encodeURIComponent(org)}/settings/connectors`;
          go(`${to}${to.includes("?") ? "&" : "?"}connected=${encodeURIComponent(done.connector)}`);
        },
        onError: (failed) => fail(failed instanceof Error ? failed.message : "failed"),
      },
    );
  }, [org, state, code, error, complete, navigate, toast, t]);

  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" state="writing" />
          <div className="auth__bubble" aria-live="polite">
            <h1 className="auth__title">{t("auth.desktop.connecting")}</h1>
          </div>
        </header>
      </div>
    </AuthShell>
  );
}
