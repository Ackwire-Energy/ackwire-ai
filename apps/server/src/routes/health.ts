import type { Edition } from "@agenteschat/modules";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
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
  description: "Liveness and readiness probe. 200 when the database is reachable, 503 otherwise.",
  responses: {
    200: { description: "Healthy", content: { "application/json": { schema: HealthResponse } } },
    503: { description: "Database unreachable", content: { "application/json": { schema: HealthResponse } } },
  },
});

export interface HealthDeps {
  version: string;
  edition: Edition;
  modules: string[];
  pingDatabase: () => Promise<void>;
}

export function registerHealth(app: OpenAPIHono, deps: HealthDeps) {
  app.openapi(route, async (c) => {
    const database = await deps
      .pingDatabase()
      .then(() => "ok" as const)
      .catch(() => "unreachable" as const);
    const body = {
      status: database === "ok" ? ("ok" as const) : ("degraded" as const),
      version: deps.version,
      edition: deps.edition,
      database,
      modules: deps.modules,
    };
    return database === "ok" ? c.json(body, 200) : c.json(body, 503);
  });
}
