import { createAuthClient } from "better-auth/client";
import type { AuthClient, AuthResult } from "./client";

const toResult = (error: { status?: number; message?: string } | null | undefined): AuthResult =>
  error ? { ok: false, status: error.status ?? 500, message: error.message ?? "" } : { ok: true };

/** Better Auth client, the same setup as Tierbird's dashboard. */
export function createBetterAuthClient(origin = window.location.origin): AuthClient {
  const client = createAuthClient({ baseURL: origin, basePath: "/api/auth" });
  return {
    signIn: async ({ email, password }) => toResult((await client.signIn.email({ email, password })).error),
    signUp: async ({ name, email, password }) => toResult((await client.signUp.email({ name, email, password })).error),
    signInSocial: async (provider, callbackURL) =>
      toResult((await client.signIn.social({ provider, callbackURL, errorCallbackURL: "/login" })).error),
    requestPasswordReset: async ({ email, redirectTo }) =>
      toResult((await client.requestPasswordReset({ email, redirectTo })).error),
    resetPassword: async ({ token, newPassword }) =>
      toResult((await client.resetPassword({ token, newPassword })).error),
    signOut: async () => {
      await client.signOut();
    },
    desktopHandoff: async (challenge) =>
      toResult((await client.$fetch("/desktop/handoff", { method: "POST", body: { challenge } })).error),
    desktopRedeem: async (verifier) => {
      const res = await client.$fetch<{ signedIn: boolean }>("/desktop/redeem", { method: "POST", body: { verifier } });
      return res.data?.signedIn === true;
    },
  };
}
