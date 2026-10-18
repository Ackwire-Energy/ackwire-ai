/**
 * Fake connectors of the behavior eval: tools named, scoped and described
 * like the real catalog/MCP ones (`github_search_code`, `sentry_search_issues`…),
 * returning canned results from the case. Nothing leaves the process.
 */
import type { JsonSchema } from "../src/tools/json-schema";
import type { ToolDefinition, ToolSource } from "../src/tools/types";

/** A canned result: the first entry whose `when` words all appear in the call's input wins (no `when` = default). */
export interface Canned {
  when?: string[];
  result: string;
  isError?: boolean;
}

interface FakeTool {
  name: string;
  scope: string;
  description: string;
  properties: Record<string, JsonSchema>;
  required?: string[];
  sensitive?: boolean;
  /** What it answers when the case has nothing for this call. */
  empty?: Canned;
  describe?(input: Record<string, unknown>): { title: string; detail?: string };
}

const str = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string): JsonSchema => ({ type: "integer", description });
const repo = { owner: str("Repository owner"), repo: str("Repository name") };

export const CONNECTORS = {
  github: [
    {
      name: "github_search_code",
      scope: "github:repo.read",
      description:
        "[GitHub] Search code across repositories with GitHub code search syntax (e.g. `subscription_completed repo:owner/name`). Returns matching files with line numbers.",
      properties: { query: str("Search query"), perPage: int("Results per page") },
      required: ["query"],
    },
    {
      name: "github_get_file_contents",
      scope: "github:repo.read",
      description:
        "[GitHub] Get the contents of a file or directory from a repository (whole file, with line numbers).",
      properties: { ...repo, path: str("File or directory path"), ref: str("Branch, tag or commit") },
      required: ["owner", "repo", "path"],
      empty: { result: "Not Found: no file at that path", isError: true },
    },
    {
      name: "github_list_commits",
      scope: "github:repo.read",
      description: "[GitHub] List commits of a branch, optionally only those touching a path.",
      properties: { ...repo, sha: str("Branch or commit"), path: str("Only commits touching this path") },
      required: ["owner", "repo"],
    },
    {
      name: "github_list_pull_requests",
      scope: "github:pr.read",
      description: "[GitHub] List pull requests of a repository.",
      properties: { ...repo, state: str("open, closed or all") },
      required: ["owner", "repo"],
    },
    {
      name: "github_get_pull_request",
      scope: "github:pr.read",
      description: "[GitHub] Get a pull request: title, author, branches, review state and checks.",
      properties: { ...repo, pullNumber: int("Pull request number") },
      required: ["owner", "repo", "pullNumber"],
      empty: { result: "Not Found: no such pull request", isError: true },
    },
    {
      name: "github_get_pull_request_diff",
      scope: "github:pr.read",
      description: "[GitHub] Get the diff of a pull request.",
      properties: { ...repo, pullNumber: int("Pull request number") },
      required: ["owner", "repo", "pullNumber"],
    },
    {
      name: "github_create_branch",
      scope: "github:repo.write",
      description: "[GitHub] Create a branch from another branch.",
      properties: { ...repo, branch: str("New branch"), from_branch: str("Source branch") },
      required: ["owner", "repo", "branch"],
      empty: { result: "Branch created." },
    },
    {
      name: "github_create_or_update_file",
      scope: "github:repo.write",
      description: "[GitHub] Create or update one file in a branch (a commit).",
      properties: {
        ...repo,
        path: str("File path"),
        content: str("New file content"),
        message: str("Commit message"),
        branch: str("Branch (never the default branch)"),
      },
      required: ["owner", "repo", "path", "content", "message", "branch"],
      empty: { result: "Committed." },
    },
    {
      name: "github_create_pull_request",
      scope: "github:pr.write",
      description: "[GitHub] Open a pull request.",
      properties: {
        ...repo,
        title: str("Title"),
        head: str("Branch with the changes"),
        base: str("Branch to merge into"),
        body: str("Description"),
        draft: { type: "boolean", description: "Open as a draft" },
      },
      required: ["owner", "repo", "title", "head", "base"],
      empty: { result: "Pull request #71 opened." },
    },
    {
      name: "github_merge_pull_request",
      scope: "github:pr.merge",
      sensitive: true,
      description: "[GitHub] Merge a pull request. Always asks a person for approval.",
      properties: { ...repo, pullNumber: int("Pull request number"), merge_method: str("merge, squash or rebase") },
      required: ["owner", "repo", "pullNumber"],
      empty: { result: "Merged." },
      describe: (i) => ({ title: `Merge PR #${i.pullNumber} in ${i.owner}/${i.repo}` }),
    },
    {
      name: "github_run_workflow",
      scope: "github:actions.run",
      sensitive: true,
      description: "[GitHub] Start a GitHub Actions workflow (it may deploy). Always asks a person for approval.",
      properties: { ...repo, workflow_id: str("Workflow file or id"), ref: str("Branch") },
      required: ["owner", "repo", "workflow_id"],
      empty: { result: "Workflow started." },
    },
  ],
  sentry: [
    {
      name: "sentry_search_issues",
      scope: "sentry:issues.read",
      description:
        "[Sentry] Search error issues (e.g. `is:unresolved firstSeen:-1h`), with counts, users affected, first and last seen.",
      properties: { query: str("Sentry search query"), projectSlug: str("Project"), sort: str("date, new, freq") },
    },
    {
      name: "sentry_get_issue_details",
      scope: "sentry:issues.read",
      description: "[Sentry] Details of an issue: stack trace, tags, release, first and last seen, event count.",
      properties: { issueId: str("Issue id or short id (e.g. LUMEN-API-4F2)") },
      required: ["issueId"],
      empty: { result: "Issue not found", isError: true },
    },
    {
      name: "sentry_search_events",
      scope: "sentry:issues.read",
      description: "[Sentry] Search events (individual occurrences) with a query.",
      properties: { query: str("Query"), projectSlug: str("Project") },
    },
    {
      name: "sentry_update_issue",
      scope: "sentry:issues.write",
      description: "[Sentry] Resolve, ignore or assign an issue.",
      properties: { issueId: str("Issue id"), status: str("resolved, ignored or unresolved"), assignedTo: str("Who") },
      required: ["issueId"],
      empty: { result: "Updated." },
    },
  ],
  himetrica: [
    {
      name: "himetrica_list_events",
      scope: "himetrica:read",
      description: "[Himetrica] List the product's custom events with their counts in a period.",
      properties: { projectId: str("Project"), days: int("Period in days (default 7)") },
    },
    {
      name: "himetrica_get_event_timeseries",
      scope: "himetrica:read",
      description: "[Himetrica] Daily counts of one event.",
      properties: { projectId: str("Project"), event: str("Event name"), days: int("Period in days") },
      required: ["event"],
    },
    {
      name: "himetrica_get_event_property_breakdown",
      scope: "himetrica:read",
      description: "[Himetrica] Counts of one event split by a property (e.g. rating, plan, screen, comment).",
      properties: {
        projectId: str("Project"),
        event: str("Event name"),
        property: str("Property"),
        days: int("Period in days"),
      },
      required: ["event", "property"],
    },
  ],
  railway: [
    {
      name: "railway_list_deployments",
      scope: "railway:read",
      description: "[Railway] Recent deployments of a service, with commit, status and time.",
      properties: { service: str("Service name") },
    },
    {
      name: "railway_get_logs",
      scope: "railway:read",
      description: "[Railway] Logs of a service (optionally filtered by text and deployment).",
      properties: { service: str("Service name"), query: str("Filter"), deploymentId: str("Deployment") },
    },
    {
      name: "railway_rollback",
      scope: "railway:deploy",
      sensitive: true,
      description: "[Railway] Roll a service back to an earlier deployment. Always asks a person for approval.",
      properties: { service: str("Service name"), deploymentId: str("Deployment to go back to") },
      required: ["service", "deploymentId"],
      empty: { result: "Rolled back." },
    },
    {
      name: "railway_deploy",
      scope: "railway:deploy",
      sensitive: true,
      description: "[Railway] Deploy a commit to a service. Always asks a person for approval.",
      properties: { service: str("Service name"), commit: str("Commit") },
      required: ["service"],
      empty: { result: "Deploy started." },
    },
  ],
} satisfies Record<string, FakeTool[]>;

