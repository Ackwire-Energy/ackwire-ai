import { type SignInProvider, useAuthConfig } from "@agenteschat/client";
import { Button, Icon } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";
import { STORAGE_KEYS, storage } from "@/lib/storage";

const BRAND: Record<SignInProvider, ReactNode> = {
  google: (
    <svg className="auth-social__mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.6 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8Z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1-3.7 1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23Z"
      />
      <path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8l3.7-2.8Z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4Z"
      />
    </svg>
  ),
  github: (
    <svg className="auth-social__mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1.5a10.5 10.5 0 0 0-3.3 20.5c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.7.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.1 3.1.9.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.8 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.6 1.4.2 2.5.1 2.8.7.7 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5Z" />
    </svg>
  ),
  apple: (
    <svg className="auth-social__mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.5 1.3 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.5a10 10 0 0 0 1.4-2.8c-.1 0-2.6-1-2.6-4.1ZM13.9 5c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4Z" />
    </svg>
  ),
};

const ORDER: SignInProvider[] = ["google", "github", "apple"];

/** How this browser signed in last (marked "Último usado"). */
export const lastSignIn = () => storage.get(STORAGE_KEYS.lastSignIn);
export const rememberSignIn = (method: SignInProvider | "email") => storage.set(STORAGE_KEYS.lastSignIn, method);

/** The providers the server has configured, or only `only` (an account linked to them). */
export function useSocialProviders(only?: SignInProvider[]): SignInProvider[] {
  const config = useAuthConfig();
  const on = config.data?.socialProviders;
  if (!on) return [];
  return ORDER.filter((p) => on[p] && (!only || only.includes(p)));
}

/**
 * "Continuar com Google/GitHub/Apple": brand mark, the last one used marked.
 * `onSocial` takes over the redirect (the Mac app signs in through the browser).
 */
export function SocialButtons({
  callbackURL,
  providers,
  onSocial,
}: {
  callbackURL: string;
  providers: SignInProvider[];
  onSocial?: (provider: SignInProvider) => void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const last = lastSignIn();
  if (providers.length === 0) return null;
  const label = {
    google: t("auth.continueWithGoogle"),
    github: t("auth.continueWithGithub"),
    apple: t("auth.continueWithApple"),
  };
  return (
    <div className="auth-social">
      {providers.map((p) => (
        <Button
          key={p}
          type="button"
          size="lg"
          block
          className="auth-social__btn"
          onClick={() => {
            rememberSignIn(p);
            if (onSocial) onSocial(p);
            else void auth.signInSocial(p, callbackURL);
          }}
        >
          {BRAND[p]}
          <span className="auth-social__label">{label[p]}</span>
          {last === p && (
            <span className="auth-social__last">
              <Icon name="clock" size={14} />
              {t("auth.lastUsed")}
            </span>
          )}
        </Button>
      ))}
    </div>
  );
}
