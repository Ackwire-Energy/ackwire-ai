import { readValue, readValueSync, STORED, writeValue } from "@/lib/storage";
import { afterSignIn, type InviteKind, storedInvite, storedInviteOf } from "./links";

/**
 * An invitation opened in the app before the person is signed in, kept until they are in (the root layout's
 * `useAcceptPendingInvite`, through `afterSignIn`). Kept in memory too: signing out to switch accounts clears what
 * the app stored.
 */
let pending: string | null = null;

export function rememberInvite(token: string, kind: InviteKind) {
  pending = storedInvite(token, kind);
  void writeValue(STORED.invite, pending);
}

export function forgetInvite() {
  pending = null;
  void writeValue(STORED.invite, null);
}

/** Read again from storage (the app may have been closed between the link and signing in). */
export async function loadPendingInvite() {
  pending = (await readValue(STORED.invite)) ?? pending;
  return afterSignIn(pending);
}

/** The invitation this sign-in leads to, if one waits (the sign-in says so): what was opened, or what was stored. */
export const pendingInvite = () => storedInviteOf(pending ?? readValueSync(STORED.invite));
