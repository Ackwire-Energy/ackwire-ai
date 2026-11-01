import { createSign } from "node:crypto";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";

const { githubAppInstallations } = schema;

/**
 * Our GitHub App for git and PRs (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`):
 * short tokens scoped to one repo. The app is public; installations count only
 * for the organization that installed it from agentes.chat
 * (`github_app_installations`, see `github-app-installs.ts`).
 */
export interface GitHubAppConfig {
  appId: string;
  /** PEM (PKCS#1 or PKCS#8). */
  privateKey: string;
  /** `github.com/apps/{slug}`: where organizations install it. */
  slug?: string;
  /** User authorization during installation (proves the installer can see the installation). */
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
}

export interface GitHubHttp {
  fetch: typeof fetch;
  /** `https://api.github.com` (tests: a fake). */
  apiUrl: string;
}

const tokens = new Map<string, { token: string; installationId: number; expiresAt: number }>();

/** Drops cached tokens of an installation (uninstalled, suspended, unbound). */
export function forgetInstallationTokens(installationId: number) {
  for (const [key, value] of tokens) if (value.installationId === installationId) tokens.delete(key);
}

function appJwt(app: GitHubAppConfig, now = Date.now()) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 9 * 60, iss: app.appId })).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(app.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The installation is bound to this organization and not suspended. */
async function boundToOrg(db: Database, orgId: string, installationId: number) {
  const [row] = await db
    .select({ id: githubAppInstallations.id })
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.installationId, installationId),
        eq(githubAppInstallations.orgId, orgId),
        isNull(githubAppInstallations.suspendedAt),
      ),
    );
  return Boolean(row);
}

/** The installations bound to this organization and not suspended, with the account each is on. */
export function boundInstallations(db: Database, orgId: string) {
  return db
    .select({
      installationId: githubAppInstallations.installationId,
      accountLogin: githubAppInstallations.accountLogin,
    })
    .from(githubAppInstallations)
    .where(and(eq(githubAppInstallations.orgId, orgId), isNull(githubAppInstallations.suspendedAt)));
}

/**
 * An installation token for one repository (1 hour, cached until 5 minutes
 * before it expires), only when the repository's installation belongs to
 * this organization. Null otherwise (not installed there, installed by
 * someone else, suspended): the caller falls back to the org's own GitHub
 * connection.
 */
export async function appTokenForRepo(
  app: GitHubAppConfig,
  http: GitHubHttp,
  tenant: { db: Database; orgId: string },
  owner: string,
  repo: string,
  permissions: Record<string, "read" | "write">,
): Promise<string | null> {
  const key = `${tenant.orgId}:${owner}/${repo}:${JSON.stringify(permissions)}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) {
    // The binding can go away before the token expires (unbound, suspended).
    if (await boundToOrg(tenant.db, tenant.orgId, cached.installationId)) return cached.token;
    tokens.delete(key);
    return null;
  }
  const jwt = appJwt(app);
  const headers = {
    authorization: `Bearer ${jwt}`,
    accept: "application/vnd.github+json",
    "user-agent": "agentes.chat",
  };
  const inst = await http.fetch(`${http.apiUrl}/repos/${owner}/${repo}/installation`, { headers });
  if (!inst.ok) return null;
  const { id } = (await inst.json()) as { id?: number };
  if (!id) return null;
  if (!(await boundToOrg(tenant.db, tenant.orgId, id))) return null;
  const res = await http.fetch(`${http.apiUrl}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repositories: [repo], permissions }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) return null;
  tokens.set(key, {
    token: body.token,
    installationId: id,
    expiresAt: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 3600_000,
  });
  return body.token;
}

/**
 * A read-only token for a whole installation of this organization (lists
 * its repositories). Null when the installation isn't bound to the org.
 */
export async function installationReadToken(
  app: GitHubAppConfig,
  http: GitHubHttp,
  tenant: { db: Database; orgId: string },
  installationId: number,
): Promise<string | null> {
  if (!(await boundToOrg(tenant.db, tenant.orgId, installationId))) return null;
  const res = await http.fetch(`${http.apiUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${appJwt(app)}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "agentes.chat",
    },
    body: JSON.stringify({ permissions: { metadata: "read" } }),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { token?: string }).token ?? null;
}
