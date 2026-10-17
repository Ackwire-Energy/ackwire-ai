/** What `DELETE /api/app/account` answered (pure: tested without React Native). */
export type DeleteAccountResult =
  | { ok: true }
  /** The only owner of organizations that have other members: hand them over first. */
  | { ok: false; reason: "sole_owner"; organizations: string[] }
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
  return { ok: false, reason: "failed", status: res.status };
}
