import {
  ARTIFACT_LIMITS,
  authenticateMachine,
  createMachinePairing,
  deleteMachine,
  listMachines,
  receiveMachineUpload,
  redeemMachinePairing,
  renameMachine,
  setAgentComputerTarget,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { installScript } from "../../runner/install-script";
import { apiError, domainErrorResponse, errorResponse } from "../http/errors";
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
} from "./app/context";

const tags = ["Connected computers"];

/** Headers and framing around a pushed file: the body may be a little over the file limit. */
const UPLOAD_SLACK_BYTES = 64 * 1024;

export const Machine = z
  .object({
    id: z.uuid(),
    name: z.string(),
    online: z.boolean().openapi({ description: "Runner connected now. Changes come as `machine.status` events." }),
    lastSeenAt: z.string().nullable(),
    hostname: z.string(),
    os: z.string().openapi({ description: "`linux`, `darwin`, `windows` or `other`." }),
    arch: z.string(),
    runnerVersion: z.string(),
    execAllowed: z.boolean().openapi({ description: "`false`: started with `--no-exec` (files and uploads only)." }),
    pairedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    agents: z.array(z.object({ id: z.uuid(), name: z.string(), handle: z.string() })),
    workspace: z
      .string()
      .nullable()
      .openapi({ description: "Workspace folder on the machine; null unless admin or the person who paired it." }),
    canManage: z.boolean().openapi({ description: "This person may rename or delete it." }),
    createdAt: z.string(),
  })
  .openapi("Machine");

export const ComputerTarget = z
  .union([
    z.object({ kind: z.literal("cloud") }),
    z.object({ kind: z.literal("machine"), machineId: z.uuid(), name: z.string(), online: z.boolean() }),
  ])
  .openapi("ComputerTarget");

const MachineParams = OrgParams.extend({ machineId: z.uuid() });
const AgentParams = OrgParams.extend({ agentId: z.uuid() });

/**
 * Connected computers in the web app (ADR 0025): list, pair (a one-time
 * code and the install command), rename, delete, and which computer an
 * agent uses. Session + CSRF like the rest of `/api/app`.
 */
