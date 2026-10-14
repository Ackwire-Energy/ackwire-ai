import type { Config } from "@agenteschat/config";
import { type Database, schema } from "@agenteschat/db";
import { deriveSecret, isSignupAllowed, onUserCreated, queueEmail, sha256 } from "@agenteschat/engine";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Logger } from "./logger";

/**
 * Sign-in for people, built on Better Auth (same split as Tierbird):
 * Better Auth owns users, sessions, passwords and social sign-in; agentes.chat
 * owns organizations, memberships, roles and invitations
 * (`@agenteschat/engine` organizations). Agents are not users.
 * See docs/adr/0006-auth-and-tenancy.md.
 *
 * Mounted at `/api/auth/*`. The web app is served from the same origin, so
 * the session is an HttpOnly cookie — no tokens in the browser.
 */
export function createAuth(deps: { db: Database; config: Config; log: Logger; emailDelivers?: boolean }) {
  const { db, config, log } = deps;
  const emailEnabled = deps.emailDelivers === true;

  const assertSignupAllowed = async (email: string) => {
    if (!(await isSignupAllowed(db, email, config.ALLOW_SIGNUP))) {
      throw new APIError("FORBIDDEN", {
        message: "Sign-up is closed on this agentes.chat instance. Ask an organization owner for an invitation.",
      });
    }
  };

  const devOrigins = config.NODE_ENV === "development" ? ["http://localhost:5173"] : [];

  return betterAuth({
    appName: "agentes.chat",
    baseURL: config.PUBLIC_URL,
    basePath: "/api/auth",
    // Derived from AGENTES_SECRET so self-hosters manage a single secret.
    secret: deriveSecret(config.AGENTES_SECRET, "sessions"),
    trustedOrigins: [config.PUBLIC_URL, ...devOrigins],
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
      // Only when a real email sender is configured (MILLIONSEND_API_KEY); sent through the outbox.
      ...(emailEnabled
        ? {
            sendResetPassword: async ({
              user,
              url,
              token,
            }: {
              user: { email: string };
              url: string;
              token: string;
            }) => {
              await queueEmail(db, {
                orgId: null,
                key: `password-reset:${sha256(token)}`,
                to: [user.email],
                template: { kind: "password_reset", url },
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
              user: { email: string };
              url: string;
              token: string;
            }) => {
              await queueEmail(db, {
                orgId: null,
                key: `verify-email:${sha256(token)}`,
                to: [user.email],
                template: { kind: "verify_email", url },
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
        if (typeof email === "string") await assertSignupAllowed(email);
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

/** Sign-in options the login page needs to render. */
export function authUiConfig(config: Config) {
  return {
    socialProviders: {
      google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
      github: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
    },
  };
}
