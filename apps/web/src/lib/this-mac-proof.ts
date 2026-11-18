import { safeRedirect } from "@agenteschat/client/lib/guards";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";

/**
 * The desktop app's owner on its own server proves it's them before a deletion by a sign-in in the last 10 minutes
 * (`confirmsOnThisMac`, ADR 0088 §2): this tab notes when its window last traded the app's sign-in, a little under the
 * server's window so a stale note fails toward asking again. The server stays the authority (403 `reauth.sign_in`).
 */
const FRESH_MS = 9.5 * 60_000;
/** As long as the app's one-time sign-in lasts: a way back older than that belongs to no sign-in. */
const RETURN_TTL_MS = 3 * 60_000;

const stampAt = (key: string) => {
  const at = Number(sessionStore.get(key));
  return Number.isFinite(at) && at > 0 ? at : null;
};

/** The window traded the app's sign-in just now (`/desktop/handover`). */
export const notedSignInOnThisMac = () => sessionStore.set(STORAGE_KEYS.thisMacSignedInAt, String(Date.now()));

/** Whether this tab's last sign-in through the app is recent enough to delete with no more proof. */
export function signedInOnThisMacLately(now = Date.now()) {
  const at = stampAt(STORAGE_KEYS.thisMacSignedInAt);
  return at !== null && now - at < FRESH_MS;
}

/** The server said that sign-in is too old: ask for another. */
export const forgetSignInOnThisMac = () => sessionStore.remove(STORAGE_KEYS.thisMacSignedInAt);

/** Before the app signs the window in again: the page `to` come back to (a dialog kept in its address opens again). */
export const saveReturnOnThisMac = (to: string) =>
  sessionStore.set(STORAGE_KEYS.thisMacReturn, JSON.stringify({ to, at: Date.now() }));

/** The page saved by `saveReturnOnThisMac` within its time, taken once; null without one. */
export function takeReturnOnThisMac(now = Date.now()): string | null {
  const raw = sessionStore.get(STORAGE_KEYS.thisMacReturn);
  sessionStore.remove(STORAGE_KEYS.thisMacReturn);
  try {
    const saved = JSON.parse(raw ?? "null") as { to?: unknown; at?: unknown } | null;
    if (typeof saved?.at !== "number" || now - saved.at > RETURN_TTL_MS) return null;
    return safeRedirect(saved.to) ?? null;
  } catch {
    return null;
  }
}
