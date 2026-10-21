import type { ServerProblem } from "@agenteschat/client/lib/server";
import { signOut } from "@/features/account";
import { authClient } from "@/lib/auth";
import { serverUrl, setServer } from "@/lib/server";
import { connectPlan } from "@/lib/server-choice";

/** Why a server can't be used, in the person's words (each takes `{ host }`). */
export const PROBLEM_TEXT: Record<ServerProblem, string> = {
  unreachable: "mobile.auth.server.unreachable",
  certificate: "mobile.auth.server.certificate",
  "not-agentes": "mobile.auth.server.notAgentes",
  "server-too-old": "mobile.auth.server.serverTooOld",
  "app-too-old": "mobile.auth.server.appTooOld",
};

/**
 * Moves the app to `target.server`, signing out of the current one first so nothing crosses servers, and
 * signs in there with the one-time token from the web app's QR code, when there is one. False when the
 * token was refused (expired or already used).
 */
export async function connectToServer(target: { server: string; token?: string }, signedIn: boolean) {
  const plan = connectPlan(serverUrl(), signedIn, target);
  if (plan.signOut) await signOut();
  if (plan.move) await setServer(target.server);
  if (!plan.token) return true;
  const res = await authClient()
    .$fetch("/sign-in/one-time-token", { method: "POST", body: { token: plan.token } })
    .catch(() => null);
  return Boolean(res && !res.error);
}
