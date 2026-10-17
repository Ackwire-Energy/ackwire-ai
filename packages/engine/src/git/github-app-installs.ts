import { createHmac, timingSafeEqual } from "node:crypto";
import type { KeyWrapper } from "@agenteschat/adapters";
import { and, asc, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { OAUTH_STATE_TTL_MS } from "../connectors/connections";
import { randomToken, sealSecret, sha256 } from "../crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission } from "../organizations";
import { forgetInstallationTokens, type GitHubAppConfig, type GitHubHttp } from "./github-app";

const { githubAppInstallations, oauthStates } = schema;

/** `oauth_states.connector` of the install flow (no PKCE: the install link carries none). */
export const GITHUB_APP_STATE = "github_app";

export type GitHubAppInstallation = typeof githubAppInstallations.$inferSelect;

export interface GitHubAppInstallDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
  app: GitHubAppConfig | null;
  /** GitHub's REST API; the OAuth code exchange goes to `webUrl` (tests: fakes). */
  http?: GitHubHttp & { webUrl?: string };
  now?: () => Date;
}

export const githubAppCallbackUri = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/app/github-app/callback`;

/** Public view of a binding. */
export const githubAppInstallationView = (i: GitHubAppInstallation) => ({
  id: i.id,
  installationId: i.installationId,
  accountLogin: i.accountLogin,
  accountType: i.accountType,
  repositorySelection: i.repositorySelection,
  suspended: i.suspendedAt !== null,
  createdAt: i.createdAt.toISOString(),
});

const http = (deps: GitHubAppInstallDeps) => ({
  fetch: deps.http?.fetch ?? fetch,
  apiUrl: deps.http?.apiUrl ?? "https://api.github.com",
  webUrl: deps.http?.webUrl ?? "https://github.com",
});

function installable(app: GitHubAppConfig | null): app is GitHubAppConfig & {
  slug: string;
  clientId: string;
  clientSecret: string;
} {
  return Boolean(app?.slug && app.clientId && app.clientSecret);
}

/**
 * Starts installing the GitHub App for an organization (admins). Returns
 * GitHub's install URL; its `state` is random, single use, 10 minutes, bound
 * to this person and organization (only its hash is stored).
 */
export async function startGitHubAppInstall(
  deps: GitHubAppInstallDeps,
  actorId: string,
  orgId: string,
  options: { returnTo?: string } = {},
): Promise<{ installUrl: string; state: string }> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  if (!installable(deps.app)) throw new ValidationError("The GitHub App is not configured on this server");
  const returnTo = options.returnTo?.startsWith("/") && !options.returnTo.startsWith("//") ? options.returnTo : "/";
  const state = randomToken(32);
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  // `oauth_states` requires a sealed verifier; this flow has none, so a random one stands in.
  const sealed = await sealSecret(wrapper, randomToken(16), `oauth-state|${orgId}|${id}`);
  await deps.db.insert(oauthStates).values({
    id,
    orgId,
    connector: GITHUB_APP_STATE,
    userId: actorId,
    stateHash: sha256(state),
    verifierCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    returnTo,
    expiresAt: new Date((deps.now?.() ?? new Date()).getTime() + OAUTH_STATE_TTL_MS),
  });
  const url = new URL(`${http(deps).webUrl}/apps/${encodeURIComponent(deps.app.slug)}/installations/new`);
  url.searchParams.set("state", state);
  return { installUrl: url.toString(), state };
}

interface UserInstallation {
  id: number;
  account?: { login?: string; type?: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
}

/** Installations of our app the person can see on GitHub (their user token). */
async function userInstallations(h: ReturnType<typeof http>, token: string): Promise<UserInstallation[]> {
  const found: UserInstallation[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await h.fetch(`${h.apiUrl}/user/installations?per_page=100&page=${page}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "agentes.chat",
      },
    });
    if (!res.ok) throw new ValidationError(`GitHub refused to list installations (${res.status})`);
    const body = (await res.json()) as { installations?: UserInstallation[] };
    const list = body.installations ?? [];
    found.push(...list);
    if (list.length < 100) break;
  }
  return found;
}

/**
 * GitHub's redirect after installing (user authorization during installation
 * on): checks the state (exists, unused, not expired, same person, still an
 * admin), exchanges the code for the person's token and requires the
 * installation to be one they can see — so nobody can claim another
 * account's installation by its id. Then binds it to the organization;
 * an installation bound to another organization is refused.
 */
