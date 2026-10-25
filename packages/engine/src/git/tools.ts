import type { PubSub } from "@agenteschat/adapters";
import { getAgentCached } from "../agents";
import { connectorScope } from "../connectors/catalog";
import { activeConnections, type ConnectorDeps, connectionHeaders } from "../connectors/connections";
import { publishChannelEvent } from "../events";
import { missionOfRun } from "../mission-context";
import { replyThreadOf } from "../runs";
import { SANDBOX_SCOPE, type SandboxDeps, truncateOutput, withSandbox } from "../sandbox";
import { grantedScopeKeys, grantKey } from "../tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { appTokenForRepo, type GitHubAppConfig } from "./github-app";
import { cloneOnMachine } from "./machine";

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
  /** Live clone progress on a connected machine (`agent.tool.output`). */
  pubsub?: PubSub;
}

/** git's progress lines (`\r`-separated) as a few live lines: at most one per second, the last one wins. */
function progressPublisher(pubsub: PubSub | undefined, c: ToolContext) {
  if (!pubsub || !c.toolUseId) return undefined;
  const toolUseId = c.toolUseId;
  let last = "";
  let sentAt = 0;
  let sent = 0;
  return (_stream: "stdout" | "stderr", chunk: string) => {
    const line = chunk
      .split(/[\r\n]+/)
      .filter((l) => l.trim())
      .at(-1);
    if (line) last = line.trim();
    const now = Date.now();
    if (!last || now - sentAt < 1000 || sent > 300) return;
    sentAt = now;
    sent++;
    const text = `${last}\n`;
    last = "";
    void publishChannelEvent(pubsub, {
      type: "agent.tool.output",
      channelId: c.channelId,
      threadId: replyThreadOf(c),
      runId: c.runId,
      agentId: c.agentId,
      toolUseId,
      stream: "stderr",
      text,
    }).catch(() => undefined);
  };
}

/**
 * Git in the agent's computer (ADR 0024), through our proxy:
 * - `git_clone` (`github:git.read`): on a cloud computer, `git clone
 *   https://github.com/owner/repo` in the workspace (the computer's git is
 *   set up for the proxy; it needs the computer, `sandbox:run`); on a
 *   connected machine, the runner's `git.sync` (protocol 11) clones it into
 *   the agent's folder (`repos/owner/name`) with our proxy credential, no
 *   other scope and no approval (ADR 0024 addendum). Pushes from there go
 *   through the proxy too;
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
            "Clone a GitHub repository into your computer (on a connected computer: into your folder, repos/<owner>/<name>; already there: it is updated). No approval needed. Real git through our proxy: commit and push from there, only to branches agentes/<your handle>/…, then open_pull_request.",
          scope: connectorScope("github", "git.read"),
          connectionId: connection.id,
          connectorLabel: connection.label,
          inputSchema: {
            type: "object",
            properties: {
              repo: repoInput,
              dir: {
                type: "string",
                maxLength: 200,
                description:
                  "Folder in your workspace (default: the repo name; on a connected computer repos/<owner>/<name>)",
              },
            },
            required: ["repo"],
            additionalProperties: false,
          },
          async execute(input, c) {
            try {
              const repo = parseRepo(str(input.repo));
              if (!repo) return { content: "repo must be owner/name", isError: true };
              const given = str(input.dir).trim();
              if (given.startsWith("/") || given.split(/[\\/]/).includes("..") || /^[A-Za-z]:/.test(given))
                return { content: "dir must stay in the workspace", isError: true };
              const [agent, mission] = await Promise.all([getAgentCached(c.db, c.orgId, c.agentId), missionOfRun(c)]);
              // A connected machine (not in a mission's own folder): through the proxy with our credential.
              if (agent?.machineId && !mission) {
                const machines = deps.sandbox.machines;
                const git = deps.sandbox.git;
                if (!machines || !git) return { content: "Connected computers are not available here.", isError: true };
                const r = await cloneOnMachine(
                  { db: c.db, hub: machines.hub, git, ...(deps.sandbox.now ? { now: deps.sandbox.now } : {}) },
                  { orgId: c.orgId, agentId: c.agentId, machineId: agent.machineId },
                  {
                    repo: `${repo.owner}/${repo.repo}`,
                    ...(given ? { dir: given } : {}),
                    ...(c.signal ? { signal: c.signal } : {}),
                    onOutput: progressPublisher(deps.pubsub, c),
                  },
                );
                const where = r.path ?? r.dir;
                if (r.status === "failed" && !r.head) {
                  return { content: `git clone failed: ${r.message ?? "unknown error"}`, isError: true };
                }
                const what =
                  r.status === "cloned"
                    ? `Cloned ${r.repo} into ${where}`
                    : r.status === "failed"
                      ? `${r.repo} is already at ${where}, but it couldn't be updated (${r.message ?? "unknown error"})`
                      : `${r.repo} was already at ${where}; updated it`;
                return {
                  content: `${what} (branch ${r.branch ?? "?"}${r.head ? ` at ${r.head}` : ""}${r.message && r.status !== "failed" ? `; ${r.message}` : ""}).\nWork there (cd ${where}); create a branch agentes/${agent.handle}/<topic> to push, then open_pull_request.`,
                  data: { repo: r.repo, dir: r.dir, machineId: agent.machineId, status: r.status },
                };
              }
              if (mission?.machineId) {
                return {
                  content:
                    "In a mission, work in the mission's own folder on its computer (its repository is set up there).",
                  isError: true,
                };
              }
              const keys = await grantedScopeKeys(c.db, c.orgId, c.agentId);
              if (!keys.has(grantKey(null, SANDBOX_SCOPE))) {
                return {
                  content: "Cloning needs your computer (scope sandbox:run), which you don't have.",
                  isError: true,
                };
              }
              const dir = given || repo.repo;
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
                  ? await appTokenForRepo(deps.app, github, { db: ctx.db, orgId: ctx.orgId }, repo.owner, repo.repo, {
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
