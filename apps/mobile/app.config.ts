import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * The app's Expo config. Builds run on EAS only (see README.md).
 * - `EXPO_PUBLIC_API_URL`: the backend the app talks to (default: production).
 * - `EAS_PROJECT_ID`: the EAS project (push tokens need it); set once after `eas init`.
 * - `APP_VARIANT`: "development" | "preview" | "production" (from eas.json), so the three install side by side.
 *
 * The New Architecture is the only one since SDK 55, so there is no `newArchEnabled` flag any more
 * (the SDK 58 config type no longer has it). Edge-to-edge on Android is likewise always on.
 */
const variant = process.env.APP_VARIANT ?? "production";
const suffix = variant === "production" ? "" : `.${variant}`;
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "https://agentes.chat";
const projectId = process.env.EAS_PROJECT_ID;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant === "production" ? "agentes" : `agentes ${variant}`,
  slug: "agentes",
  scheme: "agenteschat",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: `chat.agentes.app${suffix}`,
    supportsTablet: false,
    usesAppleSignIn: true,
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: `chat.agentes.app${suffix}`,
    adaptiveIcon: {
      foregroundImage: "./assets/images/adaptive-icon.png",
      backgroundColor: "#0f0f0e",
    },
    predictiveBackGestureEnabled: false,
  },
  // Native permission texts (the OS shows them before the app's i18n runs).
  locales: {
    "pt-BR": "./assets/locales/pt-BR.json",
    en: "./assets/locales/en.json",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-localization",
    "expo-web-browser",
    "expo-apple-authentication",
    [
      "expo-splash-screen",
      {
        image: "./assets/images/splash-icon.png",
        imageWidth: 120,
        resizeMode: "contain",
        backgroundColor: "#f4f4f1",
        dark: { image: "./assets/images/splash-icon.png", backgroundColor: "#0f0f0e" },
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/images/notification-icon.png",
        color: "#0063d1",
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "To send pictures in your conversations.",
        cameraPermission: "To take pictures and send them in your conversations.",
      },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiUrl,
    variant,
    ...(projectId ? { eas: { projectId } } : {}),
  },
  runtimeVersion: { policy: "appVersion" },
});
