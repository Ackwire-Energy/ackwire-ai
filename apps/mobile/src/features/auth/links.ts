/** An invitation token from a link: what the server issues (url-safe base64), nothing else. Pure. */
export const isInviteToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(value);

/** An invitation to one address (it joins), or a workspace's invitation link (it only asks, ADR 0068). */
export type InviteKind = "email" | "link";

/** How a remembered invitation is stored: a link's token as `link:<token>`, an email invitation's bare. */
export const storedInvite = (token: string, kind: InviteKind) => (kind === "link" ? `link:${token}` : token);

/**
 * What signing in does with a remembered invitation: an email invitation is accepted; a link's page opens again,
 * where the account asks to join. A bare token (kept by builds from before links asked) is an email invitation;
 * a link's would be refused there and forgotten. Null for nothing, or anything malformed.
 */
export function afterSignIn(stored: string | null): { accept: string } | { open: `/invite/${string}` } | null {
  if (!stored) return null;
  const link = stored.startsWith("link:");
  const token = link ? stored.slice("link:".length) : stored;
  if (!isInviteToken(token)) return null;
  return link ? { open: `/invite/${token}` } : { accept: token };
}
