import type {
  ArtifactDeps,
  BrowserLive,
  ContextDeps,
  GifKey,
  GitProxyDeps,
  JevKey,
  McpConnect,
  ModelGateway,
  ResolveHost,
  RouterDeps,
  SandboxDeps,
  StorageDeps,
  StreamBroker,
  Talker,
} from "@agenteschat/engine";
import type { AppleTokenRevoker } from "../../auth";

/**
 * Backend services the app API needs beyond the core deps (owned by the
 * backend; extended per phase). Everything is optional so tests and the web
 * app's own routes don't have to provide them.
 */
export interface AppExtras {
  /** Outbound HTTP: OAuth token exchanges, provider key checks (tests inject a fake). */
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
  /** Agents' computers (ADR 0025): the machine hub, Run code settings and git; null/absent = none on this server. */
  sandbox?: SandboxDeps | null;
  /** The git proxy for agents' computers (ADR 0024); absent = off. */
  gitProxy?: GitProxyDeps;
  /** Revokes Apple tokens when an account is deleted (ADR 0035); absent/null = Apple sign-in off. */
  appleRevoke?: AppleTokenRevoker | null;
  /** Outbound HTTP to GitHub for the desktop app's releases (ADR 0036; tests inject a fake GitHub). */
  desktopFetch?: typeof fetch;
  /** The agent browser's live view (ADR 0040): handoff changes switch its stream; absent = handoffs only. */
  browserLive?: BrowserLive;
  /** Agents' desktop and terminal streams on this server (ADR 0058): who watches; absent = none counted. */
  streams?: StreamBroker;
  /** Agents' conversation layer: fast replies while their task works or waits; absent = none. */
  talker?: Talker;
  /** The router of messages nobody mentioned ("Responder agora" routes one again); null/absent = routing off. */
  router?: RouterDeps | null;
  /** The installation's Jev key, for its owner's routes (ADR 0073); absent = those routes answer 404. */
  jevKey?: JevKey;
  /**
   * The installation's GIPHY key, for its owner's routes (ADR 0091, amended 2026-10-31); absent (agentes.chat's own
   * servers) = those routes answer 404.
   */
  gifKey?: GifKey;
}
