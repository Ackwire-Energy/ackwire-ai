import { REAUTH_PASSWORD, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";

/** What `DELETE /api/app/account` answered (pure: tested without React Native). */
export type DeleteAccountResult =
  | { ok: true }
  /** The only owner of organizations that have other members: hand them over, or delete them, first. */
  | { ok: false; reason: "sole_owner"; organizations: string[] }
  /** No proof that it's them: no sign-in in the last 10 minutes (`sign_in`), or a wrong password (`password`). */
  | { ok: false; reason: "reauth"; proof: "sign_in" | "password" }
  /** Too many password tries: a few minutes before the next. */
  | { ok: false; reason: "rate_limited" }
  | { ok: false; reason: "failed"; status: number };

export async function readDeleteResponse(res: {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}): Promise<DeleteAccountResult> {
  if (res.ok) return { ok: true };
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  const error = (body as { error?: { code?: unknown; params?: { organizations?: unknown } } } | undefined)?.error;
  if (res.status === 409 && error?.code === "sole_owner") {
    const list = error.params?.organizations;
    return {
      ok: false,
      reason: "sole_owner",
      organizations: Array.isArray(list) ? list.filter((o): o is string => typeof o === "string") : [],
    };
  }
  if (res.status === 403 && (error?.code === REAUTH_SIGN_IN || error?.code === REAUTH_PASSWORD))
    return { ok: false, reason: "reauth", proof: error.code === REAUTH_PASSWORD ? "password" : "sign_in" };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  return { ok: false, reason: "failed", status: res.status };
}
