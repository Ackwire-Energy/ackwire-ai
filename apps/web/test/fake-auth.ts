import type { AuthClient, AuthResult } from "@/auth/client";

/** A call's arguments, with the bot check's token only when one was sent. */
const withToken = (input: unknown, humanCheck: string | undefined) =>
  humanCheck === undefined ? [input] : [input, humanCheck];

export function createFakeAuth(
  options: {
    signIn?: AuthResult;
    signUp?: AuthResult;
    reset?: AuthResult;
    redeem?: boolean;
    /** The code `desktopHandoff` gives; null when refused. */
    handoffCode?: string | null;
    oneTime?: AuthResult;
    claim?: AuthResult;
    verification?: AuthResult;
    onSignIn?: () => void;
  } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const auth: AuthClient = {
    signIn: async (input, humanCheck) => {
      calls.push({ method: "signIn", args: withToken(input, humanCheck) });
      const result = options.signIn ?? { ok: true };
      if (result.ok) options.onSignIn?.();
      return result;
    },
    signUp: async (input, humanCheck) => {
      calls.push({ method: "signUp", args: withToken(input, humanCheck) });
      return options.signUp ?? { ok: true };
    },
    sendVerificationEmail: async (email) => {
      calls.push({ method: "sendVerificationEmail", args: [email] });
      return options.verification ?? { ok: true };
    },
    signInSocial: async (provider, callbackURL) => {
      calls.push({ method: "signInSocial", args: [provider, callbackURL] });
      return { ok: true };
    },
    requestPasswordReset: async (input, humanCheck) => {
      calls.push({ method: "requestPasswordReset", args: withToken(input, humanCheck) });
      return { ok: true };
    },
    resetPassword: async (input) => {
      calls.push({ method: "resetPassword", args: [input] });
      return options.reset ?? { ok: true };
    },
    signOut: async () => {
      calls.push({ method: "signOut", args: [] });
    },
    desktopHandoff: async (challenge) => {
      calls.push({ method: "desktopHandoff", args: [challenge] });
      return options.handoffCode === undefined ? "k".repeat(43) : options.handoffCode;
    },
    desktopRedeem: async (code, verifier) => {
      calls.push({ method: "desktopRedeem", args: [code, verifier] });
      return options.redeem ?? false;
    },
    signInOneTime: async (token) => {
      calls.push({ method: "signInOneTime", args: [token] });
      return options.oneTime ?? { ok: true };
    },
    ownerClaim: async (input) => {
      calls.push({ method: "ownerClaim", args: [input] });
      return options.claim ?? { ok: true };
    },
  };
  return { auth, calls };
}
