import type { Edition } from "@agenteschat/modules";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded", "draining"]),
    version: z.string().openapi({ example: "0.1.0" }),
    edition: z.enum(["selfhost", "cloud"]),
    database: z.enum(["ok", "unreachable"]),
    modules: z.array(z.string()).openapi({ description: "Extra modules loaded by this edition." }),
  })
  .openapi("Health");

const route = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  description:
    "Liveness and readiness probe. 200 when the database is reachable, 503 otherwise, and 503 (`draining`) once the server is shutting down.",
  responses: {
    200: { description: "Healthy", content: { "application/json": { schema: HealthResponse } } },
    503: {
      description: "Database unreachable, or shutting down",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export interface HealthDeps {
  version: string;
  edition: Edition;
  modules: string[];
  pingDatabase: () => Promise<void>;
  /** True once the server is shutting down (`SHUTDOWN_DELAY_MS`): a proxy's health check stops sending requests here. */
  draining?: () => boolean;
}

export function registerHealth(app: OpenAPIHono, deps: HealthDeps) {
  app.openapi(route, async (c) => {
    const database = await deps
      .pingDatabase()
      .then(() => "ok" as const)
      .catch(() => "unreachable" as const);
    const draining = deps.draining?.() === true;
    const body = {
      status: draining ? ("draining" as const) : database === "ok" ? ("ok" as const) : ("degraded" as const),
      version: deps.version,
      edition: deps.edition,
      database,
      modules: deps.modules,
    };
    return database === "ok" && !draining ? c.json(body, 200) : c.json(body, 503);
  });
}
