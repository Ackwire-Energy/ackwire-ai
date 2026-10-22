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
  signInSocial(provider: "google" | "github" | "apple", callbackURL: string): Promise<AuthResult>;
  /** E-mails a link to `redirectTo?token=…` (only when the server can send e-mail: `passwordReset`). */
  requestPasswordReset(input: { email: string; redirectTo: string }): Promise<AuthResult>;
  /** The new password for the link's token; signs out every other session. */
  resetPassword(input: { token: string; newPassword: string }): Promise<AuthResult>;
  signOut(): Promise<void>;
  /** In the browser, after a fresh sign-in: hands it to the Mac app's window waiting on `challenge` (D79). */
  desktopHandoff(challenge: string): Promise<AuthResult>;
  /** In the Mac app's window: true once the browser handed a sign-in over for this verifier (sets the cookie). */
  desktopRedeem(verifier: string): Promise<boolean>;
}
