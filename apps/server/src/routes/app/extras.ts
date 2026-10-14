import type { McpConnect } from "@agenteschat/engine";

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
}
