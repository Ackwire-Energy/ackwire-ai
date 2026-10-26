import { type SignInProvider, useAuthConfig } from "@agenteschat/client";
import * as AppleAuthentication from "expo-apple-authentication";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { authClient } from "@/lib/auth";
import { readValueSync, writeValue } from "@/lib/storage";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { useTheme } from "../theme";
import { OrDivider } from "./AuthLink";

const ORDER: SignInProvider[] = ["apple", "google", "github"];

/**
 * How this phone signed in last ("Último usado"). Kept out of `STORED` on purpose: signing out clears
 * those, and this one is for the next sign-in.
 */
const LAST_SIGN_IN = "last-sign-in";
export const rememberSignIn = (method: SignInProvider | "email") => void writeValue(LAST_SIGN_IN, method);

/** The providers the server has configured, or only `only` (the ones an account is linked to). */
export function useSocialProviders(only?: SignInProvider[]): SignInProvider[] {
  const config = useAuthConfig();
  const on = config.data?.socialProviders as Partial<Record<SignInProvider, boolean>> | undefined;
  if (!on) return [];
  return ORDER.filter((p) => on[p] === true && (!only || only.includes(p)));
}

/**
 * "Continue with Apple/Google/GitHub" for the given providers, the last one used marked.
 * On iOS, Apple uses the system button (Apple's rules) and a native sign-in sent to the server as an
 * ID token; the others go through the system browser and back on `agenteschat://`.
 */
export function SocialButtons({
  providers,
  divider = true,
  onError,
}: {
  providers: SignInProvider[];
  divider?: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const [nativeApple, setNativeApple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last] = useState(() => readValueSync(LAST_SIGN_IN));

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    AppleAuthentication.isAvailableAsync()
      .then(setNativeApple)
      .catch(() => setNativeApple(false));
  }, []);

  if (providers.length === 0) return null;

  const browser = async (provider: SignInProvider) => {
    setBusy(true);
    rememberSignIn(provider);
    try {
      const res = await authClient().signIn.social({ provider, callbackURL: "/" });
      if (res.error) onError(t("mobile.auth.social.failed"));
    } catch {
      onError(t("mobile.auth.errors.network"));
    } finally {
      setBusy(false);
    }
  };

  const appleNative = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) return onError(t("mobile.auth.social.failed"));
      setBusy(true);
      rememberSignIn("apple");
      const res = await authClient().signIn.social({
        provider: "apple",
        idToken: { token: credential.identityToken },
      });
      if (res.error) onError(t("mobile.auth.social.failed"));
    } catch (e) {
      // Closing Apple's sheet is not an error.
      if ((e as { code?: string })?.code !== "ERR_REQUEST_CANCELED") onError(t("mobile.auth.social.failed"));
    } finally {
      setBusy(false);
    }
  };

  const label: Record<SignInProvider, string> = {
    google: t("auth.continueWithGoogle"),
    github: t("auth.continueWithGithub"),
    apple: t("auth.continueWithApple"),
  };

  return (
    <View style={{ gap: 10 }}>
      {divider ? <OrDivider label={t("mobile.common.or")} /> : null}
      {providers.map((p) => (
        <View key={p}>
          {p === "apple" && nativeApple ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={
                scheme === "dark"
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={15}
              style={{ height: 48, alignSelf: "stretch" }}
              onPress={() => void appleNative()}
            />
          ) : (
            <Button variant="secondary" wide label={label[p]} disabled={busy} onPress={() => void browser(p)} />
          )}
          {last === p ? <LastUsed /> : null}
        </View>
      ))}
    </View>
  );
}

/** "Último usado": a quiet line under the button this phone used last. */
function LastUsed() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "center", marginTop: 6 }}>
      <Icon name="clock" size={14} color={colors.muted} />
      <Text variant="caption" tone="muted">
        {t("auth.lastUsed")}
      </Text>
    </View>
  );
}
