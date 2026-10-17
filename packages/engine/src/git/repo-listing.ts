import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { activeConnections, type ConnectorDeps, connectionHeaders } from "../connectors/connections";
import { requirePermission } from "../organizations";
import { type GitHubAppConfig, type GitHubHttp, installationReadToken } from "./github-app";

const { githubAppInstallations } = schema;

export interface GitHubRepositoryView {
  /** `owner/name`, as GitHub spells it. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  /** Last push (or update), ISO; null when GitHub didn't say. */
  updatedAt: string | null;
}

export interface GitHubAccountView {
  login: string;
  /** GitHub's `Organization` or `User`. */
  type: string;
  repositories: GitHubRepositoryView[];
}

/** The repositories the organization's GitHub reaches, by account. Never carries a token. */
export interface OrgRepositoryListing {
  /** GitHub is connected (a connection, or the app installed on some account). */
  connected: boolean;
  accounts: GitHubAccountView[];
  /** GitHub had more than we read (very large accounts). */
  truncated: boolean;
}

export interface RepoListingDeps {
  db: Database;
  connectors: ConnectorDeps;
  app?: GitHubAppConfig | null;
  /** GitHub's REST API (tests: a fake). */
  github?: GitHubHttp;
  now?: () => number;
}

const TTL_MS = 60_000;
/** Pages of 100 read per source (connection, each installation). */
const MAX_PAGES = 5;
const cache = new Map<string, { at: number; value: OrgRepositoryListing }>();

/** Drops an organization's cached listing (a connection or an installation changed). */
export function forgetOrgRepositories(orgId: string) {
  cache.delete(orgId);
}

interface GitHubRepo {
  full_name?: string;
  name?: string;
  private?: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
  owner?: { login?: string; type?: string };
}

/**
 * `GET …/github/repositories`: what the org's GitHub connection sees
 * (`/user/repos`) plus the repositories of the GitHub App installations
 * bound to it (`/installation/repositories`), merged by account. Cached for
 * a minute per organization; tokens stay on the server.
 */
export async function listOrgRepositories(
  deps: RepoListingDeps,
  actorId: string,
  orgId: string,
): Promise<OrgRepositoryListing> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const now = deps.now?.() ?? Date.now();
  const hit = cache.get(orgId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  const found = new Map<string, GitHubRepo>();
  let truncated = false;
  const read = async (token: string, path: (page: number) => string, pick: (body: unknown) => GitHubRepo[]) => {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await github.fetch(`${github.apiUrl}${path(page)}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "agentes.chat",
        },
      });
      if (!res.ok) return;
      const repos = pick(await res.json().catch(() => null));
      for (const r of repos) if (r.full_name) found.set(r.full_name.toLowerCase(), r);
      if (repos.length < 100) return;
      if (page === MAX_PAGES) truncated = true;
    }
  };

  const connection = (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
  if (connection) {
    const auth = (await connectionHeaders(deps.connectors, connection).catch(() => ({}) as Record<string, string>))
      .authorization;
    const token = auth?.replace(/^Bearer\s+/i, "");
    if (token) {
      await read(
        token,
        (page) =>
          `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        (body) => (Array.isArray(body) ? (body as GitHubRepo[]) : []),
      ).catch(() => {});
    }
  }
  const installations = deps.app
    ? await deps.db
        .select({ installationId: githubAppInstallations.installationId })
        .from(githubAppInstallations)
        .where(and(eq(githubAppInstallations.orgId, orgId), isNull(githubAppInstallations.suspendedAt)))
    : [];
  for (const i of installations) {
    if (!deps.app) break;
    const token = await installationReadToken(deps.app, github, { db: deps.db, orgId }, i.installationId).catch(
      () => null,
    );
    if (!token) continue;
    await read(
      token,
      (page) => `/installation/repositories?per_page=100&page=${page}`,
      (body) => (body as { repositories?: GitHubRepo[] } | null)?.repositories ?? [],
    ).catch(() => {});
  }

  const accounts = new Map<string, GitHubAccountView>();
  for (const r of found.values()) {
    const [owner = "", name = r.name ?? ""] = (r.full_name ?? "").split("/");
    const key = owner.toLowerCase();
    const account = accounts.get(key) ?? {
      login: r.owner?.login ?? owner,
      type: r.owner?.type ?? "User",
      repositories: [],
    };
    account.repositories.push({
      fullName: r.full_name ?? `${owner}/${name}`,
      owner: account.login,
      name,
      private: r.private === true,
      updatedAt: r.pushed_at ?? r.updated_at ?? null,
    });
    accounts.set(key, account);
  }
  const recent = (a: GitHubRepositoryView, b: GitHubRepositoryView) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name);
  const value: OrgRepositoryListing = {
    connected: Boolean(connection) || installations.length > 0,
    accounts: [...accounts.values()]
      .map((a) => ({ ...a, repositories: a.repositories.sort(recent) }))
      // Organizations first, then people; by name.
      .sort(
        (a, b) =>
          Number(a.type !== "Organization") - Number(b.type !== "Organization") || a.login.localeCompare(b.login),
      ),
    truncated,
  };
  cache.set(orgId, { at: now, value });
  return value;
}
