import type { Adapters } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import type { ModelProvider } from "@agenteschat/providers";
import type { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Which build of agentes.chat is running.
 * - `selfhost`: the open-source server, started by `apps/server/src/main.ts`.
 * - `cloud`: our hosted service, started from the private `agentes-chat-cloud`
 *   repository (this repository is its `core/` submodule), which adds
 *   cloud-only modules (billing, plan limits, platform key, KMS, Redis).
 */
export type Edition = "selfhost" | "cloud";

export interface ModuleContext {
  config: Config;
  db: Database;
  edition: Edition;
  version: string;
  /** Adapters after every module's overrides were applied. */
  adapters: Adapters;
}

/** What a module may replace. Later modules win over earlier ones. */
export interface AdapterOverrides extends Partial<Adapters> {
  /** Model providers by id (e.g. `anthropic`), merged over the core ones. */
  modelProviders?: Record<string, ModelProvider>;
}

/**
 * Extension point that lets the Cloud edition and `ee/` add behaviour without
 * the core ever importing them. The core only knows this interface.
 *
 * Rule enforced by `bun run check:boundaries`: nothing under `apps/` or
 * `packages/` may import `@agenteschat/cloud` or `@agenteschat/ee`.
 */
export interface AgentesModule {
  /** Stable identifier, e.g. `cloud-billing`. Shown in logs and `/api/health`. */
  name: string;
  /**
   * Replace core adapters (search backend per org, pub/sub, presence, rate
   * limiter, key wrapping, platform credentials, model providers). Called once
   * at boot, before routes are registered.
   */
  adapters?(
    ctx: Omit<ModuleContext, "adapters"> & { defaults: Adapters },
  ): AdapterOverrides | Promise<AdapterOverrides>;
  /** Mount routes under `/api/...`. Runs once at startup, after migrations. */
  registerRoutes?(app: OpenAPIHono, ctx: ModuleContext): void;
  /** Called once after the server starts listening. */
  onStart?(ctx: ModuleContext): Promise<void> | void;
  /** Called on graceful shutdown. */
  onStop?(): Promise<void> | void;
}

/** Applies each module's overrides over the defaults, in order. */
export async function resolveAdapters(
  modules: AgentesModule[],
  ctx: Omit<ModuleContext, "adapters">,
  defaults: Adapters,
  defaultProviders: Record<string, ModelProvider>,
): Promise<{ adapters: Adapters; modelProviders: Record<string, ModelProvider>; overridden: string[] }> {
  let adapters = { ...defaults };
  let modelProviders = { ...defaultProviders };
  const overridden: string[] = [];
  for (const module of modules) {
    if (!module.adapters) continue;
    const { modelProviders: providers, ...rest } = await module.adapters({ ...ctx, defaults: adapters });
    for (const key of Object.keys(rest)) overridden.push(`${module.name}:${key}`);
    adapters = { ...adapters, ...rest };
    if (providers) {
      for (const key of Object.keys(providers)) overridden.push(`${module.name}:modelProviders.${key}`);
      modelProviders = { ...modelProviders, ...providers };
    }
  }
  return { adapters, modelProviders, overridden };
}
