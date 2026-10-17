import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { API_URL, SCHEME, STORAGE_PREFIX } from "@/config";

/**
 * Better Auth for the app (ADR 0035 §3): the session cookie lives in SecureStore (Expo plugin), social
 * sign-in goes through the system browser and comes back on `agenteschat://`.
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  basePath: "/api/auth",
  fetchOptions: { headers: { "X-Agentes-Client": "mobile" } },
  plugins: [expoClient({ scheme: SCHEME, storagePrefix: STORAGE_PREFIX, storage: SecureStore })],
});

let cookie = "";

/** The session cookie, read fresh from SecureStore (and kept for the synchronous callers). */
export async function readCookie(): Promise<string> {
  try {
    cookie = await authClient.getCookie();
  } catch {
    cookie = "";
  }
  return cookie;
}

/** The last cookie read (the WebSocket factory is synchronous). */
export const lastCookie = () => cookie;

/** Headers every app request carries (ADR 0035 §3: no `Origin`, the app header and the cookie). */
export function appHeaders(currentCookie: string): Record<string, string> {
  const headers: Record<string, string> = { "X-Agentes-Client": "mobile" };
  if (currentCookie) headers.Cookie = currentCookie;
  return headers;
}

/**
 * `fetch` with the session: the cookie goes in a header and `credentials: "omit"`, so the platform's
 * own cookie jar never interferes (Better Auth's Expo guide).
 */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(appHeaders(await readCookie()))) headers.set(name, value);
  return fetch(input, { ...init, headers, credentials: "omit" });
}
