import { earlyAccessToken } from "@agenteschat/client/lib/guards";

/** An invitation token from a link: what the server issues (url-safe base64), nothing else. Pure. */
export const isInviteToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(value);

/**
 * Where an early-access email's link (`/signup?email=&access=`, ADR 0078) goes in the app: Criar conta with its
 * address and token, or the app when signed in. Null while the session is still being read: until then the root
 * gate sends any `(auth)` screen to the app's side, and from there to Entrar, without the token.
 */
export function signUpLinkTarget(
  session: { pending: boolean; signedIn: boolean },
  params: { email?: unknown; access?: unknown },
): "/" | { pathname: "/sign-up"; params: { email?: string; access?: string } } | null {
  if (session.pending) return null;
  if (session.signedIn) return "/";
  const access = earlyAccessToken(params.access);
  return {
    pathname: "/sign-up",
    params: { ...(typeof params.email === "string" ? { email: params.email } : {}), ...(access ? { access } : {}) },
  };
}

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
  const invite = storedInviteOf(stored);
  if (!invite) return null;
  return invite.kind === "link" ? { open: `/invite/${invite.token}` } : { accept: invite.token };
}

/** A remembered invitation read back: its token and kind; null for nothing, or anything malformed. */
export function storedInviteOf(stored: string | null): { token: string; kind: InviteKind } | null {
  if (!stored) return null;
  const link = stored.startsWith("link:");
  const token = link ? stored.slice("link:".length) : stored;
  return isInviteToken(token) ? { token, kind: link ? "link" : "email" } : null;
}

/**
 * Where a sign-in leads, said in place of its general line (the web's `signInFor`): asking to join a workspace through
 * its link, or joining it by an invitation. The phone's sign-in leads nowhere else. Null with no invitation waiting,
 * or one that no longer works.
 */
export function signInPurpose(
  invitation: { orgName: string; kind?: InviteKind; closed?: true } | null | undefined,
): { key: "auth.flow.toAsk" | "auth.flow.toJoin"; org: string } | null {
  if (!invitation || invitation.closed) return null;
  return { key: invitation.kind === "link" ? "auth.flow.toAsk" : "auth.flow.toJoin", org: invitation.orgName };
}

/**
 * A translated sentence with its label in `<b>…</b>` ("<b>Their note:</b> “…”"), as parts to draw: the bold
 * ones and the rest, in order. Run on the sentence before anyone's words go in, so those are never read as markup.
 */
export function boldParts(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/<b>([^<]*)<\/b>/)
    .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
    .filter((part) => part.text !== "");
}
