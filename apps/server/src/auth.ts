import { randomBytes, sign as signWithKey } from "node:crypto";
import type { HumanAction, HumanCheck, RateLimiter } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import { type Database, schema } from "@agenteschat/db";
import {
  accountBlock,
  countUsers,
  deriveSecret,
  emailLocale,
  isSignupAllowed,
  onUserCreated,
  queueEmail,
  recordSession,
  recordSignUp,
  requestLocale,
  type SignupPolicy,
  sha256,
} from "@agenteschat/engine";
import { expo } from "@better-auth/expo";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint, createAuthMiddleware, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { desktopSignIn } from "./desktop-sign-in";
import { humanCheckRefusal } from "./http/human-check";
import type { Logger } from "./logger";
import { ownerSignIn } from "./owner-claim";

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
 * The Mac app's window loads the site itself and signs in like the web; for
 * Google and Apple it borrows the browser (`desktop-sign-in.ts`, ADR 0036).
 */
export function createAuth(deps: {
  db: Database;
  config: Config;
  log: Logger;
  emailDelivers?: boolean;
  /** Counts the reset and confirmation emails per address. */
  rateLimiter: RateLimiter;
  /** The bot check of the email forms (ADR 0075); absent: none. */
  humanCheck?: HumanCheck | null;
}) {
  const { db, config, log, rateLimiter } = deps;
  const emailEnabled = deps.emailDelivers === true;
  // Better Auth answers the same whether an email went out, so a flood from many addresses only stops quietly.
  const emailAllowed = async (kind: "reset-email" | "verify-email", email: string) =>
    (await rateLimiter.consume(`${kind}:${sha256(email.toLowerCase())}`, EMAILS_PER_ADDRESS)).allowed;

  const policy = signupPolicy(config);
  // An invitation link never opens sign-up (ADR 0068): only an email invitation to that address does.
  const assertSignupAllowed = async (email: string) => {
    if (!(await isSignupAllowed(db, email, policy))) {
      if (policy.ownerByLink && (await countUsers(db)) === 0) {
        throw new APIError("FORBIDDEN", {
          code: OWNER_CLAIM_REQUIRED,
          message: "This server waits for its owner: open its owner link.",
        });
      }
      throw new APIError("FORBIDDEN", {
        message: "Sign-up is closed on this server. If you were invited, open the link in the invitation email.",
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
    plugins: [
      expo(),
      phoneSignIn,
      desktopSignIn(),
      ownerSignIn({ db, config, log, mint: (adapter, userId) => mintSignIn(adapter, `${FOR_USER}${userId}`) }),
    ],
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
      // The reset email says the link works for an hour.
      resetPasswordTokenExpiresIn: 60 * 60,
      // Only when a real email sender is configured (MillionSend or SMTP); sent through the outbox.
      ...(emailEnabled
        ? {
            sendResetPassword: async (
              {
                user,
                token,
              }: {
                user: { email: string; locale?: string | null };
                url: string;
                token: string;
              },
              request?: Request,
            ) => {
              if (!(await emailAllowed("reset-email", user.email))) return;
              // Straight to our page (not Better Auth's redirect): the same link opens the phone app when it is
              // installed (universal link / App Link, app-links.ts) and the website otherwise; both reset with it.
              const url = `${config.PUBLIC_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
              // An account with no language yet (made by the owner link, or before sign-up kept one): the request's.
              const locale = emailLocale(user.locale ?? requestLocale(request?.headers.get("accept-language")));
              await queueEmail(db, {
                orgId: null,
                key: `password-reset:${sha256(token)}`,
                to: [user.email],
                template: { kind: "password_reset", locale, url },
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
            // The onboarding says the link works for an hour (`onboarding.confirmation.sent`).
            expiresIn: 60 * 60,
            sendVerificationEmail: async (
              {
                user,
                url,
                token,
              }: {
                user: { email: string; locale?: string | null };
                url: string;
                token: string;
              },
              request?: Request,
            ) => {
              if (!(await emailAllowed("verify-email", user.email))) return;
              const locale = emailLocale(user.locale ?? requestLocale(request?.headers.get("accept-language")));
              await queueEmail(db, {
                orgId: null,
                key: `verify-email:${sha256(token)}`,
                to: [user.email],
                template: { kind: "verify_email", locale, url: confirmationLanding(url) },
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
        // The app's window asks every 2 s while the browser signs in.
        "/desktop/redeem": { window: 60, max: 40 },
        "/desktop/handoff": { window: 60, max: 10 },
        "/owner-claim": { window: 60, max: 10 },
        "/owner-key": { window: 60, max: 10 },
      },
    },
    advanced: {
      ipAddress: { trustedProxies: config.TRUSTED_PROXIES },
    },
    hooks: {
      // Checked before the endpoint runs so the person sees the real reason.
      // The database hook below also guards social sign-in.
      before: createAuthMiddleware(async (ctx) => {
        const action = HUMAN_ACTIONS[ctx.path];
        // Before the sign-up policy: a bot gets the cheap refusal first.
        if (action && ctx.headers) {
          const refused = await humanCheckRefusal(deps.humanCheck, ctx.headers, action, config.TRUSTED_PROXIES);
          if (refused) throw new APIError("FORBIDDEN", refused);
        }
        if (ctx.path !== "/sign-up/email") return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email !== "string") return;
        await assertSignupAllowed(email);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Social sign-up too (the phone's Apple sign-in from an invitation).
          before: async (user, context) => {
            await assertSignupAllowed(user.email);
            // The sign-up's own language from the start: the confirmation email goes out before any other choice.
            const locale = requestLocale(context?.headers?.get("accept-language"));
            return { data: { ...user, email: user.email.toLowerCase(), ...(locale ? { locale } : {}) } };
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
      // The operator API's events feed (ADR 0056). These run after the sign-in has committed: a failure
      // here is logged and never fails the sign-in.
      account: {
        create: {
          after: async (account) => {
            await recordSignUp(db, account).catch((error) =>
              log.error("operator event failed", { type: "user.signed_up", error: String(error) }),
            );
          },
        },
      },
      session: {
        create: {
          // A blocked account (ADR 0056 §9) gets no session, whatever the sign-in method. The code also
          // makes a social sign-in's callback send the person back to the sign-in page. On agentes.chat Cloud the
          // body adds the block's kind, never its reason.
          before: async (session) => {
            const block = await accountBlock(db, session.userId);
            if (block) {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_BLOCKED",
                message: "This account can't sign in.",
                ...block,
              });
            }
          },
          after: async (session) => {
            await recordSession(db, session).catch((error) =>
              log.error("operator event failed", { type: "session.created", error: String(error) }),
            );
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

/** Better Auth's paths that a bot check guards (ADR 0075), with the action their widget runs. */
const HUMAN_ACTIONS: Record<string, HumanAction> = {
  "/sign-in/email": "sign-in",
  "/sign-up/email": "sign-up",
  "/request-password-reset": "password-reset",
};

/** Reset and confirmation emails to one address in an hour. */
const EMAILS_PER_ADDRESS = { limit: 3, windowMs: 3600_000 };

/** `APIError` code of a sign-up refused because the first account waits for its owner's link or key. */
export const OWNER_CLAIM_REQUIRED = "OWNER_CLAIM_REQUIRED";

/**
 * The confirmation link, landing on `/?email_confirmed=1`, where the web app says how it went
 * (apps/web/src/lib/email-confirmation.ts), whenever the request named no other page: the phone app's sign-up
 * and a new link asked for later name none.
 */
function confirmationLanding(verifyUrl: string): string {
  const url = new URL(verifyUrl);
  const back = url.searchParams.get("callbackURL");
  if (!back || back === "/") url.searchParams.set("callbackURL", "/?email_confirmed=1");
  return url.toString();
}

/** Who may sign up here (ADR 0006; the owner's link or key, ADR 0060 §6). */
export function signupPolicy(config: Config): SignupPolicy {
  return {
    allowSignup: config.ALLOW_SIGNUP,
    ownerByLink: Boolean(config.OWNER_CLAIM_SHA256 || config.OWNER_KEY_SHA256),
  };
}

/** Sign-in options the login and sign-up pages need to render. */
export function authUiConfig(config: Config) {
  return {
    socialProviders: {
      google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
      github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
      apple: appleConfigured(config),
    },
    termsUrl: config.TERMS_URL ?? null,
    privacyUrl: config.PRIVACY_URL ?? null,
    supportEmail: config.SUPPORT_EMAIL ?? null,
  };
}

/** How long the sign-in in "Abrir no celular" (the web app's QR code) lasts. */
const PHONE_SIGN_IN_TTL_MS = 3 * 60_000;
const phoneSignInKey = (token: string) => `phone-sign-in:${sha256(token)}`;
/** A minted sign-in for a user rather than for a session's user (the owner key's, `owner-claim.ts`). */
const FOR_USER = "user:";

/** Single use, a few minutes long, stored as a hash: for the session with this token, or `user:<id>`. */
async function mintSignIn(
  adapter: { createVerificationValue: (v: { identifier: string; value: string; expiresAt: Date }) => Promise<unknown> },
  value: string,
) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PHONE_SIGN_IN_TTL_MS);
  await adapter.createVerificationValue({ identifier: phoneSignInKey(token), value, expiresAt });
  return { token, expiresIn: PHONE_SIGN_IN_TTL_MS / 1000 };
}

/**
 * A one-time sign-in for the phone, minted from a signed-in session: void once that session ends
 * (signing out on the web voids a QR code still on screen).
 */
export async function mintPhoneSignIn(auth: Auth, sessionToken: string) {
  const { internalAdapter } = await auth.$context;
  return mintSignIn(internalAdapter, sessionToken);
}

/**
 * `POST /api/auth/sign-in/one-time-token { token }`: the phone trades the token for a session of its own.
 * Better Auth's `oneTimeToken` plugin would hand it the browser's session instead, so signing out on one
 * device would sign out the other.
 */
const phoneSignIn = {
  id: "phone-sign-in",
  endpoints: {
    signInOneTimeToken: createAuthEndpoint(
      "/sign-in/one-time-token",
      { method: "POST", body: z.object({ token: z.string().min(1).max(200) }), use: [formCsrfMiddleware] },
      async (ctx) => {
        const { internalAdapter } = ctx.context;
        const minted = await internalAdapter.consumeVerificationValue(phoneSignInKey(ctx.body.token));
        let user: Awaited<ReturnType<typeof internalAdapter.findUserById>> = null;
        if (minted?.value.startsWith(FOR_USER))
          user = await internalAdapter.findUserById(minted.value.slice(FOR_USER.length));
        else if (minted) {
          const from = await internalAdapter.findSession(minted.value);
          if (from && from.session.expiresAt >= new Date()) user = from.user;
        }
        if (!user) throw new APIError("UNAUTHORIZED", { message: "This code expired or was already used" });
        const session = await internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ user: { id: user.id, name: user.name, email: user.email } });
      },
    ),
  },
} satisfies BetterAuthPlugin;

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
