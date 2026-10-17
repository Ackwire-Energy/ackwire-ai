/** Loose email check for the sign-in screens (the server decides; this only catches obvious typos). */
export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

export const MIN_PASSWORD = 8;

/** Better Auth error → the key of the sentence to show (never the server's raw text). */
export function authErrorKey(
  error: { status?: number; code?: string } | null | undefined,
  kind: "signIn" | "signUp",
): string {
  if (!error) return "mobile.auth.errors.generic";
  const code = (error.code ?? "").toUpperCase();
  if (error.status === 0 || code === "NETWORK_ERROR") return "mobile.auth.errors.network";
  if (kind === "signIn" && (error.status === 401 || code.includes("INVALID"))) return "mobile.auth.signIn.wrong";
  if (kind === "signUp" && (code.includes("ALREADY_EXISTS") || code.includes("USER_EXISTS") || error.status === 422))
    return "mobile.auth.signUp.taken";
  if (kind === "signUp" && error.status === 403) return "mobile.auth.signUp.closed";
  return "mobile.auth.errors.generic";
}
