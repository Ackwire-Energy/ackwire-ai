import { type ApiClient, createHttpApi } from "@agenteschat/client";
import { API_URL } from "@/config";
import { appHeaders, readCookie } from "./auth";

/**
 * The API client for the app: the backend at `API_URL`, every request with the session cookie from
 * SecureStore and `X-Agentes-Client: mobile` (ADR 0035 §3). Screens reach it through `useApi()`.
 */
export const api: ApiClient = createHttpApi({
  baseUrl: API_URL,
  headers: async () => appHeaders(await readCookie()),
});
