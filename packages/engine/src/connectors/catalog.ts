import type { OutcomeKind } from "../context/outcomes";

/**
 * Connector catalog: which MCP servers agentes.chat knows, and how each of
 * their tools maps to one of OUR scopes (ADR 0016: MCP has no standard scopes).
 * A tool the server offers but this catalog doesn't list is never exposed.
 * `sensitive` tools always need a person's approval (merge, deploy and
 * rollback are sensitive whatever this says; see `isSensitive`).
 *
 * Tool names follow the public MCP servers of each vendor. Titles are
 * templates for approval cards: `{param}` is replaced by the call's value.
 */
export interface ConnectorScope {
  label: string;
  description: string;
}

export interface ConnectorTool {
  scope: string;
  sensitive?: boolean;
  /** Approval-card title template, e.g. "Merge PR #{pullNumber} in {owner}/{repo}". */
  title?: string;
  /** Outcome recorded when the call succeeds (ground truth for lessons); `subject` is a template. */
  onSuccess?: { kind: OutcomeKind; subject: string };
  /**
   * Served by agentes.chat under this exact name (the git tools), never taken from the vendor's MCP server: access
   * lists and denies it by that name.
   */
  ours?: boolean;
}

/** Catalog groups (the app translates them, `connectors.category.*`): development, product, docs, data (analytics), payments, sales, support, marketing, automation. */
export type ConnectorCategory =
  | "dev"
  | "product"
  | "docs"
  | "data"
  | "payments"
  | "sales"
  | "support"
  | "marketing"
  | "automation";

export interface ConnectorDefinition {
  id: string;
  label: string;
  description: string;
  category: ConnectorCategory;
  /** Default MCP endpoint (streamable HTTP). Null = the org must give one. */
  serverUrl: string | null;
  auth: ("oauth" | "api_key")[];
  oauth?: { authorizeUrl: string; tokenUrl: string; scopes: string[]; scopeSeparator?: string };
  scopes: Record<string, ConnectorScope>;
  tools: Record<string, ConnectorTool>;
}

const s = (label: string, description: string): ConnectorScope => ({ label, description });

export const CONNECTOR_CATALOG: Record<string, ConnectorDefinition> = {
  github: {
    id: "github",
    category: "dev",
    label: "GitHub",
    description: "Repositories, pull requests, issues and Actions.",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org", "workflow"],
      scopeSeparator: " ",
    },
    scopes: {
      "repo.read": s("Read code", "Read files and commits and search the code."),
      "repo.write": s("Write code", "Create branches and push commits (never to the default branch without a PR)."),
      "git.read": s(
        "Clone repositories (git)",
        "Clone and update repositories on the agent's computer with git, through our proxy; the GitHub token never enters the machine.",
      ),
      "git.write": s(
        "Push branches (git push)",
        "Push commits to agentes/{agent}/… branches: never to the default branch, no force push, no tags. Deleting branches (delete_branches) and pushing to someone else's branch (request_branch_push) ask for approval first.",
      ),
      "pr.read": s("Read pull requests", "List and read pull requests and their checks."),
      "pr.write": s("Open pull requests", "Open pull requests and comment on them."),
      "pr.merge": s("Merge pull requests", "Merge a pull request. Always asks for approval."),
      "issues.read": s("Read issues", "List and read GitHub issues."),
      "issues.write": s("Write issues", "Create issues and comment."),
      "actions.run": s("Run workflows", "Start GitHub Actions workflows (they may deploy). Always asks for approval."),
    },
    tools: {
      git_clone: { scope: "git.read", ours: true },
      open_pull_request: { scope: "pr.write", ours: true },
      delete_branches: { scope: "git.write", ours: true },
      request_branch_push: { scope: "git.write", ours: true },
      get_file_contents: { scope: "repo.read" },
      search_code: { scope: "repo.read" },
      list_commits: { scope: "repo.read" },
      create_branch: { scope: "repo.write" },
      push_files: { scope: "repo.write" },
      create_or_update_file: { scope: "repo.write" },
      get_pull_request: { scope: "pr.read" },
      list_pull_requests: { scope: "pr.read" },
      get_pull_request_status: { scope: "pr.read" },
      get_pull_request_diff: { scope: "pr.read" },
      create_pull_request: { scope: "pr.write" },
      add_pull_request_review_comment: { scope: "pr.write" },
      merge_pull_request: {
        scope: "pr.merge",
        sensitive: true,
        title: "Merge PR #{pullNumber} in {owner}/{repo}",
        onSuccess: { kind: "pr_merged", subject: "{owner}/{repo}#{pullNumber}" },
      },
      get_issue: { scope: "issues.read" },
      list_issues: { scope: "issues.read" },
      create_issue: { scope: "issues.write" },
      add_issue_comment: { scope: "issues.write" },
      run_workflow: {
        scope: "actions.run",
        sensitive: true,
        title: "Run workflow {workflow_id} in {owner}/{repo}",
      },
      list_workflow_runs: { scope: "repo.read" },
    },
  },
  sentry: {
    id: "sentry",
    category: "dev",
    label: "Sentry",
    description: "Errors, issues and events.",
    serverUrl: "https://mcp.sentry.dev/mcp",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://sentry.io/oauth/authorize/",
      tokenUrl: "https://sentry.io/oauth/token/",
      scopes: ["org:read", "project:read", "event:read", "event:write"],
      scopeSeparator: " ",
    },
    scopes: {
      "issues.read": s("Read errors", "Search issues and events and read their details."),
      "issues.write": s("Triage errors", "Resolve, assign or ignore Sentry issues."),
    },
    tools: {
      find_projects: { scope: "issues.read" },
      search_issues: { scope: "issues.read" },
      search_events: { scope: "issues.read" },
      get_issue_details: { scope: "issues.read" },
      update_issue: { scope: "issues.write" },
    },
  },
  linear: {
    id: "linear",
    category: "product",
    label: "Linear",
    description: "Issues, projects and comments.",
    serverUrl: "https://mcp.linear.app/mcp",
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read", "write"],
      scopeSeparator: ",",
    },
    scopes: {
      "issues.read": s("Read issues", "List and read Linear issues and projects."),
      "issues.write": s("Write issues", "Create and update issues and comments."),
    },
    tools: {
      list_issues: { scope: "issues.read" },
      get_issue: { scope: "issues.read" },
      list_projects: { scope: "issues.read" },
      create_issue: { scope: "issues.write" },
      update_issue: { scope: "issues.write" },
      create_comment: { scope: "issues.write" },
    },
  },
  drive: {
    id: "drive",
    category: "docs",
    label: "Google Drive",
    description: "Search, read and write documents (any Drive-like MCP server).",
    serverUrl: null,
    auth: ["oauth", "api_key"],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/drive"],
      scopeSeparator: " ",
    },
    scopes: {
      "files.read": s("Read documents", "Search and read files."),
      "files.write": s("Write documents", "Create and edit files."),
      "files.share": s("Share documents", "Change who can see a file. Always asks for approval."),
    },
    tools: {
      search_files: { scope: "files.read" },
      read_file: { scope: "files.read" },
      create_file: { scope: "files.write" },
      update_file: { scope: "files.write" },
      share_file: { scope: "files.share", sensitive: true, title: "Share {fileId} with {email}" },
    },
  },
};

/** Our scope string for a connector scope, as stored in `agent_scopes`: `github:pr.merge`. */
export const connectorScope = (connector: string, scope: string) => `${connector}:${scope}`;

/** Fills an approval title template with the call's parameters. */
export function fillTitle(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = input[key];
    return v === undefined || v === null ? "?" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}
