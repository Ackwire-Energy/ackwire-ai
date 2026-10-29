import { humanCheckHeaders } from "@agenteschat/client/lib/human-check";
import { createAuthClient } from "better-auth/client";
import type { AuthClient, AuthResult } from "./client";

const toResult = (
  error: { status?: number; message?: string; code?: string; kind?: unknown; cloud?: unknown } | null | undefined,
): AuthResult =>
  error
    ? {
        ok: false,
        status: error.status ?? 500,
        message: error.message ?? "",
        ...(error.code ? { code: error.code } : {}),
        ...(typeof error.kind === "string" ? { kind: error.kind } : {}),
        ...(error.cloud === true ? { cloud: true } : {}),
      }
    : { ok: true };

/**
 * Better Auth client for the web app (same origin, `/api/auth`). Every request says the app's language
 * (`language`) in `Accept-Language`: an account made here keeps it, and its first emails come in it.
 */
export function createBetterAuthClient(origin = window.location.origin, language?: () => string): AuthClient {
  const client = createAuthClient({
    baseURL: origin,
    basePath: "/api/auth",
    fetchOptions: {
      onRequest: (request) => {
        if (language) request.headers.set("accept-language", language());
      },
    },
  });
  return {
    signIn: async ({ email, password }, humanCheck) =>
      toResult(
        (await client.signIn.email({ email, password, fetchOptions: { headers: humanCheckHeaders(humanCheck) } }))
          .error,
      ),
    signUp: async ({ name, email, password }, humanCheck) =>
      toResult(
        (await client.signUp.email({ name, email, password, fetchOptions: { headers: humanCheckHeaders(humanCheck) } }))
          .error,
      ),
    sendVerificationEmail: async (email) => toResult((await client.sendVerificationEmail({ email })).error),
    signInSocial: async (provider, callbackURL) =>
      toResult((await client.signIn.social({ provider, callbackURL, errorCallbackURL: "/login" })).error),
    requestPasswordReset: async ({ email, redirectTo }, humanCheck) =>
      toResult(
        (
          await client.requestPasswordReset({
            email,
            redirectTo,
            fetchOptions: { headers: humanCheckHeaders(humanCheck) },
          })
        ).error,
      ),
    resetPassword: async ({ token, newPassword }) =>
      toResult((await client.resetPassword({ token, newPassword })).error),
    signOut: async () => {
      await client.signOut();
    },
    desktopHandoff: async (challenge) => {
      const res = await client.$fetch<{ code: string }>("/desktop/handoff", { method: "POST", body: { challenge } });
      return typeof res.data?.code === "string" ? res.data.code : null;
    },
    signInOneTime: async (token) =>
      toResult((await client.$fetch("/sign-in/one-time-token", { method: "POST", body: { token } })).error),
    desktopRedeem: async (code, verifier) => {
      const res = await client.$fetch<{ signedIn: boolean }>("/desktop/redeem", {
        method: "POST",
        body: { code, verifier },
      });
      return res.data?.signedIn === true;
    },
    ownerClaim: async (input) => toResult((await client.$fetch("/owner-claim", { method: "POST", body: input })).error),
  };
}
