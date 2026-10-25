import { countUsers } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { authUiConfig, signupPolicy } from "../auth";
import type { AppDeps } from "./app/context";

/**
 * The app API contract this server speaks and the oldest one it still serves. Raise `API` when the phone or
 * desktop app needs something new from the server; raise `MIN_API` only when older apps can no longer work
 * with it, since they then ask to be updated.
 */
const API = 1;
const MIN_API = 1;

const InstanceResponse = z
  .object({
    name: z.literal("agentes.chat"),
    version: z.string(),
    api: z.number().int().openapi({ description: "The app API contract this server speaks." }),
    minApi: z.number().int().openapi({ description: "The oldest app API contract it still serves." }),
    url: z
      .string()
      .openapi({ description: "This server's own address (`PUBLIC_URL`).", example: "https://chat.example.com" }),
    signIn: z.object({ email: z.boolean(), google: z.boolean(), github: z.boolean(), apple: z.boolean() }),
    signup: z.enum(["open", "invite"]).openapi({ description: "`invite`: only people with an invitation sign up." }),
    ownerClaim: z.boolean().openapi({
      description:
        "No account yet, and only the owner link its installer printed creates the first one (`/owner#claim=…`).",
    }),
  })
  .openapi("Instance");

const route = createRoute({
  method: "get",
  path: "/instance",
  tags: ["System"],
  summary: "What this server is",
  description:
    "Public, nothing secret. The phone and desktop apps check it before using a server: that it is agentes.chat, on an API they speak, and how people sign in.",
  responses: { 200: { description: "OK", content: { "application/json": { schema: InstanceResponse } } } },
});

export function registerInstance(api: OpenAPIHono, deps: AppDeps, version: string) {
  // The desktop app's web view (origin `tauri://localhost`) reads it with fetch: public data, no credentials.
  api.use("/instance", async (c, next) => {
    await next();
    c.res.headers.set("access-control-allow-origin", "*");
  });

  api.openapi(route, async (c) => {
    const { config } = deps;
    const users = await countUsers(deps.db);
    const ownerWaits = users === 0 && signupPolicy(config).ownerByLink;
    const open = !ownerWaits && (config.ALLOW_SIGNUP || users === 0);
    return c.json(
      {
        name: "agentes.chat" as const,
        version,
        api: API,
        minApi: MIN_API,
        url: new URL(config.PUBLIC_URL).origin,
        signIn: { email: true, ...authUiConfig(config).socialProviders },
        signup: open ? ("open" as const) : ("invite" as const),
        ownerClaim: users === 0 && Boolean(config.OWNER_CLAIM_SHA256),
      },
      200,
    );
  });
}
