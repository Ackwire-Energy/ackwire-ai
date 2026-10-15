import { gunzipSync } from "node:zlib";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { connectorScope } from "../connectors/catalog";
import { type ConnectorDeps, connectionHeaders } from "../connectors/connections";
import { CONNECTOR_ALL, freshGrantedKeys, grantKey } from "../tools/scopes";
import { verifyGitToken } from "./credential";
import { appTokenForRepo, type GitHubAppConfig } from "./github-app";
import { parseReceivePackRequest, pkt, type RefCommand, readPack, walkToOld, ZERO_OID } from "./pack";

const { sandboxes, agents, connectorConnections } = schema;

export const GIT_SCOPES = {
  read: connectorScope("github", "git.read"),
  write: connectorScope("github", "git.write"),
  /** `github:git.repo:owner/name` (or `owner/*`): when an agent has any, only those repositories. */
  repoPrefix: connectorScope("github", "git.repo:"),
};

export const GIT_LIMITS = {
  /** A push request (commands + pack). */
  pushBytes: 100 * 1024 * 1024,
  /** What one fetch/clone may download through us. */
  fetchBytes: 2 * 1024 * 1024 * 1024,
  /** Wants/haves of a fetch. */
  fetchRequestBytes: 10 * 1024 * 1024,
  maxObjects: 500_000,
};

export interface GitProxyDeps {
  db: Database;
  /** AGENTES_SECRET: the proxy credentials are HMACs derived from it. */
  secret: string;
  connectors: ConnectorDeps;
  /** GitHub (tests: a fake upstream). */
  upstream?: { gitUrl: string; apiUrl: string; fetch: typeof fetch };
  /** Preferred over the connection's token when the app is installed on the repo. */
  app?: GitHubAppConfig | null;
  limits?: Partial<typeof GIT_LIMITS>;
  now?: () => Date;
}

type Service = "git-upload-pack" | "git-receive-pack";

const text = (status: number, message: string, extra: Record<string, string> = {}) =>
  new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", ...extra } });

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** `owner/repo(.git)/(info/refs|git-upload-pack|git-receive-pack)` → its parts, or null. */
export function parseGitPath(path: string) {
  const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  const [, owner, repo, action] = m as unknown as [string, string, string, string];
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo, action };
}

/** What an agent may do with git on a connection: its git scopes, or "every tool of this connection". */
export function gitAccess(keys: Set<string>, connectionId: string) {
  const all = keys.has(grantKey(connectionId, CONNECTOR_ALL));
  const write = all || keys.has(grantKey(connectionId, GIT_SCOPES.write));
  return { read: write || keys.has(grantKey(connectionId, GIT_SCOPES.read)), write };
}

function repoAllowed(keys: Set<string>, connectionId: string, owner: string, repo: string) {
  const prefix = grantKey(connectionId, GIT_SCOPES.repoPrefix);
  const listed = [...keys].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).toLowerCase());
  if (listed.length === 0) return true;
  const full = `${owner}/${repo}`.toLowerCase();
  return listed.some((p) => p === full || (p.endsWith("/*") && p.slice(0, -2) === owner.toLowerCase()));
}

/** Why a push command is refused, or null. Only `agentes/{handle}/*` branches, no tags, no deletes. */
export function refRule(cmd: RefCommand, handle: string): string | null {
  if (cmd.ref.startsWith("refs/tags/")) return "tags can't be pushed by agents";
  if (
    !cmd.ref.startsWith(`refs/heads/agentes/${handle}/`) ||
    cmd.ref.length <= `refs/heads/agentes/${handle}/`.length
  ) {
    return `agents push only to branches agentes/${handle}/…`;
  }
  if (cmd.newOid === ZERO_OID) return "branches can't be deleted by agents";
  return null;
}

/** The report git shows for a refused push (report-status, inside side-band when asked). */
function refusal(commands: RefCommand[], reasons: Map<string, string>, capabilities: string[]) {
  let report = pkt("unpack ok\n");
  for (const c of commands) {
    const reason = reasons.get(c.ref) ?? "refused with the rest of the push (atomic)";
    report += pkt(`ng ${c.ref} ${reason}\n`);
  }
  report += "0000";
  const sideband = capabilities.includes("side-band-64k") || capabilities.includes("side-band");
  let body = report;
  if (sideband) {
    const human = [...reasons.values()].map((r) => pkt(`\x02agentes: ${r}\n`)).join("");
    body = `${human}${pkt(`\x01${report}`)}0000`;
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
  });
}

