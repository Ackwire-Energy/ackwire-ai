import { API_URL } from "@/config";
import { authClient, authedFetch } from "@/lib/auth";
import { unregisterPush } from "@/lib/push";
import { clearStoredValues } from "@/lib/storage";
import { type DeleteAccountResult, readDeleteResponse } from "./result";

export type { DeleteAccountResult };

/**
 * Signs out: removes this phone from pushes, ends the session (the Expo plugin clears its stored cookie
 * and session) and forgets the app's remembered values. The session gate then shows sign-in.
 */
export async function signOut(): Promise<void> {
  await unregisterPush({ optOut: false });
  await authClient.signOut().catch(() => {});
  await clearStoredValues();
}

/**
 * Deletes the account (App Store 5.1.1(v)). Refused while the person is the only owner of an organization
 * with other members: `{ ok: false, reason: "sole_owner", organizations }` (say
 * `t("mobile.account.deleteSoleOwner")`). On success the phone is signed out.
 */
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const res = await authedFetch(`${API_URL}/api/app/account`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!res) return { ok: false, reason: "failed", status: 0 };
  const result = await readDeleteResponse(res);
  if (result.ok) {
    await authClient.signOut().catch(() => {});
    await clearStoredValues();
  }
  return result;
}
