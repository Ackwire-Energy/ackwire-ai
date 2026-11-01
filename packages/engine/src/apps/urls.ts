import { randomBytes } from "node:crypto";

/**
 * AI apps (ADR 0113): the addresses, scopes and token shapes of this server as an MCP server and its own
 * OAuth 2.1 authorization server. One helper for every address, so the metadata, the 401 challenge and the
 * address shown in Settings never drift apart.
 */

export const APP_SCOPES = ["read", "write"] as const;
export type AppScope = (typeof APP_SCOPES)[number];

export const ACCESS_TOKEN_PREFIX = "aga_";
export const REFRESH_TOKEN_PREFIX = "agf_";
export const PERSONAL_TOKEN_PREFIX = "agp_";
export const DCR_CLIENT_PREFIX = "agcl_";

export const APP_LIMITS = {
  requestMs: 30 * 60_000,
  codeMs: 120_000,
  accessMs: 3600_000,
  /** Cursor's refresh is reported flaky: its access tokens live a working day. */
  cursorAccessMs: 8 * 3600_000,
  /** Sliding: each refresh starts it again. A grant unused this long is revoked. */
  refreshMs: 90 * 86_400_000,
  /** A rotated refresh token presented again within this: a client's retry, not a theft. */
  refreshGraceMs: 60_000,
  personalTokensPerWorkspace: 10,
  personalTokenNameChars: 60,
  clientNameChars: 64,
  redirectUris: 10,
  redirectUriChars: 512,
  stateChars: 4096,
} as const;

/** The server's base address with no trailing slash: the issuer, and the base of every other address. */
export function appsUrls(publicUrl: string) {
  const issuer = publicUrl.replace(/\/+$/, "");
  return {
    issuer,
    /** What people paste into their app, and the OAuth resource identifier. */
    resource: `${issuer}/mcp`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource/mcp`,
    authorize: `${issuer}/api/oauth/authorize`,
    token: `${issuer}/api/oauth/token`,
    register: `${issuer}/api/oauth/register`,
    revoke: `${issuer}/api/oauth/revoke`,
    consentPage: `${issuer}/autorizar`,
    docs: `${issuer}/help/apps-de-ia`,
    icon: `${issuer}/favicon.svg`,
  };
}

/**
 * A `resource` parameter compared the way clients spell it (RFC 8707): lowercase host, no default port, and at
 * most one trailing slash dropped. Null when it isn't a URL.
 */
export function normalizeResource(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hash || url.search) return null;
    const port = url.port && !(url.protocol === "https:" && url.port === "443") ? `:${url.port}` : "";
    const path = url.pathname.replace(/\/$/, "");
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}`;
  } catch {
    return null;
  }
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `length` random base62 characters (rejection sampling, so every character is equally likely). */
export function randomBase62(length = 43): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Scopes as stored, from a space-separated request: unknown ones (and `offline_access`) dropped, none = both. */
export function parseScopes(raw: string | undefined | null): AppScope[] {
  const asked = new Set((raw ?? "").split(/\s+/).filter(Boolean));
  const known = APP_SCOPES.filter((s) => asked.has(s));
  // Sending tasks without reading their replies is no use: write brings read along.
  return known.length === 0 || known.includes("write") ? [...APP_SCOPES] : known;
}