export type ConnectorId = keyof typeof CONNECTORS;

const lower = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The canned answer for one call. */
export function cannedFor(entries: Canned[] | undefined, input: Record<string, unknown>, fallback?: Canned): Canned {
  const haystack = lower(JSON.stringify(input));
  const hit = (entries ?? []).find((e) => (e.when ?? []).every((w) => haystack.includes(lower(w))));
  return hit ?? fallback ?? { result: "No results." };
}

/** A tool source for one fake connector, answering from the case's fixtures; `executed` lists what ran. */
export function fakeConnectorSource(id: ConnectorId, fixtures: Record<string, Canned[]>) {
  const executed: { name: string; input: Record<string, unknown> }[] = [];
  const tools = (CONNECTORS[id] as FakeTool[]).map(
    (t): ToolDefinition => ({
      name: t.name,
      description: t.description,
      scope: t.scope,
      connectorLabel: id,
      sensitive: t.sensitive,
      inputSchema: { type: "object", properties: t.properties, required: t.required ?? [] },
      ...(t.describe ? { describe: t.describe } : {}),
      async execute(input) {
        executed.push({ name: t.name, input });
        const canned = cannedFor(fixtures[t.name], input, t.empty);
        return { content: canned.result, isError: canned.isError === true };
      },
    }),
  );
  const source: ToolSource = { name: `fake-${id}`, tools: async () => tools };
  return { source, executed };
}
