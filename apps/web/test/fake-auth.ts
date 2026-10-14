import type { AuthClient, AuthResult } from "@/auth/client";

export function createFakeAuth(options: { signIn?: AuthResult; signUp?: AuthResult; onSignIn?: () => void } = {}) {
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
    signOut: async () => {
      calls.push({ method: "signOut", args: [] });
    },
  };
  return { auth, calls };
}
