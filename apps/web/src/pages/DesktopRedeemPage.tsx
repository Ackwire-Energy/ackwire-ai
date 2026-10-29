import { Button } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { SIGNED_IN_PATH, windowVerifier } from "@/lib/desktop";

/**
 * In the Mac app's window, opened by the app with the one-time code the browser handed it
 * (`agenteschat://desktop/sign-in`, deep_link.rs; ADR 0036): redeemed with the verifier this window kept when it
 * sent the person to the browser. A code with no verifier here (someone else's sign-in link) signs nobody in.
 * Signed in: a full load, so everything starts signed in.
 */
export function DesktopRedeemPage({ code }: { code: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const kept = windowVerifier.take();
    if (!kept) {
      setFailed(true);
      return;
    }
    void auth
      .desktopRedeem(code, kept.verifier)
      .catch(() => false)
      .then((signedIn) => {
        if (signedIn) window.location.replace(`${SIGNED_IN_PATH}?${new URLSearchParams({ to: kept.to })}`);
        else setFailed(true);
      });
  }, [auth, code]);

  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" state={failed ? undefined : "writing"} />
          <div className="auth__bubble" key={String(failed)} aria-live="polite">
            <h1 className="auth__title">{failed ? t("auth.desktop.expired") : t("auth.desktop.signingIn")}</h1>
            {failed && <p className="auth__lead">{t("auth.desktop.signInAgainLead")}</p>}
          </div>
        </header>
        {failed && (
          <Button type="button" size="lg" block onClick={() => window.location.replace("/login")}>
            {t("auth.desktop.signInAgain")}
          </Button>
        )}
      </div>
    </AuthShell>
  );
}
