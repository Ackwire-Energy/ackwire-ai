/*
 * Every fact about connecting an AI app to this server (ADR 0113), in one place: the "Conectar um app" dialog and the
 * help page's tabs both read it. Commands, deep links and menu paths are each vendor's as of ADR 0113's QA gates
 * (G1–G6): ChatGPT waits for G3, Codex for G5.
 */

/** The name the app lists this server under. */
export const MCP_SERVER_NAME = "agentes";

export type AppClientId = "claude" | "claude_code" | "chatgpt" | "cursor" | "other";

/** The cards, in order: `mark` is a `ProviderLogo` id, `app` the vendor's own page to open (if any). */
export const APP_CLIENTS: readonly { id: AppClientId; mark: string | null; app?: string }[] = [
  { id: "claude", mark: "claude", app: "https://claude.ai/settings/connectors" },
  { id: "claude_code", mark: "claude_code" },
  { id: "chatgpt", mark: "openai", app: "https://chatgpt.com/plugins" },
  { id: "cursor", mark: "cursor" },
  { id: "other", mark: null },
];

export type OtherClientTab = "vscode" | "codex" | "any";
export const OTHER_CLIENT_TABS: readonly OtherClientTab[] = ["vscode", "codex", "any"];

export const claudeCodeCommand = (url: string) => `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`;

/** Cursor's one-click install: the config as base64 JSON. */
export const cursorInstallLink = (url: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${btoa(JSON.stringify({ url }))}`;

/** `~/.cursor/mcp.json`. */
export const cursorConfig = (url: string) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url } } }, null, 2);

/** VS Code's install link: the server as URL-encoded JSON. */
export const vscodeInstallLink = (url: string) =>
  `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_SERVER_NAME, type: "http", url }))}`;

/** `.vscode/mcp.json`. */
export const vscodeConfig = (url: string) =>
  JSON.stringify({ servers: { [MCP_SERVER_NAME]: { type: "http", url } } }, null, 2);

export const codexCommands = (url: string) =>
  `codex mcp add ${MCP_SERVER_NAME} --url ${url}\ncodex mcp login ${MCP_SERVER_NAME}`;