export function machineAppRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines",
      tags,
      security,
      summary: "Connected computers of the organization (every member)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ machines: z.array(Machine) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ machines: await listMachines(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/pairings",
      tags,
      security,
      summary: "Create a one-time pairing code (10 minutes) and the command to run on the machine",
      request: { params: OrgParams, body: body(z.object({ name: z.string().min(1).max(80) })) },
      responses: {
        201: json(
          z
            .object({
              code: z.string().openapi({ example: "K7QM-4XTB" }),
              expiresAt: z.string(),
              installCommand: z.string(),
            })
            .openapi("MachinePairing"),
          "Created",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const pairing = await createMachinePairing(
        { db, pubsub, publicUrl: config.PUBLIC_URL },
        c.get("user").id,
        orgId,
        c.req.valid("json"),
      );
      return c.json(pairing, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/machines/{machineId}",
      tags,
      security,
      summary: "Rename (the person who paired it or an admin)",
      request: { params: MachineParams, body: body(z.object({ name: z.string().min(1).max(80) })) },
      responses: { 200: json(z.object({ id: z.uuid(), name: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      return c.json(await renameMachine({ db, pubsub }, c.get("user").id, orgId, machineId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/machines/{machineId}",
      tags,
      security,
      summary: "Remove it: the token stops working and its runner is disconnected at once",
      request: { params: MachineParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      await deleteMachine({ db, pubsub }, c.get("user").id, orgId, machineId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/computer/target",
      tags,
      security,
      summary:
        "Which computer the agent uses: a connected machine, or null for the cloud computer (admins; or the owner with a machine they paired)",
      request: { params: AgentParams, body: body(z.object({ machineId: z.uuid().nullable() })) },
      responses: { 200: json(ComputerTarget), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const target = await setAgentComputerTarget(
        { db, pubsub },
        c.get("user").id,
        orgId,
        agentId,
        c.req.valid("json").machineId,
      );
      return c.json(target, 200);
    },
  );

  return app;
}

/** Reads at most `max` bytes of a body; null when it is longer. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const PairBody = z.object({
  code: z.string().min(1).max(40),
  name: z.string().max(80).optional(),
  hostname: z.string().max(200),
  os: z.string().max(20),
  arch: z.string().max(40),
  version: z.string().max(40),
  protocol: z.number().int(),
  workspace: z.string().max(500),
  exec: z.boolean(),
});

/**
 * What the runner calls, with no session (ADR 0025): `POST /api/machines/pair`
 * (a pairing code; rate limited), `PUT /api/machines/uploads/{uploadId}`
 * (its machine token) and `GET /api/machines/install.sh`. No CSRF: no
 * cookie is read here. The WebSocket `/api/machines/connect` lives in
 * `Bun.serve` (`realtime/machines.ts`).
 */
export function registerMachinePublicRoutes(api: OpenAPIHono, deps: AppDeps) {
  const { db, config, adapters } = deps;

  api.openapi(
    createRoute({
      method: "post",
      path: "/machines/pair",
      tags,
      summary: "Trade a pairing code for a machine token (the runner's `pair`)",
      request: { body: body(PairBody) },
      responses: {
        200: json(z.object({ machineId: z.uuid(), name: z.string(), token: z.string() }).openapi("MachinePaired")),
        400: errorResponse("Invalid, used or expired code"),
        429: errorResponse("Too many attempts"),
      },
    }),
    async (c) => {
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const limit = await adapters.rateLimiter.consume(`machine-pair:${ip}`, { limit: 10, windowMs: 60_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many attempts; try again in a minute");
      try {
        const paired = await redeemMachinePairing({ db, pubsub: adapters.pubsub }, c.req.valid("json"));
        return c.json(paired, 200);
      } catch (error) {
        if (error instanceof ValidationError) return apiError(c, 400, error.code, error.message);
        throw error;
      }
    },
  );

  api.put("/machines/uploads/:uploadId", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const machine = token ? await authenticateMachine(db, token) : null;
    if (!machine) return apiError(c, 401, "machine.unauthorized", "This computer's token is not valid");
    const max = ARTIFACT_LIMITS.fileBytes + UPLOAD_SLACK_BYTES;
    const maxMb = ARTIFACT_LIMITS.fileBytes / 1024 / 1024;
    const tooLarge = () =>
      apiError(c, 413, "artifact.file_too_large", `The file is too large (max ${maxMb} MB)`, { maxMb });
    if (Number(c.req.header("content-length") ?? "0") > max) return tooLarge();
    const uploadId = c.req.param("uploadId");
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) return apiError(c, 404, "upload.not_found", "Upload not found");
    let name = "file";
    try {
      name = decodeURIComponent(c.req.header("x-agentes-file-name") ?? "") || "file";
    } catch {
      return apiError(c, 400, "invalid_request", "x-agentes-file-name must be URI-encoded");
    }
    const headerUpload = c.req.header("x-agentes-upload-id");
    if (headerUpload && headerUpload !== uploadId) {
      return apiError(c, 400, "invalid_request", "x-agentes-upload-id does not match the URL");
    }
    const bytes = await readCapped(c.req.raw, max);
    if (!bytes) return tooLarge();
    try {
      const { artifact } = await receiveMachineUpload(
        { db, artifacts: deps.extras?.artifacts ?? missingArtifacts(), pubsub: adapters.pubsub },
        {
          uploadId,
          machineId: machine.id,
          name: name.slice(0, 255),
          contentType: c.req.header("content-type") ?? "application/octet-stream",
          sha256: c.req.header("x-agentes-sha256") ?? "",
          body: bytes,
        },
      );
      return c.json({ ok: true, artifactId: artifact.id, version: artifact.shownVersion }, 200);
    } catch (error) {
      const mapped = domainErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  api.get("/machines/install.sh", (c) =>
    c.body(installScript(config.PUBLIC_URL), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
}

function missingArtifacts(): never {
  throw new Error("the Drive is not configured on this server");
}
