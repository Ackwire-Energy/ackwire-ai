import { authClient, authedFetch } from "@/lib/auth";
import { SIGN_OUT_WAIT_MS, unregisterPush } from "@/lib/push";
import { serverUrl } from "@/lib/server";
import { clearStoredValues } from "@/lib/storage";
import { type DeleteAccountResult, readDeleteResponse } from "./result";

export type { DeleteAccountResult };

/**
 * Signs out: removes this phone from pushes, ends the session (the Expo plugin clears its stored cookie
 * and session before asking the server) and forgets the app's remembered values. The session gate then
 * shows sign-in.
 */
export async function signOut(): Promise<void> {
  await unregisterPush({ optOut: false });
  await authClient()
    .signOut({ fetchOptions: { timeout: SIGN_OUT_WAIT_MS } })
    .catch(() => {});
  await clearStoredValues();
}

/**
 * Deletes the account (App Store 5.1.1(v)), with `password` when a sign-in in the last 10 minutes doesn't prove
 * it's them (`reason: "reauth"` says which proof is missing). Refused while the person is the only owner of an
 * organization with other members (`sole_owner`). On success the phone is signed out.
 */
export async function deleteAccount(password?: string): Promise<DeleteAccountResult> {
  const res = await authedFetch(`${serverUrl()}/api/app/account`, {
    method: "DELETE",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(password ? { password } : {}),
  }).catch(() => null);
  if (!res) return { ok: false, reason: "failed", status: 0 };
  const result = await readDeleteResponse(res);
  if (result.ok) {
    await authClient()
      .signOut()
      .catch(() => {});
    await clearStoredValues();
  }
  return result;
}
