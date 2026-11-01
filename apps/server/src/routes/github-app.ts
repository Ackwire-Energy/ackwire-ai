import { connectorOAuthApps, githubAppConfig } from "@agenteschat/config";
import {
  completeGitHubAppInstall,
  forgetOrgRepositories,
  type GitHubAppInstallDeps,
  githubAppInstallationView,
  handleGitHubAppWebhook,
  listGitHubAppInstallations,
  listOrgRepositories,
  peekOAuthState,
  removeGitHubAppInstallation,
  startGitHubAppInstall,
  validGitHubAppSignature,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { isExpectedError } from "../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  oauthFailedUrl,
  oauthFailure,
  requireSession,
  security,
  signInFirst,
} from "./app/context";
import { readWebhookText } from "./webhook-body";

const tags = ["Connectors"];

const Installation = z
  .object({
    id: z.uuid(),
    installationId: z.number().int(),
    accountLogin: z.string(),
    accountType: z.string(),
    repositorySelection: z.string(),
    suspended: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("GitHubAppInstallation");

function installDeps(deps: AppDeps): GitHubAppInstallDeps {
  return {
    db: deps.db,
    keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
    app: githubAppConfig(deps.config),
    http: deps.extras?.http ? { fetch: deps.extras.http, apiUrl: "https://api.github.com" } : undefined,
  };
}

/**
 * Our public GitHub App (ADR 0033): organizations install it from the app,
 * which binds the installation to them; GitHub redirects back to
 * `/api/app/github-app/callback` (user authorization during installation).
 */
export function githubAppRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  // GitHub's return is a browser navigation: no session in this browser, the sign-in page first.
  app.use("/github-app/callback", signInFirst(deps.auth, deps.config.PUBLIC_URL));
  for (const path of ["/organizations/*", "/github-app/*"]) app.use(path, requireSession(deps.auth));
  const install = installDeps(deps);
  const base = deps.config.PUBLIC_URL.replace(/\/$/, "");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/github-app",
      tags,
      security,
      summary: "The GitHub App: whether it can be installed here, and this organization's installations",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ installable: z.boolean(), installations: z.array(Installation) })),
        ...errors,
      },
    }),
    async (c) => {
      const rows = await listGitHubAppInstallations(deps.db, c.get("user").id, c.req.valid("param").orgId);
      const cfg = install.app;
      return c.json(
        {
          installable: Boolean(cfg?.slug && cfg.clientId && cfg.clientSecret),
          installations: rows.map(githubAppInstallationView),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/github-app/install",
      tags,
      security,
      summary: "Start installing the GitHub App (admins); open the returned URL",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            returnTo: z.string().max(500).optional().openapi({ description: "Path to land on afterwards." }),
          }),
        ),
      },
      responses: { 200: json(z.object({ installUrl: z.string() })), ...errors },
    }),
    async (c) => {
      const { installUrl } = await startGitHubAppInstall(
        install,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json({ installUrl }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/github-app/installations/{installationId}",
      tags,
      security,
      summary: "Disconnect an installation from this organization (it stays installed on GitHub)",
      request: { params: OrgParams.extend({ installationId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, installationId } = c.req.valid("param");
      await removeGitHubAppInstallation(deps.db, c.get("user").id, orgId, installationId);
      forgetOrgRepositories(orgId);
      return c.body(null, 204);
    },
  );

  const Repository = z.object({
    fullName: z.string(),
    owner: z.string(),
    name: z.string(),
    private: z.boolean(),
    updatedAt: z.string().nullable(),
  });
  const listing = {
    db: deps.db,
    connectors: {
      db: deps.db,
      keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
      oauthApps: connectorOAuthApps(deps.config),
      publicUrl: deps.config.PUBLIC_URL,
      http: deps.extras?.http,
    },
    app: install.app,
    github: install.http,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/github/repositories",
      tags,
      security,
      summary:
        "Repositories the organization's GitHub reaches (its connection and the app's installations), by account",
      request: { params: OrgParams },
      responses: {
        200: json(
          z
            .object({
              connected: z.boolean(),
              accounts: z.array(z.object({ login: z.string(), type: z.string(), repositories: z.array(Repository) })),
              truncated: z.boolean(),
            })
            .openapi("GitHubRepositories"),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await listOrgRepositories(listing, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/github-app/callback",
      tags,
      security,
      summary: "GitHub's redirect after installing (browser navigation)",
      description:
        "Checks the state and that the person's GitHub account can see the installation, binds it to the organization, then redirects to the web app.",
      request: {
        query: z.object({
          state: z.string().optional(),
          code: z.string().optional(),
          installation_id: z.coerce.number().int().positive().optional(),
          setup_action: z.string().optional(),
          error: z.string().optional(),
        }),
      },
      responses: { 302: { description: "Back to the web app" }, ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      // Back where it started (its state's page) while the state can still be read, else the start.
      const started = q.state ? await peekOAuthState(deps, q.state) : null;
      const fail = (reason: string) =>
        c.redirect(oauthFailedUrl(base, started?.returnTo ?? "/", "github_app_error", reason), 302);
      // `request`: someone without rights on that GitHub account asked its owner to install; nothing to bind yet.
      if (q.setup_action === "request") return fail("requested");
      if (q.error) return fail("cancelled");
      if (!q.state || !q.code || !q.installation_id) return fail("failed");
      try {
        const { installation, returnTo } = await completeGitHubAppInstall(install, c.get("user"), {
          state: q.state,
          code: q.code,
          installationId: q.installation_id,
        });
        forgetOrgRepositories(installation.orgId);
        const sep = returnTo.includes("?") ? "&" : "?";
        return c.redirect(`${base}${returnTo}${sep}github_app=installed`, 302);
      } catch (error) {
        const reason = oauthFailure(error);
        if (reason === "failed") {
          const log = isExpectedError(error) ? deps.log?.warn : deps.log?.error;
          log?.("github app install failed", { error });
        }
        return fail(reason);
      }
    },
  );
  return app;
}

/** `POST /api/github-app/webhook`: GitHub's events for our app (public, signature-checked). */
export function registerGitHubAppWebhook(api: OpenAPIHono, deps: AppDeps) {
  api.post("/github-app/webhook", async (c) => {
    const secret = deps.config.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "not configured" }, 404);
    const raw = await readWebhookText(c.req.raw, 5_000_000);
    if (raw === null) return c.json({ error: "too large" }, 413);
    if (!validGitHubAppSignature(secret, raw, c.req.header("x-hub-signature-256") ?? null)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const result = await handleGitHubAppWebhook(deps.db, c.req.header("x-github-event") ?? null, payload);
    return c.json({ ok: true, result }, 202);
  });
}
