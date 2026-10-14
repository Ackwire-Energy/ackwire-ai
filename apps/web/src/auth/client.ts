/**
 * Sign-in for people (Better Auth at `/api/auth/*`, same origin, HttpOnly
 * session cookie: nothing auth-related is stored in JavaScript). Pages use
 * this interface; `better-auth.ts` implements it and tests pass a fake.
 */
export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

export interface AuthClient {
  signIn(input: { email: string; password: string }): Promise<AuthResult>;
  signUp(input: { name: string; email: string; password: string }): Promise<AuthResult>;
  /** Redirects the browser to the provider; comes back to `callbackURL`. */
  signInSocial(provider: "google" | "github", callbackURL: string): Promise<AuthResult>;
  signOut(): Promise<void>;
}
