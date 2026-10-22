import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

/**
 * Social sign-in for the Mac app's window (ADR 0036). Google and Apple refuse
 * embedded web views, so the window opens the sign-in in the person's
 * browser and waits. The window keeps a random verifier and sends only its
 * SHA-256 (the challenge) along; once signed in, the browser registers that
 * challenge for its user (`/desktop/handoff`). The window polls
 * `/desktop/redeem` with the verifier and, on a match, gets a session of its
 * own (the browser's stays where it is). Nothing travels in a URL that
 * would sign anyone in: without the verifier the challenge is worthless.
 *
 * A handoff needs a fresh sign-in (a session made in the last few minutes),
 * so a link that skips the provider can't hand over an old browser session.
 */
const HANDOFF_PREFIX = "desktop-handoff:";
/** How long the window has to pick the session up. */
const HANDOFF_TTL_MS = 10 * 60_000;
/** How recent the browser's sign-in must be to hand it over. */
const FRESH_SIGN_IN_MS = 10 * 60_000;
/** 32 random bytes and their SHA-256, both base64url (43 characters). */
const KEY = /^[A-Za-z0-9_-]{43}$/;

export const desktopChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function desktopSignIn() {
  return {
    id: "desktop-sign-in",
    endpoints: {
      desktopHandoff: createAuthEndpoint(
        "/desktop/handoff",
        { method: "POST", body: z.object({ challenge: z.string().regex(KEY) }), use: [sessionMiddleware] },
        async (ctx) => {
          const { session } = ctx.context.session;
          if (Date.now() - new Date(session.createdAt).getTime() > FRESH_SIGN_IN_MS) {
            throw new APIError("FORBIDDEN", { message: "Sign in again to continue in the app" });
          }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: HANDOFF_PREFIX + ctx.body.challenge,
            value: session.userId,
            expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
          });
          return ctx.json({ ok: true });
        },
      ),
      desktopRedeem: createAuthEndpoint(
        "/desktop/redeem",
        { method: "POST", body: z.object({ verifier: z.string().regex(KEY) }) },
        async (ctx) => {
          const found = await ctx.context.internalAdapter.consumeVerificationValue(
            HANDOFF_PREFIX + desktopChallenge(ctx.body.verifier),
          );
          if (!found || found.expiresAt < new Date()) return ctx.json({ signedIn: false });
          const user = await ctx.context.internalAdapter.findUserById(found.value);
          if (!user) return ctx.json({ signedIn: false });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ signedIn: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
