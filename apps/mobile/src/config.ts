import Constants from "expo-constants";

/** Removes trailing slashes: "https://agentes.chat/" → "https://agentes.chat". */
export const trimBase = (url: string) => url.replace(/\/+$/, "");

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; variant?: string };

/** The backend: `extra.apiUrl` from app.config.ts (env `EXPO_PUBLIC_API_URL` at build time). */
export const API_URL = trimBase(extra.apiUrl ?? process.env.EXPO_PUBLIC_API_URL ?? "https://agentes.chat");

/** "development" | "preview" | "production". */
export const APP_VARIANT = extra.variant ?? "production";

/** The deep-link scheme (app.config.ts `scheme`). */
export const SCHEME = "agenteschat";

/** Prefix for everything the app keeps in SecureStore (keys allow only letters, digits, ".", "-" and "_"). */
export const STORAGE_PREFIX = "agenteschat";
