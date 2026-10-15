import { connectorScope } from "../connectors/catalog";
import { activeConnections, type ConnectorDeps, connectionHeaders } from "../connectors/connections";
import { SANDBOX_SCOPE, type SandboxDeps, truncateOutput, withSandbox } from "../sandbox";
import { grantedScopeKeys, grantKey } from "../tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { appTokenForRepo, type GitHubAppConfig } from "./github-app";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/;

/** "owner/name", "https://github.com/owner/name(.git)" → { owner, repo } or null. */
export function parseRepo(input: string) {
  const s = input
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\/$/, "");
  const m = REPO.exec(s);
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

export interface GitToolDeps {
  sandbox: SandboxDeps;
  connectors: ConnectorDeps;
  app?: GitHubAppConfig | null;
  /** GitHub's REST API (tests: a fake). */
  github?: { apiUrl: string; fetch: typeof fetch };
}

/**
 * Git in the agent's computer (D35), through our proxy:
 * - `git_clone` (`github:git.read`): `git clone https://github.com/owner/repo`
 *   in the workspace; pushes from there go through the proxy too;
 * - `open_pull_request` (`github:pr.write`): opens a PR from a pushed branch
 *   with the org's GitHub credential (server side). Merging stays approval-gated.
 * Offered only when GitHub is connected in the organization.
 */
export function createGitToolSource(deps: GitToolDeps): ToolSource {
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  return {
    name: "git",
    async tools(ctx: ToolContext): Promise<ToolDefinition[]> {
      const connection = (await activeConnections(ctx.db, ctx.orgId)).find((c) => c.connector === "github");
      if (!connection) return [];
      const repoInput = { type: "string", minLength: 3, maxLength: 200, description: "owner/name" };
      return [
        {
          name: "git_clone",
          description:
            "Clone a GitHub repository into your computer's workspace (real git: commit and push from there; push only to branches agentes/<your handle>/…, then open_pull_request).",
          scope: connectorScope("github", "git.read"),
          connectionId: connection.id,
          connectorLabel: connection.label,
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              dir: { type: "string", maxLength: 200, description: "Folder in the workspace (default: the repo name)" },
            },
            required: ["repo"],
            additionalProperties: false,
          },
          async execute(input, c) {
            try {
              const repo = parseRepo(str(input.repo));
              if (!repo) return { content: "repo must be owner/name", isError: true };
              const keys = await grantedScopeKeys(c.db, c.orgId, c.agentId);
              if (!keys.has(grantKey(null, SANDBOX_SCOPE))) {
                return {
                  content: "Cloning needs your computer (scope sandbox:run), which you don't have.",
                  isError: true,
                };
              }
              const dir = str(input.dir).trim() || repo.repo;
              if (dir.startsWith("/") || dir.split("/").includes(".."))
                return { content: "dir must stay in the workspace", isError: true };
              const result = await withSandbox(deps.sandbox, c, 300, (computer) =>
                computer.provider.exec(computer.id, {
                  command: `git clone --quiet https://github.com/${repo.owner}/${repo.repo} ${quote(dir)} 2>&1 && cd ${quote(dir)} && git log --oneline -1 && git branch --show-current`,
                  timeoutSeconds: 290,
                  ...(c.signal ? { signal: c.signal } : {}),
                }),
              );
              const output = truncateOutput(`${result.stdout}${result.stderr}`.trim(), 4000);
              if (result.exitCode !== 0) return { content: `git clone failed:\n${output}`, isError: true };
              return {
                content: `Cloned ${repo.owner}/${repo.repo} into /workspace/${dir}.\n${output}\nCreate a branch agentes/<your handle>/<topic> to push.`,
                data: { repo: `${repo.owner}/${repo.repo}`, dir },
              };
            } catch (error) {
              return failed(error);
            }
          },
        },
        {
          name: "open_pull_request",
          description:
            "Open a pull request on GitHub from a branch you pushed (agentes/<your handle>/…). Merging is separate and always needs a person's approval.",
          scope: connectorScope("github", "pr.write"),
          connectionId: connection.id,
          connectorLabel: connection.label,
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              branch: { type: "string", minLength: 1, maxLength: 200 },
              title: { type: "string", minLength: 1, maxLength: 256 },
              body: { type: "string", maxLength: 60_000 },
              base: { type: "string", maxLength: 200, description: "Default: the repository's default branch" },
              draft: { type: "boolean" },
            },
            required: ["repo", "branch", "title"],
            additionalProperties: false,
          },
          describe: (input) => ({ title: `Abrir PR em ${str(input.repo)}: ${str(input.title)}` }),
          async execute(input) {
            try {
              const repo = parseRepo(str(input.repo));
              if (!repo) return { content: "repo must be owner/name", isError: true };
              const token =
                (deps.app
                  ? await appTokenForRepo(deps.app, github, repo.owner, repo.repo, {
                      pull_requests: "write",
                      contents: "read",
                    }).catch(() => null)
                  : null) ??
                (await connectionHeaders(deps.connectors, connection)).authorization?.replace(/^Bearer\s+/i, "");
              if (!token) return { content: "GitHub is connected without a usable token.", isError: true };
              const headers = {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.github+json",
                "content-type": "application/json",
                "user-agent": "agentes.chat",
              };
              let base = str(input.base);
              if (!base) {
                const info = await github.fetch(`${github.apiUrl}/repos/${repo.owner}/${repo.repo}`, { headers });
                if (!info.ok)
                  return { content: `GitHub answered ${info.status} for ${repo.owner}/${repo.repo}`, isError: true };
                base = ((await info.json()) as { default_branch?: string }).default_branch ?? "main";
              }
              const res = await github.fetch(`${github.apiUrl}/repos/${repo.owner}/${repo.repo}/pulls`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  title: str(input.title),
                  head: str(input.branch),
                  base,
                  body: str(input.body),
                  draft: input.draft === true,
                }),
              });
              const body = (await res.json().catch(() => ({}))) as {
                html_url?: string;
                number?: number;
                message?: string;
                errors?: { message?: string }[];
              };
              if (!res.ok) {
                const why = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ");
                return { content: `GitHub refused the pull request (${res.status}): ${why}`, isError: true };
              }
              return {
                content: `Opened PR #${body.number}: ${body.html_url}`,
                data: { pullRequest: { number: body.number, url: body.html_url, repo: `${repo.owner}/${repo.repo}` } },
              };
            } catch (error) {
              return failed(error);
            }
          },
        },
      ];
    },
  };
}
