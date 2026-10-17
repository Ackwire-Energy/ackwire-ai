import { useAuthConfig } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth/context";

/** "Continuar com Google/GitHub", only for providers the server has configured. */
export function SocialButtons({ callbackURL }: { callbackURL: string }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const config = useAuthConfig();
  const providers = config.data?.socialProviders;
  if (!providers || (!providers.google && !providers.github)) return null;
  return (
    <div className="auth__social">
      {providers.google && (
        <Button block onClick={() => void auth.signInSocial("google", callbackURL)}>
          {t("auth.continueWithGoogle")}
        </Button>
      )}
      {providers.github && (
        <Button block onClick={() => void auth.signInSocial("github", callbackURL)}>
          {t("auth.continueWithGithub")}
        </Button>
      )}
    </div>
  );
}

export function useHasSocial() {
  const config = useAuthConfig();
  return Boolean(config.data?.socialProviders.google || config.data?.socialProviders.github);
}