export async function completeGitHubAppInstall(
  deps: GitHubAppInstallDeps,
  user: { id: string },
  input: { state: string; code: string; installationId: number },
): Promise<{ installation: GitHubAppInstallation; returnTo: string }> {
  if (!installable(deps.app)) throw new ValidationError("The GitHub App is not configured on this server");
  const at = deps.now?.() ?? new Date();
  const [row] = await deps.db
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.stateHash, sha256(input.state)), eq(oauthStates.connector, GITHUB_APP_STATE)));
  if (!row || row.usedAt || row.expiresAt <= at) throw new ConflictError("This install link is invalid or expired");
  if (row.userId !== user.id) throw new ForbiddenError("Finish installing with the account that started it");
  const claimed = await deps.db
    .update(oauthStates)
    .set({ usedAt: at })
    .where(and(eq(oauthStates.id, row.id), isNull(oauthStates.usedAt)))
    .returning({ id: oauthStates.id });
  if (claimed.length === 0) throw new ConflictError("This install link was already used");
  await requirePermission(deps.db, user.id, row.orgId, "manage_connectors");

  const h = http(deps);
  const res = await h.fetch(`${h.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: deps.app.clientId,
      client_secret: deps.app.clientSecret,
      code: input.code,
    }).toString(),
  });
  const token = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !token.access_token) {
    throw new ValidationError(`GitHub refused the authorization: ${token.error ?? res.status}`);
  }
  const seen = (await userInstallations(h, token.access_token)).find((i) => i.id === input.installationId);
  if (!seen) throw new ForbiddenError("This installation isn't visible to your GitHub account");

  const values = {
    accountLogin: seen.account?.login ?? "",
    accountType: seen.account?.type ?? "User",
    repositorySelection: seen.repository_selection ?? "selected",
    suspendedAt: seen.suspended_at ? new Date(seen.suspended_at) : null,
    updatedAt: at,
  };
  const installation = await deps.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, input.installationId))
      .for("update");
    if (existing && existing.orgId !== row.orgId) {
      throw new ConflictError("This GitHub installation is already connected to another organization");
    }
    const [saved] = existing
      ? await tx
          .update(githubAppInstallations)
          .set(values)
          .where(eq(githubAppInstallations.id, existing.id))
          .returning()
      : await tx
          .insert(githubAppInstallations)
          .values({ ...values, orgId: row.orgId, installationId: input.installationId, createdByUserId: user.id })
          .returning();
    if (!saved) throw new Error("installation not saved");
    await recordAudit(tx, {
      orgId: row.orgId,
      actor: { type: "person", id: user.id },
      action: existing ? "github_app.updated" : "github_app.installed",
      target: { type: "github_app_installation", id: saved.id },
      details: { installationId: input.installationId, account: values.accountLogin },
    });
    return saved;
  });
  forgetInstallationTokens(input.installationId);
  return { installation, returnTo: row.returnTo };
}

export async function listGitHubAppInstallations(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  return db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.orgId, orgId))
    .orderBy(asc(githubAppInstallations.createdAt));
}

/** Unbinds an installation from the organization (admins). It stays installed on GitHub. */
export async function removeGitHubAppInstallation(db: Database, actorId: string, orgId: string, id: string) {
  await requirePermission(db, actorId, orgId, "manage_connectors");
  const [removed] = await db
    .delete(githubAppInstallations)
    .where(and(eq(githubAppInstallations.id, id), eq(githubAppInstallations.orgId, orgId)))
    .returning();
  if (!removed) throw new NotFoundError("Installation not found");
  forgetInstallationTokens(removed.installationId);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "github_app.removed",
    target: { type: "github_app_installation", id },
    details: { installationId: removed.installationId, account: removed.accountLogin },
  });
}

// ── Webhook (`POST /api/github-app/webhook`) ────────────────────────────────

/** `X-Hub-Signature-256: sha256=<hmac>` over the raw body, compared in constant time. */
export function validGitHubAppSignature(secret: string, body: string, given: string | null) {
  if (!given) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`);
  const actual = Buffer.from(given.trim());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Keeps bindings in step with GitHub: `installation` deleted → unbound;
 * suspend/unsuspend → `suspended_at`; `installation_repositories` →
 * repository selection. Installations nobody bound are ignored (they only
 * bind through the install flow). Returns what changed, for the response.
 */
export async function handleGitHubAppWebhook(
  db: Database,
  event: string | null,
  payload: Record<string, unknown>,
  now: Date = new Date(),
): Promise<"removed" | "suspended" | "unsuspended" | "updated" | "ignored"> {
  const installation = payload.installation as { id?: unknown; repository_selection?: unknown } | undefined;
  const id = typeof installation?.id === "number" ? installation.id : null;
  if (id === null) return "ignored";
  const [bound] = await db.select().from(githubAppInstallations).where(eq(githubAppInstallations.installationId, id));
  if (!bound) return "ignored";
  const action = payload.action;
  const where = eq(githubAppInstallations.id, bound.id);
  const audit = (what: string) =>
    recordAudit(db, {
      orgId: bound.orgId,
      actor: { type: "system", id: null },
      action: `github_app.${what}`,
      target: { type: "github_app_installation", id: bound.id },
      details: { installationId: id, account: bound.accountLogin },
    });

  if (event === "installation" && action === "deleted") {
    await db.delete(githubAppInstallations).where(where);
    forgetInstallationTokens(id);
    await audit("uninstalled");
    return "removed";
  }
  if (event === "installation" && (action === "suspend" || action === "unsuspend")) {
    await db
      .update(githubAppInstallations)
      .set({ suspendedAt: action === "suspend" ? now : null, updatedAt: now })
      .where(where);
    forgetInstallationTokens(id);
    await audit(action === "suspend" ? "suspended" : "unsuspended");
    return action === "suspend" ? "suspended" : "unsuspended";
  }
  if (event === "installation_repositories" || (event === "installation" && action === "new_permissions_accepted")) {
    const selection = installation?.repository_selection;
    if (typeof selection === "string") {
      await db.update(githubAppInstallations).set({ repositorySelection: selection, updatedAt: now }).where(where);
    }
    forgetInstallationTokens(id);
    return "updated";
  }
  return "ignored";
}
