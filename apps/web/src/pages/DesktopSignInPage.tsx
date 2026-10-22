import type { SignInProvider } from "@agenteschat/client";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { BROWSER_SIGN_IN_PATH, browserChallenge } from "@/lib/desktop";

/**
 * In the browser, for the Mac app's window (D79): goes to the provider, and
 * when it comes back (`done`), hands the fresh sign-in to the window waiting
 * on `challenge`. The challenge must be the one this tab started with, so a
 * link straight to `done` hands nothing over.
 */
export function DesktopSignInPage({
  provider,
  challenge,
  done,
}: {
  provider?: SignInProvider;
  challenge?: string;
  done: boolean;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const [state, setState] = useState<"opening" | "done" | "expired">("opening");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!provider || !challenge) {
      setState("expired");
      return;
    }
    if (!done) {
      browserChallenge.set(challenge);
      const back = `${BROWSER_SIGN_IN_PATH}?${new URLSearchParams({ provider, challenge, done: "1" })}`;
      void auth.signInSocial(provider, back).then((r) => {
        if (!r.ok) setState("expired");
      });
      return;
    }
    if (browserChallenge.take() !== challenge) {
      setState("expired");
      return;
    }
    void auth.desktopHandoff(challenge).then((r) => setState(r.ok ? "done" : "expired"));
  }, [auth, provider, challenge, done]);

  const name = provider ? t(`auth.provider.${provider}`) : "";
  const [title, lead] =
    state === "done"
      ? [t("auth.desktop.done"), t("auth.desktop.doneLead")]
      : state === "expired"
        ? [t("auth.desktop.expired"), t("auth.desktop.expiredLead", { provider: name })]
        : [t("auth.desktop.opening", { provider: name }), ""];

  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar
            name="agentes.chat"
            size="lg"
            state={state === "opening" ? "writing" : undefined}
            expression={state === "done" ? "happy" : undefined}
          />
          <div className="auth__bubble" key={state} aria-live="polite">
            <h1 className="auth__title">{title}</h1>
            {lead && <p className="auth__lead">{lead}</p>}
          </div>
        </header>
      </div>
    </AuthShell>
  );
}
