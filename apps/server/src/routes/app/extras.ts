import type {
  ArtifactDeps,
  ContextDeps,
  McpConnect,
  ModelGateway,
  ResolveHost,
  SandboxDeps,
  StorageDeps,
} from "@agenteschat/engine";

/**
 * Backend services the app API needs beyond the core deps (owned by the
 * backend; extended per phase). Everything is optional so tests and the web
 * app's own routes don't have to provide them.
 */
export interface AppExtras {
  /** Outbound HTTP for OAuth token exchanges (tests inject a fake). */
  http?: typeof fetch;
  /** How to open MCP sessions (tests: in-process servers). */
  mcpConnect?: McpConnect;
  /** DNS for the SSRF guard on URLs people type (tests: fake). */
  resolveHost?: ResolveHost;
  /** Query embeddings for search (the Model Gateway's `embed`, which records usage). */
  embed?: ModelGateway["embed"];
  /** Context deps (cheap-model calls such as schedule parsing). */
  context?: ContextDeps;
  /** Org storage settings and the blob resolver (Drive, artifacts). */
  storage?: StorageDeps;
  artifacts?: ArtifactDeps;
  /** Code sandbox (D30); null/absent = off on this server. */
  sandbox?: SandboxDeps | null;
}
