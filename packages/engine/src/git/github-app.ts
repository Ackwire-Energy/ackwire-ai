import { createSign } from "node:crypto";

/** A GitHub App for git and PRs (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`): short tokens scoped to one repo. */
export interface GitHubAppConfig {
  appId: string;
  /** PEM (PKCS#1 or PKCS#8). */
  privateKey: string;
}

export interface GitHubHttp {
  fetch: typeof fetch;
  /** `https://api.github.com` (tests: a fake). */
  apiUrl: string;
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

function appJwt(app: GitHubAppConfig, now = Date.now()) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 9 * 60, iss: app.appId })).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(app.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * An installation token for one repository (1 hour, cached until 5 minutes
 * before it expires). Null when the app isn't installed there: the caller
 * falls back to the org's GitHub connection.
 */
export async function appTokenForRepo(
  app: GitHubAppConfig,
  http: GitHubHttp,
  owner: string,
  repo: string,
  permissions: Record<string, "read" | "write">,
): Promise<string | null> {
  const key = `${owner}/${repo}:${JSON.stringify(permissions)}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
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
    expiresAt: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 3600_000,
  });
  return body.token;
}