/** A body that errors after `max` bytes (a clone bigger than we allow stops). */
function capped(body: ReadableStream<Uint8Array>, max: number) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error("download larger than the limit"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

async function readBody(req: Request, max: number) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > max) return null;
  if ((req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip") {
    const plain = new Uint8Array(gunzipSync(raw, { maxOutputLength: max }));
    return plain;
  }
  return raw;
}

/**
 * Smart-HTTP git for agents' computers (D35): `/api/git/{orgId}/{connectionId}/{owner}/{repo}.git/…`.
 * - The computer authenticates with our short-lived per-computer credential.
 * - Policy is checked here: the agent's `github:git.read` / `github:git.write`
 *   grants on that connection (and repo list, when set); pushes only to
 *   `agentes/{handle}/*`, fast-forward only, no tags or deletes; size limits.
 * - The request goes to GitHub with the org's token added here (a GitHub App
 *   installation token when configured), never logged, never sent back.
 * - Fetches and pushes are audited.
 */
export async function handleGitProxy(
  deps: GitProxyDeps,
  req: Request,
  params: { orgId: string; connectionId: string; path: string },
): Promise<Response> {
  const limits = { ...GIT_LIMITS, ...deps.limits };
  const parsed = parseGitPath(params.path);
  if (!parsed) return text(404, "agentes: not a git repository path");
  const url = new URL(req.url);
  const service: Service | null =
    parsed.action === "info/refs"
      ? ((url.searchParams.get("service") as Service | null) ?? null)
      : (parsed.action as Service);
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return text(403, "agentes: only smart HTTP (upload-pack / receive-pack) is supported");
  }
  if (parsed.action !== "info/refs" && req.method !== "POST") return text(405, "method not allowed");

  // 1. Who: our credential (git sends it as the password of HTTP Basic).
  const auth = req.headers.get("authorization") ?? "";
  const basic = /^Basic\s+(.+)$/i.exec(auth);
  const password = basic
    ? Buffer.from(basic[1] as string, "base64")
        .toString("utf8")
        .split(":")
        .slice(1)
        .join(":")
    : "";
  const now = deps.now?.() ?? new Date();
  const claims = password ? verifyGitToken(deps.secret, password, now) : null;
  if (!claims || claims.orgId !== params.orgId) {
    return text(401, "agentes: sign in with the computer's git credential", {
      "www-authenticate": 'Basic realm="agentes git"',
    });
  }
  const [computer] = await deps.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.id, claims.sandboxId), eq(sandboxes.orgId, claims.orgId), isNull(sandboxes.deletedAt)));
  if (!computer || computer.agentId !== claims.agentId || computer.gitTokenGen !== claims.gen) {
    return text(401, "agentes: this credential was revoked", { "www-authenticate": 'Basic realm="agentes git"' });
  }
  const [agent] = await deps.db
    .select({ id: agents.id, handle: agents.handle, archivedAt: agents.archivedAt })
    .from(agents)
    .where(and(eq(agents.id, claims.agentId), eq(agents.orgId, claims.orgId)));
  if (!agent || agent.archivedAt) return text(403, "agentes: this agent is archived");

  // 2. Which GitHub connection, and what this agent may do with it.
  const [connection] = await deps.db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, params.connectionId),
        eq(connectorConnections.orgId, claims.orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (connection?.connector !== "github") return text(404, "agentes: GitHub is not connected in this organization");
  const keys = await freshGrantedKeys(deps.db, claims.orgId, claims.agentId);
  const { read: canRead, write: canWrite } = gitAccess(keys, connection.id);
  const repoName = `${parsed.owner}/${parsed.repo}`;
  if (!canRead) return text(403, `agentes: ${agent.handle} has no git access to GitHub (scope github:git.read)`);
  if (!repoAllowed(keys, connection.id, parsed.owner, parsed.repo)) {
    return text(403, `agentes: ${agent.handle} may not use ${repoName}`);
  }
  if (service === "git-receive-pack" && !canWrite) {
    return text(403, `agentes: ${agent.handle} can't push (scope github:git.write)`);
  }

  // 3. GitHub's credential, added here only.
  const upstream = deps.upstream ?? { gitUrl: "https://github.com", apiUrl: "https://api.github.com", fetch };
  const write = service === "git-receive-pack";
  const appToken = deps.app
    ? await appTokenForRepo(
        deps.app,
        { fetch: upstream.fetch, apiUrl: upstream.apiUrl },
        parsed.owner,
        parsed.repo,
        write ? { contents: "write" } : { contents: "read" },
      ).catch(() => null)
    : null;
  const bearer =
    appToken ??
    (
      await connectionHeaders(deps.connectors, connection).catch(() => ({}) as Record<string, string>)
    ).authorization?.replace(/^Bearer\s+/i, "");
  if (!bearer) return text(502, "agentes: the organization's GitHub connection has no usable token");
  const upstreamAuth = `Basic ${Buffer.from(`x-access-token:${bearer}`).toString("base64")}`;
  const target = `${upstream.gitUrl}/${parsed.owner}/${parsed.repo}.git/${parsed.action}${url.search}`;
  const forward = (body?: Uint8Array) => {
    const headers: Record<string, string> = { authorization: upstreamAuth, "user-agent": "git/agentes-proxy" };
    for (const h of ["content-type", "accept", "git-protocol"]) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    return upstream.fetch(target, { method: req.method, headers, body, redirect: "manual" });
  };
  const relay = async (res: Response, max: number) => {
    if (res.status === 401 || res.status === 403) {
      return text(502, "agentes: GitHub refused the organization's credential for this repository");
    }
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    const type = res.headers.get("content-type");
    if (type) headers["content-type"] = type;
    return new Response(res.body ? capped(res.body, max) : null, { status: res.status, headers });
  };

  if (parsed.action === "info/refs") return relay(await forward(), limits.fetchBytes);

  if (service === "git-upload-pack") {
    const body = await readBody(req, limits.fetchRequestBytes);
    if (!body) return text(413, "agentes: fetch request too large");
    const res = await forward(body);
    if (res.ok) {
      await recordAudit(deps.db, {
        orgId: claims.orgId,
        actor: { type: "agent", id: claims.agentId },
        action: "git.fetch",
        target: { type: "git_repo", id: repoName },
        details: { connectionId: connection.id, sandboxId: computer.id },
      }).catch(() => undefined);
    }
    return relay(res, limits.fetchBytes);
  }

  // 4. A push: read it whole, check every command and the pack, then send it.
  const body = await readBody(req, limits.pushBytes);
  if (!body) return text(413, `agentes: push larger than ${Math.round(limits.pushBytes / 1024 / 1024)} MB`);
  let request: ReturnType<typeof parseReceivePackRequest>;
  try {
    request = parseReceivePackRequest(body);
  } catch {
    return text(400, "agentes: unreadable push");
  }
  const reasons = new Map<string, string>();
  for (const cmd of request.commands) {
    const why = refRule(cmd, agent.handle);
    if (why) reasons.set(cmd.ref, why);
  }
  let commits = 0;
  if (reasons.size === 0) {
    let pack: ReturnType<typeof readPack>;
    try {
      pack = readPack(body, request.packStart, { maxObjects: limits.maxObjects });
    } catch {
      return text(400, "agentes: unreadable pack");
    }
    commits = pack.commits.length;
    for (const cmd of request.commands) {
      if (cmd.oldOid === ZERO_OID) continue;
      // Fast-forward only: the new tip must descend from the old one.
      const walk = walkToOld(pack.commits, cmd.oldOid, cmd.newOid);
      let ok = walk.reached;
      for (const oid of walk.outside.slice(0, 5)) {
        if (ok) break;
        const res = await upstream
          .fetch(`${upstream.apiUrl}/repos/${parsed.owner}/${parsed.repo}/compare/${cmd.oldOid}...${oid}`, {
            headers: {
              authorization: `Bearer ${bearer}`,
              accept: "application/vnd.github+json",
              "user-agent": "agentes.chat",
            },
          })
          .catch(() => null);
        const status = res?.ok ? ((await res.json()) as { status?: string }).status : undefined;
        ok = status === "ahead" || status === "identical";
      }
      if (!ok) reasons.set(cmd.ref, "not a fast-forward (force pushes are not allowed)");
    }
  }
  if (reasons.size > 0) {
    await recordAudit(deps.db, {
      orgId: claims.orgId,
      actor: { type: "agent", id: claims.agentId },
      action: "git.push_refused",
      target: { type: "git_repo", id: repoName },
      details: { refs: request.commands.map((c) => c.ref), reasons: Object.fromEntries(reasons) },
    }).catch(() => undefined);
    return refusal(request.commands, reasons, request.capabilities);
  }
  const res = await forward(body);
  if (res.ok) {
    await recordAudit(deps.db, {
      orgId: claims.orgId,
      actor: { type: "agent", id: claims.agentId },
      action: "git.push",
      target: { type: "git_repo", id: repoName },
      details: {
        connectionId: connection.id,
        sandboxId: computer.id,
        refs: request.commands.map((c) => ({ ref: c.ref, from: c.oldOid, to: c.newOid })),
        commits,
      },
    }).catch(() => undefined);
  }
  return relay(res, limits.fetchBytes);
}
