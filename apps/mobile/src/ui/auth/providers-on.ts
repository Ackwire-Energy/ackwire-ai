import type { SignInProvider } from "@agenteschat/client";

const ORDER: SignInProvider[] = ["apple", "google", "github"];

/**
 * The providers this phone offers to sign in with: the ones the server has configured, or only `only` (the ones an
 * account is linked to). None on iOS for now, where the app signs in by e-mail only: the App Store wants Sign in
 * with Apple beside any other provider's sign-in (its guideline 4.8), so the others wait until ours is on.
 */
export function socialProvidersOn(
  on: Partial<Record<SignInProvider, boolean>> | undefined,
  os: string,
  only?: SignInProvider[],
): SignInProvider[] {
  if (!on || os === "ios") return [];
  return ORDER.filter((p) => on[p] === true && (!only || only.includes(p)));
}
