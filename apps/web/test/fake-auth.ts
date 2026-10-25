import type { AuthClient, AuthResult } from "@/auth/client";

export function createFakeAuth(
  options: {
    signIn?: AuthResult;
    signUp?: AuthResult;
    reset?: AuthResult;
    redeem?: boolean;
    claim?: AuthResult;
    onSignIn?: () => void;
  } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const auth: AuthClient = {
    signIn: async (input) => {
      calls.push({ method: "signIn", args: [input] });
      const result = options.signIn ?? { ok: true };
      if (result.ok) options.onSignIn?.();
      return result;
    },
    signUp: async (input) => {
      calls.push({ method: "signUp", args: [input] });
      return options.signUp ?? { ok: true };
    },
    signInSocial: async (provider, callbackURL) => {
      calls.push({ method: "signInSocial", args: [provider, callbackURL] });
      return { ok: true };
    },
    requestPasswordReset: async (input) => {
      calls.push({ method: "requestPasswordReset", args: [input] });
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
      return { ok: true };
    },
    desktopRedeem: async (verifier) => {
      calls.push({ method: "desktopRedeem", args: [verifier] });
      return options.redeem ?? false;
    },
    ownerClaim: async (input) => {
      calls.push({ method: "ownerClaim", args: [input] });
      return options.claim ?? { ok: true };
    },
  };
  return { auth, calls };
}
