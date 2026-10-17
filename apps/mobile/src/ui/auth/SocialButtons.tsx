import { useAuthConfig } from "@agenteschat/client";
import * as AppleAuthentication from "expo-apple-authentication";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { authClient } from "@/lib/auth";
import { Button } from "../Button";
import { useTheme } from "../theme";
import { OrDivider } from "./AuthLink";

/**
 * "Continue with Google" and "Continue with Apple", each only when the server lists it (auth config).
 * On iOS, Apple uses the system button (Apple's rules) and a native sign-in sent to the server as an
 * ID token; elsewhere both go through the system browser and back on `agenteschat://`.
 */
export function SocialButtons({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const config = useAuthConfig();
  const providers = (config.data?.socialProviders ?? {}) as Record<string, boolean | undefined>;
  const [nativeApple, setNativeApple] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    AppleAuthentication.isAvailableAsync()
      .then(setNativeApple)
      .catch(() => setNativeApple(false));
  }, []);

  const google = providers.google === true;
  const apple = providers.apple === true;
  if (!google && !apple) return null;

  const browser = async (provider: "google" | "apple") => {
    setBusy(true);
    try {
      const res = await authClient.signIn.social({ provider, callbackURL: "/" });
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
      const res = await authClient.signIn.social({ provider: "apple", idToken: { token: credential.identityToken } });
      if (res.error) onError(t("mobile.auth.social.failed"));
    } catch (e) {
      // Closing Apple's sheet is not an error.
      if ((e as { code?: string })?.code !== "ERR_REQUEST_CANCELED") onError(t("mobile.auth.social.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <OrDivider label={t("mobile.common.or")} />
      {apple && nativeApple ? (
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
      ) : apple ? (
        <Button
          variant="secondary"
          wide
          label={t("mobile.auth.social.apple")}
          disabled={busy}
          onPress={() => void browser("apple")}
        />
      ) : null}
      {google ? (
        <Button
          variant="secondary"
          wide
          label={t("mobile.auth.social.google")}
          disabled={busy}
          onPress={() => void browser("google")}
        />
      ) : null}
    </View>
  );
}
