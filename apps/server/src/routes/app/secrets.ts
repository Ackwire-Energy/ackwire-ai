import {
  declineSecret,
  deliverSecret,
  getSecretRequest,
  listAgentSecrets,
  NotFoundError,
  removeAgentSecret,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Secrets"];

const Target = z
  .union([
    z.object({ kind: z.literal("env") }),
    z.object({ kind: z.literal("file"), path: z.string() }),
    z.object({ kind: z.literal("site"), site: z.string() }),
  ])
  .openapi({
    description:
      "Where it goes on the computer: an environment variable of the agent's commands, a file in its folder, or `site`: only the agent's browser types it, on that site, never its commands.",
  });

const SecretRequest = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    messageId: z.uuid().nullable(),
    requestedForUserId: z.string(),
    name: z.string(),
    purpose: z.string(),
    target: Target,
    site: z
      .string()
      .nullable()
      .openapi({ description: "For a browser password: the only site it may be typed on (https://host)." }),
    machineId: z.uuid().nullable(),
    publicKey: z
      .string()
      .nullable()
      .openapi({ description: "The computer's key for this request (raw P-256, base64); null once it is closed." }),
    status: z.enum(["pending", "delivered", "declined", "expired", "canceled"]),
    expiresAt: z.string(),
    deliveredAt: z.string().nullable(),
    removed: z.boolean(),
  })
  .openapi("SecretRequest");

export const SecretBox = z
  .object({
    v: z.literal(1),
    epk: z.string().max(200),
    iv: z.string().max(40),
    ct: z.string().max(40_000),
  })
  .openapi("SecretBox", {
    description:
      "The value sealed in the browser to the request's public key (ECDH P-256, HKDF-SHA256, AES-256-GCM; ADR 0027). We relay it to the computer and keep nothing of it.",
  });

const AgentSecret = z
  .object({
    name: z.string(),
    target: Target,
    machineId: z.uuid().nullable(),
    deliveredAt: z.string(),
    deliveredByUserId: z.string(),
  })
  .openapi("AgentSecret");

const RequestParams = OrgParams.extend({ requestId: z.uuid() });
const AgentParams = OrgParams.extend({ agentId: z.uuid() });

/**
 * Secrets agents ask people for (ADR 0027). Only the person asked sees and
 * answers a request; the value travels sealed to the agent's computer and is
 * never stored or shown again.
 */
export function secretRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const sandbox = () => {
    const s = deps.extras?.sandbox;
    if (!s) throw new NotFoundError("Agent computers are not available on this server");
    return s;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/secret-requests/{requestId}",
      tags,
      security,
      summary: "A secret an agent asked you for",
      request: { params: RequestParams },
      responses: { 200: json(SecretRequest), ...errors },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      return c.json(await getSecretRequest(db, c.get("user").id, orgId, requestId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/secret-requests/{requestId}/deliver",
      tags,
      security,
      summary: "Send the sealed secret to the agent's computer; the agent continues",
      request: { params: RequestParams, body: body(z.object({ box: SecretBox })) },
      responses: { 200: json(SecretRequest), ...errors },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      const view = await deliverSecret(
        { ...sandbox(), pubsub: adapters.pubsub },
        c.get("user").id,
        orgId,
        requestId,
        c.req.valid("json").box,
      );
      deps.wakeWorkers?.();
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/secret-requests/{requestId}/decline",
      tags,
      security,
      summary: "Decline an agent's secret request; the agent continues without it",
      request: { params: RequestParams },
      responses: { 200: json(SecretRequest), ...errors },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      const view = await declineSecret(
        { db, pubsub: adapters.pubsub, sandbox: deps.extras?.sandbox ?? null },
        c.get("user").id,
        orgId,
        requestId,
      );
      deps.wakeWorkers?.();
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/secrets",
      tags,
      security,
      summary: "Secrets on the agent's computers (names only; the agent's owner or an admin)",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ secrets: z.array(AgentSecret) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ secrets: await listAgentSecrets(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}/secrets/{name}",
      tags,
      security,
      summary: "Remove a secret from the agent's computer (and the file holding it)",
      request: {
        params: AgentParams.extend({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }),
        query: z.object({ machineId: z.uuid().optional() }),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, agentId, name } = c.req.valid("param");
      const { machineId } = c.req.valid("query");
      await removeAgentSecret(sandbox(), c.get("user").id, orgId, agentId, name, machineId ?? null);
      return c.body(null, 204);
    },
  );

  return app;
}
