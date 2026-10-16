import { readGithubImport } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Agents"];

const ImportedFiles = z
  .object({
    files: z.array(
      z.object({
        path: z.string().openapi({ description: "Relative to the linked folder, or the file's name." }),
        text: z.string(),
      }),
    ),
  })
  .openapi("AgentImportFiles");

/**
 * Bring agents from another app (onboarding): the backend reads the files
 * behind a GitHub link (only github.com and raw.githubusercontent.com over
 * HTTPS, 4 MB / 40 files, 15 s per request); the web app parses them.
 */
export function agentImportRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-imports/github",
      tags,
      security,
      summary: "Read the team file or agent definitions behind a GitHub link (nothing is saved)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            url: z
              .string()
              .max(2000)
              .refine((value) => {
                try {
                  const u = new URL(value);
                  return u.protocol === "https:" && ["github.com", "raw.githubusercontent.com"].includes(u.hostname);
                } catch {
                  return false;
                }
              }, "Only https://github.com or https://raw.githubusercontent.com links"),
          }),
        ),
      },
      responses: { 200: json(ImportedFiles), ...errors },
    }),
    async (c) => {
      const result = await readGithubImport(
        { db: deps.db, fetch: deps.extras?.http, resolveHost: deps.extras?.resolveHost },
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json").url,
      );
      return c.json(result, 200);
    },
  );

  return app;
}
