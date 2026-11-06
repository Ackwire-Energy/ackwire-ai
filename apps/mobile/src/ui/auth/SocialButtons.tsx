import { type SignInProvider, useAuthConfig } from "@agenteschat/client";
import { jwtEmail } from "@agenteschat/client/lib/text";
import * as AppleAuthentication from "expo-apple-authentication";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { earlyAccessRequests, socialRefusalText, socialReturnText } from "@/features/auth/human-check";
import { authClient } from "@/lib/auth";
import { readValueSync, writeValue } from "@/lib/storage";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { useTheme } from "../theme";
import { OrDivider } from "./AuthLink";
import { SocialMark } from "./SocialMarks";

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
 * "Continue with Apple/Google/GitHub" for the given providers with their marks (as on the web), the last one
 * used marked.
 * On iOS, Apple uses the system button (Apple's rules) and a native sign-in sent to the server as an
 * ID token; the others go through the system browser and back on `agenteschat://`. A refusal there shows on the
 * server's sign-in page in that browser (apps/server auth.ts `onAPIError`).
 */
export function SocialButtons({
  providers,
  divider = true,
  onError,
  callbackURL = "/",
  onSignedIn,
  earlyAccess,
}: {
  providers: SignInProvider[];
  divider?: boolean;
  /** `email`: the address Apple's native sign-in was refused for (its ID token's), which the field may not hold. */
  onError: (message: string, email?: string) => void;
  /** Where the browser's sign-in comes back to: a screen that asked for it again stays open. */
  callbackURL?: string;
  /** Signed in, for a screen that asked for a new sign-in while signed in already. */
  onSignedIn?: () => void;
  /** An early-access link's token, for the sign-up it opens (as the web's). */
  earlyAccess?: string;
}) {
  const { t } = useTranslation();
  const emails = useAuthConfig().data?.passwordReset === true;
  const requests = earlyAccessRequests(earlyAccess);
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
      // A refusal comes back to the app too, so the browser sheet closes on it.
      const res = await authClient().signIn.social({
        ...requests.browser(provider, callbackURL),
        errorCallbackURL: "/",
      });
      const signedIn = !res.error && Boolean((await authClient().getSession()).data);
      const said = socialReturnText(t, res, signedIn, emails);
      if (said) onError(said);
      else onSignedIn?.();
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
      const res = await authClient().signIn.social(requests.apple(credential.identityToken));
      if (res.error) onError(socialRefusalText(t, res.error, emails), jwtEmail(credential.identityToken));
      else onSignedIn?.();
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
            <Button
              variant="secondary"
              wide
              leading={(color) => <SocialMark provider={p} color={color} />}
              label={label[p]}
              disabled={busy}
              onPress={() => void browser(p)}
            />
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "center", marginTop: 2 }}>
      <Icon name="clock" size={12} color={colors.muted} />
      <Text variant="caption" tone="muted">
        {t("auth.lastUsed")}
      </Text>
    </View>
  );
}
