import { createHash, randomBytes } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

/**
 * Social sign-in for the Mac app's window (ADR 0036). Google and Apple refuse
 * embedded web views, so the window opens the sign-in in the person's
 * browser and waits. The window keeps a random verifier and sends only its
 * SHA-256 (the challenge) along. Once signed in, the browser registers that
 * challenge for its user (`/desktop/handoff`) and gets back a one-time code,
 * which it hands to the app on this computer through the app's own link
 * (`agenteschat://desktop/sign-in?code=`, deep_link.rs). The window then
 * redeems the code together with its verifier (`/desktop/redeem`) and gets a
 * session of its own (the browser's stays where it is).
 *
 * Both halves are needed: whoever wrote the sign-in link knows the verifier
 * but never sees the code (it goes from the person's browser to the app on
 * their own computer), and that app holds no verifier for someone else's
 * challenge. So a link crafted by someone else can't hand a session over.
 *
 * A handoff needs a fresh sign-in (a session made in the last few minutes),
 * so a link that skips the provider can't hand over an old browser session.
 */
export const HANDOFF_PREFIX = "desktop-handoff:";
/** How long the app has to redeem the code: it gets it right away, through its own link. */
const HANDOFF_TTL_MS = 5 * 60_000;
/** How recent the browser's sign-in must be to hand it over. */
const FRESH_SIGN_IN_MS = 10 * 60_000;
/** 32 random bytes and their SHA-256, both base64url (43 characters). */
const KEY = /^[A-Za-z0-9_-]{43}$/;

export const desktopChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function parseHandoff(value: string): { userId: string; challenge: string } | null {
  try {
    const parsed = JSON.parse(value) as { userId?: unknown; challenge?: unknown };
    return typeof parsed.userId === "string" && typeof parsed.challenge === "string"
      ? { userId: parsed.userId, challenge: parsed.challenge }
      : null;
  } catch {
    return null;
  }
}

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
          // The code is the lookup key; the challenge stays on the row, to be matched by the verifier.
          const code = randomBytes(32).toString("base64url");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: HANDOFF_PREFIX + code,
            value: JSON.stringify({ userId: session.userId, challenge: ctx.body.challenge }),
            expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
          });
          return ctx.json({ code });
        },
      ),
      desktopRedeem: createAuthEndpoint(
        "/desktop/redeem",
        { method: "POST", body: z.object({ code: z.string().regex(KEY), verifier: z.string().regex(KEY) }) },
        async (ctx) => {
          // Single use either way: a wrong verifier spends the code too.
          const found = await ctx.context.internalAdapter.consumeVerificationValue(HANDOFF_PREFIX + ctx.body.code);
          if (!found || found.expiresAt < new Date()) return ctx.json({ signedIn: false });
          const handoff = parseHandoff(found.value);
          if (!handoff || handoff.challenge !== desktopChallenge(ctx.body.verifier)) return ctx.json({ signedIn: false });
          const user = await ctx.context.internalAdapter.findUserById(handoff.userId);
          if (!user) return ctx.json({ signedIn: false });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ signedIn: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
