import { readValue, readValueSync, STORED, writeValue } from "@/lib/storage";

/**
 * An invitation opened in the app (its link, D88) before the person is signed in: kept until they are in, then
 * accepted (`InviteAcceptor` in the root layout). While it waits, sign-up and the social sign-in send its token
 * (`x-invite-token`), so a closed server lets the invited person create their account.
 */
let pending: string | null = readValueSync(STORED.invite);

export const pendingInvite = () => pending;

export function rememberInvite(token: string) {
  pending = token;
  void writeValue(STORED.invite, token);
}

export function forgetInvite() {
  pending = null;
  void writeValue(STORED.invite, null);
}

/** Read again from storage (the app may have been closed between the link and signing in). */
export async function loadPendingInvite(): Promise<string | null> {
  pending = (await readValue(STORED.invite)) ?? pending;
  return pending;
}

/** The header sign-up requests carry while an invitation waits. */
export const inviteHeaders = (): Record<string, string> => (pending ? { "x-invite-token": pending } : {});

export { isInviteToken } from "./links";
