import { sign as signWithKey } from "node:crypto";
import type { Config } from "@agenteschat/config";
import { type Database, schema } from "@agenteschat/db";
import { deriveSecret, emailLocale, isSignupAllowed, onUserCreated, queueEmail, sha256 } from "@agenteschat/engine";
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Logger } from "./logger";

/**
 * Sign-in for people, built on Better Auth (ADR 0006):
 * Better Auth owns users, sessions, passwords and social sign-in; agentes.chat
 * owns organizations, memberships, roles and invitations
 * (`@agenteschat/engine` organizations). Agents are not users.
 * See docs/adr/0006-auth-and-tenancy.md.
 *
 * Mounted at `/api/auth/*`. The web app is served from the same origin, so
 * the session is an HttpOnly cookie — no tokens in the browser. The phone
 * app (ADR 0035) signs in through the Expo plugin: its scheme
 * `agenteschat://` is trusted, it keeps the cookie in the device's secure
 * store and sends it back in a `Cookie` header with `X-Agentes-Client: mobile`.
 */
export function createAuth(deps: { db: Database; config: Config; log: Logger; emailDelivers?: boolean }) {
  const { db, config, log } = deps;
  const emailEnabled = deps.emailDelivers === true;

  /**
   * Emails cleared by an org invite link in the sign-up request (header
   * `x-invite-token`), for the user-create hook of the same request.
   */
  const clearedByLink = new Map<string, number>();
  const assertSignupAllowed = async (email: string, inviteToken?: string | null) => {
    const key = email.toLowerCase();
    const cleared = clearedByLink.get(key);
    if (cleared !== undefined && cleared > Date.now()) return;
    if (!(await isSignupAllowed(db, email, config.ALLOW_SIGNUP, new Date(), inviteToken))) {
      throw new APIError("FORBIDDEN", {
        message: "Sign-up is closed on this agentes.chat instance. Ask an organization owner for an invitation.",
      });
    }
  };

  const devOrigins = config.NODE_ENV === "development" ? ["http://localhost:5173"] : [];
  // The phone app (ADR 0035); Expo Go and dev builds use `exp://` outside production.
  const appOrigins = [APP_SCHEME, ...(config.NODE_ENV !== "production" ? ["exp://", "exp://**"] : [])];
  const apple = appleSignIn(config);

  return betterAuth({
    appName: "agentes.chat",
    baseURL: config.PUBLIC_URL,
    basePath: "/api/auth",
    // Derived from AGENTES_SECRET so self-hosters manage a single secret.
    secret: deriveSecret(config.AGENTES_SECRET, "sessions"),
    // Apple posts the sign-in result back from its own origin (`response_mode=form_post`).
    trustedOrigins: [config.PUBLIC_URL, ...devOrigins, ...appOrigins, ...(apple ? [APPLE_ORIGIN] : [])],
    plugins: [expo()],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    user: {
      additionalFields: { locale: { type: "string", required: false, input: false } },
    },
    session: {
      additionalFields: { activeOrganizationId: { type: "string", required: false, input: false } },
      // Signed cookie cache: most requests don't hit the sessions table.
      // Trade-off: signing out elsewhere takes up to 5 minutes to propagate.
      // Permissions are still checked against the database on every request.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      // Only when a real email sender is configured (MillionSend or SMTP); sent through the outbox.
      ...(emailEnabled
        ? {
            sendResetPassword: async ({
              user,
              url,
              token,
            }: {
              user: { email: string; locale?: string | null };
              url: string;
              token: string;
            }) => {
              await queueEmail(db, {
                orgId: null,
                key: `password-reset:${sha256(token)}`,
                to: [user.email],
                template: { kind: "password_reset", locale: emailLocale(user.locale), url },
              });
            },
          }
        : {}),
    },
    ...(emailEnabled
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({
              user,
              url,
              token,
            }: {
              user: { email: string; locale?: string | null };
              url: string;
              token: string;
            }) => {
              await queueEmail(db, {
                orgId: null,
                key: `verify-email:${sha256(token)}`,
                to: [user.email],
                template: { kind: "verify_email", locale: emailLocale(user.locale), url },
              });
            },
          },
        }
      : {}),
    socialProviders: {
      ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
        ? { github: { clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET } }
        : {}),
      ...(apple ? { apple } : {}),
    },
    rateLimit: {
      enabled: config.NODE_ENV !== "test",
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 15 * 60, max: 10 },
        "/request-password-reset": { window: 15 * 60, max: 3 },
      },
    },
    advanced: {
      ipAddress: {
        trustedProxies: config.TRUSTED_PROXIES?.split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      },
    },
    hooks: {
      // Checked before the endpoint runs so the person sees the real reason.
      // The database hook below also guards social sign-in.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email !== "string") return;
        const inviteToken = ctx.headers?.get("x-invite-token")?.trim() || null;
        await assertSignupAllowed(email, inviteToken);
        if (inviteToken) {
          for (const [k, until] of clearedByLink) if (until <= Date.now()) clearedByLink.delete(k);
          clearedByLink.set(email.toLowerCase(), Date.now() + 60_000);
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await assertSignupAllowed(user.email);
            return { data: { ...user, email: user.email.toLowerCase() } };
          },
          after: async (user) => {
            try {
              await onUserCreated(db, user.id);
            } catch (error) {
              log.error("post-signup setup failed", { userId: user.id, error: String(error) });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export type SessionUser = { id: string; name: string; email: string; image?: string | null };

/** Resolves the signed-in person from request headers (cookie), or null. Used by HTTP and WebSocket. */
export async function sessionUser(auth: Auth, headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  return session ? (session.user as SessionUser) : null;
}

/** Sign-in options the login and sign-up pages need to render. */
export function authUiConfig(config: Config) {
  return {
    socialProviders: {
      google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
      github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
      apple: appleConfigured(config),
    },
    landing: config.LANDING_PAGE,
    termsUrl: config.TERMS_URL ?? null,
    privacyUrl: config.PRIVACY_URL ?? null,
  };
}

/** The phone app's URL scheme (deep links back from social sign-in). */
export const APP_SCHEME = "agenteschat://";
export const APPLE_ORIGIN = "https://appleid.apple.com";
/** Apple accepts a client secret valid for at most 6 months; we sign one per boot for 150 days. */
const APPLE_SECRET_TTL_S = 150 * 24 * 3600;

const appleConfigured = (config: Config) =>
  Boolean(config.APPLE_CLIENT_ID && config.APPLE_TEAM_ID && config.APPLE_KEY_ID && config.APPLE_PRIVATE_KEY);

/**
 * "Sign in with Apple" (App Store 4.8), when its four variables are set. The
 * client secret Apple wants is an ES256 JWT signed with the Sign in with
 * Apple key (iss = team, sub = services id, aud = appleid.apple.com).
 * `APPLE_APP_BUNDLE_ID` lets the iOS app sign in natively (its id tokens
 * carry the bundle id as audience).
 */
export function appleSignIn(config: Config, now = Date.now()) {
  if (!appleConfigured(config)) return null;
  const clientId = config.APPLE_CLIENT_ID as string;
  return {
    clientId,
    clientSecret: appleClientSecret({
      clientId,
      teamId: config.APPLE_TEAM_ID as string,
      keyId: config.APPLE_KEY_ID as string,
      privateKey: config.APPLE_PRIVATE_KEY as string,
      now,
    }),
    ...(config.APPLE_APP_BUNDLE_ID ? { appBundleIdentifier: config.APPLE_APP_BUNDLE_ID } : {}),
  };
}

/** The ES256 client secret JWT for Apple's token endpoint. */
export function appleClientSecret(input: {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  now?: number;
}): string {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "ES256", kid: input.keyId, typ: "JWT" })}.${encode({
    iss: input.teamId,
    iat,
    exp: iat + APPLE_SECRET_TTL_S,
    aud: APPLE_ORIGIN,
    sub: input.clientId,
  })}`;
  // JWS wants the raw r||s signature, not DER.
  const signature = signWithKey("sha256", Buffer.from(signingInput), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

/** Revokes one Apple token (best effort; throws on failure, callers swallow it). */
export type AppleTokenRevoker = (token: { value: string; hint: "refresh_token" | "access_token" }) => Promise<void>;

/**
 * Apple's token revocation (required when an account that signed in with
 * Apple is deleted), with the same client secret as sign-in, signed fresh
 * for each call. Null when Sign in with Apple isn't configured. Tests
 * inject a fake instead (`AppExtras.appleRevoke`).
 */
export function appleTokenRevoker(config: Config, http: typeof fetch = fetch): AppleTokenRevoker | null {
  if (!appleConfigured(config)) return null;
  const clientId = config.APPLE_CLIENT_ID as string;
  return async (token) => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: appleClientSecret({
        clientId,
        teamId: config.APPLE_TEAM_ID as string,
        keyId: config.APPLE_KEY_ID as string,
        privateKey: config.APPLE_PRIVATE_KEY as string,
      }),
      token: token.value,
      token_type_hint: token.hint,
    });
    const res = await http(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Apple refused the token revocation (${res.status})`);
  };
}
