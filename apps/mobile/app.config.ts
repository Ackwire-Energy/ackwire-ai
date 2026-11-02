import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * The app's Expo config. Builds: Android on the "Android build" workflow on GitHub Actions, or EAS (see
 * README.md). The native projects are made from this file by `expo prebuild` and never committed.
 * - `EXPO_PUBLIC_API_URL`: the server the app talks to by default (production); people can pick their own.
 * - `EAS_PROJECT_ID`: overrides the EAS project (push tokens need it); defaults to ours on expo.dev.
 * - `APP_VARIANT`: "development" | "preview" | "production" (from eas.json or the workflow), so the three install
 *   side by side.
 * - `GOOGLE_SERVICES_JSON`: path to Firebase's google-services.json, for push on Android (FCM).
 * - `ANDROID_VERSION_CODE`: the build's version code, set by the Android workflow (EAS numbers its own builds).
 *
 * The New Architecture is the only one since SDK 55, so there is no `newArchEnabled` flag any more
 * (the SDK 58 config type no longer has it). Edge-to-edge on Android is likewise always on.
 */
const variant = process.env.APP_VARIANT ?? "production";
const suffix = variant === "production" ? "" : `.${variant}`;
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "https://app.agentes.chat";
// Invitation and password reset links on this host open the app (universal links / App Links); the server
// publishes the matching /.well-known files (apps/server/src/app-links.ts). An early-access sign-up (`/signup`) opens
// the app on Android only, until the server lists it for iOS (app-links.ts says when).
const linkHost = new URL(apiUrl).host;
// Our EAS project on expo.dev (not a secret: it only names the project).
const projectId = process.env.EAS_PROJECT_ID ?? "8514d5b3-87e0-4980-89a0-4c692f6f4702";
// expo-image-picker and expo-camera both set iOS's camera text: one text for both uses.
const CAMERA_USE = "To take pictures for your conversations and scan QR codes.";

/**
 * Paths the app no longer has (the old Início and Conversas routes), sent to Conversas (`/`) so a stale link,
 * notification or restored URL never lands on "not found". expo-router applies these to deep links and to
 * in-app navigation alike. (`/search` is the search tab again.)
 */
export const LEGACY_REDIRECTS = [
  { source: "/chats", destination: "/" },
  { source: "/home", destination: "/" },
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant === "production" ? "agentes" : `agentes ${variant}`,
  slug: "agentes",
  scheme: "agenteschat",
  version: "0.1.0",
  // Upright everywhere (the plugin below); only the agent's screen, in control, lies down (`useSideways`).
  orientation: "default",
  icon: "./assets/images/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: `chat.agentes.app${suffix}`,
    supportsTablet: false,
    usesAppleSignIn: true,
    associatedDomains: [`applinks:${linkHost}`],
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: `chat.agentes.app${suffix}`,
    // Firebase's config comes from the build's environment, so the public repo carries none and a self-built app
    // brings its own Firebase project.
    ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}),
    ...(process.env.ANDROID_VERSION_CODE ? { versionCode: Number(process.env.ANDROID_VERSION_CODE) } : {}),
    // Two layers (the night sky, the tilted agent), so the launcher's mask and motion cut them like the iOS icon.
    adaptiveIcon: {
      foregroundImage: "./assets/images/adaptive-icon.png",
      backgroundImage: "./assets/images/adaptive-icon-background.png",
      backgroundColor: "#02060f",
    },
    predictiveBackGestureEnabled: false,
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: linkHost, pathPrefix: "/invite/" },
          { scheme: "https", host: linkHost, path: "/reset-password" },
          { scheme: "https", host: linkHost, path: "/signup" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  // Native permission texts (the OS shows them before the app's i18n runs).
  locales: {
    "pt-BR": "./assets/locales/pt-BR.json",
    en: "./assets/locales/en.json",
  },
  plugins: [
    ["expo-router", { redirects: LEGACY_REDIRECTS }],
    ["expo-screen-orientation", { initialOrientation: "PORTRAIT_UP" }],
    "expo-secure-store",
    "expo-localization",
    "expo-web-browser",
    "expo-apple-authentication",
    [
      "expo-splash-screen",
      {
        // The first frame of the animated splash (src/features/launch): same image, size and background as
        // the app (white in light), so the hand-over doesn't show. Keep LOGO in launch/logic.ts in step.
        image: "./assets/images/splash-icon.png",
        imageWidth: 120,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
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
    // Android release builds signed with the upload key from the environment (the Android build workflow).
    "./plugins/with-android-release-signing",
    [
      "expo-image-picker",
      {
        photosPermission: "To send pictures in your conversations.",
        cameraPermission: CAMERA_USE,
      },
    ],
    [
      // Escanear QR code (Seu servidor): QR codes only, so no microphone.
      "expo-camera",
      { cameraPermission: CAMERA_USE, microphonePermission: false, recordAudioAndroid: false },
    ],
    [
      // Mensagens de voz (ADR 0100): the app records only while the person holds or locks the button.
      "expo-audio",
      { microphonePermission: "To record voice messages in your conversations.", recordAudioAndroid: true },
    ],
    [
      // Salvar em Fotos: add-only access (the read text matches expo-image-picker's).
      "expo-media-library",
      {
        photosPermission: "To send pictures in your conversations.",
        savePhotosPermission: "To save pictures from your conversations to Photos.",
        granularPermissions: ["photo"],
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
