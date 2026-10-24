import {
  ARTIFACT_LIMITS,
  authenticateMachine,
  confirmDeviceCode,
  DeviceCodeLimitError,
  deleteMachine,
  denyDeviceCode,
  getDeviceCode,
  listMachineOutages,
  listMachines,
  machineOrgLogo,
  moveAgentsFromMachine,
  pollDeviceToken,
  receiveMachineUpload,
  reduceMachineAccess,
  renameMachine,
  setAgentComputerTarget,
  startDeviceCode,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { installScript } from "../../runner/install-script";
import { requestIp } from "../http/client-ip";
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

export const MachineAccess = z
  .object({
    folders: z.array(
      z.object({
        path: z.string().openapi({ description: "Absolute path on the machine." }),
        agents: z.array(z.string()).openapi({ description: "Agent ids that may use it (empty: none yet)." }),
      }),
    ),
    tools: z.object({
      claude: z.boolean(),
      codex: z.boolean(),
      commands: z.boolean(),
      browser: z
        .boolean()
        .optional()
        .openapi({ description: "The agent browser (protocol 12, ADR 0040); absent = off." }),
      desktop: z
        .boolean()
        .optional()
        .openapi({ description: "The agents' desktops (protocol 18, ADR 0056); absent = off." }),
      terminal: z
        .boolean()
        .optional()
        .openapi({ description: "Terminals people open as an agent (protocol 18, ADR 0056); absent = off." }),
    }),
  })
  .openapi("MachineAccess");

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
    protocol: z.number().int().openapi({ description: "The runner's machine protocol (9+: pause; 10+: access)." }),
    execAllowed: z.boolean().openapi({ description: "`false`: started with `--no-exec` (files and uploads only)." }),
    paused: z
      .object({ until: z.string().nullable() })
      .nullable()
      .openapi({ description: "The owner paused it (no new work); `until` null: until resumed (`machine.updated`)." }),
    pairedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    agents: z.array(z.object({ id: z.uuid(), name: z.string(), handle: z.string() })),
    workspace: z
      .string()
      .nullable()
      .openapi({ description: "Workspace folder on the machine; null unless admin or the person who paired it." }),
    access: MachineAccess.nullable().openapi({
      description:
        "Folders and tools allowed on the machine (protocol 10); null unless admin or the person who paired it, or when the runner doesn't report it.",
    }),
    browser: z
      .object({
        available: z.boolean(),
        version: z.string().nullable(),
        chrome: z.string().nullable(),
        reason: z.string().nullable().openapi({ description: "Why it can't run yet, from the runner." }),
      })
      .nullable()
      .openapi({
        description:
          "Whether the agent browser can run there (protocol 12, ADR 0040); null when its runner doesn't report it. Turned on by the person at the computer (`access.tools.browser`).",
      }),
    desktopUse: z
      .object({
        available: z.boolean(),
        reason: z.string().nullable().openapi({ description: "Why it can't, from the runner (what to install)." }),
      })
      .nullable()
      .openapi({
        description:
          "Whether agents can use their own desktops there (protocol 19, ADR 0057): only where each agent works as its own OS user. Null when its runner doesn't report it.",
      }),
    canManage: z.boolean().openapi({ description: "This person may rename, delete or reduce its access." }),
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
const UserCode = z.string().min(6).max(16).openapi({ example: "K7Q4ZP" });
const UserCodeParams = z.object({ userCode: UserCode });

const DeviceCode = z
  .object({
    userCode: z.string().openapi({ example: "K7Q4ZP", description: "Shown as `K7Q·4ZP`." }),
    name: z.string(),
    os: z.string(),
    arch: z.string(),
    hostname: z.string(),
    version: z.string(),
    approxLocation: z.string().nullable().openapi({ description: "Roughly where the request came from, when known." }),
    createdAt: z.string(),
    expiresAt: z.string(),
    reconnect: z
      .object({ machineId: z.uuid(), name: z.string(), orgId: z.uuid(), orgName: z.string() })
      .optional()
      .openapi({
        description:
          "The code brings back this machine (same name, permissions and agents); only for people who may manage it.",
      }),
  })
  .openapi("MachineDeviceCode");

const AgentParams = OrgParams.extend({ agentId: z.uuid() });

const ComputerBrain = z.enum(["claude_code", "codex"]);
const Platform = z
  .string()
  .openapi({ description: "`mac`, `windows`, `linux`, `cloud`, or the runner's `os` as reported." });

const MachineOutage = z
  .object({
    machineId: z.uuid(),
    name: z.string(),
    platform: Platform,
    offlineSince: z.string().openapi({ description: "ISO time of its last sign of life." }),
    agents: z.array(
      z.object({
        agentId: z.uuid(),
        name: z.string(),
        brain: ComputerBrain,
        waiting: z.object({
          routines: z.number().int().openapi({ description: "Routine runs waiting for this computer." }),
          conversations: z.number().int().openapi({ description: "Other runs (messages) waiting for it." }),
        }),
      }),
    ),
    waitingRuns: z.number().int().openapi({ description: "Runs of these agents waiting for this computer." }),
  })
  .openapi("MachineOutage");

const OutageTarget = z
  .union([
    z.object({
      kind: z.literal("machine"),
      machineId: z.uuid(),
      name: z.string(),
      platform: Platform,
      online: z.boolean(),
      brains: z.array(ComputerBrain).openapi({ description: "Computer brains it can run (`brainOptions`)." }),
      reasonOff: z
        .string()
        .nullable()
        .openapi({ description: "Why it can't take agents now: `offline`, `paused`; null when it can." }),
    }),
    z.object({
      kind: z.literal("cloud"),
      available: z.boolean().openapi({ description: "A cloud sandbox provider is configured on this server." }),
      brains: z
        .array(ComputerBrain)
        .openapi({ description: "Always empty: Claude Code and Codex agents need a connected computer." }),
    }),
  ])
  .openapi("OutageTarget");

const MoveTarget = z.union([
  z.object({ kind: z.literal("machine"), machineId: z.uuid() }),
  z.object({ kind: z.literal("cloud") }),
]);

const MoveAgentsResult = z
  .object({
    moved: z.array(z.uuid()),
    skipped: z.array(
      z.object({ agentId: z.string(), reason: z.enum(["brain_unavailable", "forbidden", "not_found"]) }),
    ),
    resumed: z.number().int().openapi({ description: "Waiting runs queued again on the new computer." }),
    stillWaiting: z.number().int().openapi({
      description: "Waiting runs that stay with the old computer (their cut-off turn already ran tools there).",
    }),
  })
  .openapi("MoveAgentsResult");

/**
 * Connected computers in the web app (ADR 0025, ADR 0036): list, confirm or
 * deny a computer's connection code, rename, delete, reduce its access, and
 * which computer an agent uses. Session + CSRF like the rest of `/api/app`.
 */
export function machineAppRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/machines/*", requireSession(deps.auth));
  const hub = () => {
    const machines = deps.extras?.sandbox?.machines?.hub;
    if (!machines) throw new ValidationError("Connected computers are not available on this server");
    return machines;
  };

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
      method: "get",
      path: "/machines/device/{userCode}",
      tags,
      security,
      summary: "What asked for this connection code (the confirm page), for any signed-in person",
      request: { params: UserCodeParams },
      responses: { 200: json(DeviceCode), 429: errorResponse("Too many lookups"), ...errors },
    }),
    async (c) => {
      const limit = await deps.adapters.rateLimiter.consume(`machine-device-view:${c.get("user").id}`, {
        limit: 30,
        windowMs: 60_000,
      });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many attempts; try again in a minute");
      return c.json(await getDeviceCode({ db }, c.req.valid("param").userCode, c.get("user").id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/device/{userCode}/confirm",
      tags,
      security,
      summary:
        "Connect the computer that shows this code to the organization (members who can post); it gets its token on its next poll",
      request: {
        params: OrgParams.extend({ userCode: UserCode }),
        body: body(z.object({ name: z.string().max(80).optional() })),
      },
      responses: { 201: json(Machine, "Connected"), ...errors },
    }),
    async (c) => {
      const { orgId, userCode } = c.req.valid("param");
      const machine = await confirmDeviceCode({ db, pubsub }, c.get("user").id, orgId, userCode, c.req.valid("json"));
      return c.json(machine, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/machines/device/{userCode}/deny",
      tags,
      security,
      summary: '"It wasn\'t me": the computer that shows this code is refused (`access_denied`)',
      request: { params: UserCodeParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await denyDeviceCode({ db }, c.get("user").id, c.req.valid("param").userCode);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/access/reduce",
      tags,
      security,
      summary:
        "Remove a folder (for everyone or one agent) or turn a tool off on the machine (admins or the person who paired it); never widens",
      request: {
        params: MachineParams,
        body: body(
          z
            .object({
              removeFolder: z.object({ path: z.string().min(1).max(1024), agentId: z.uuid().optional() }).optional(),
              disableTool: z.enum(["claude", "codex", "commands", "browser", "desktop", "terminal"]).optional(),
            })
            .strict(),
        ),
      },
      responses: {
        200: json(z.object({ access: MachineAccess })),
        ...errors,
        409: errorResponse("The computer is offline (`machine.offline`)"),
      },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const access = await reduceMachineAccess(
        { db, pubsub, hub: hub() },
        c.get("user").id,
        orgId,
        machineId,
        c.req.valid("json"),
      );
      return c.json({ access }, 200);
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

  const outageDeps = () => ({ db, pubsub, cloudAvailable: Boolean(deps.extras?.sandbox?.provider) });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/outages",
      tags,
      security,
      summary:
        "Offline computers that some agents think on, with the agents this person may move, and where they could go",
      description:
        "Changes come as `machine.status` and `machine.agents_moved` org events; clients also poll while an outage is shown.",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ outages: z.array(MachineOutage), targets: z.array(OutageTarget) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await listMachineOutages(outageDeps(), c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/move-agents",
      tags,
      security,
      summary:
        'Move agents off this computer ("Trocar computador"): admins any agent, others their own; waiting runs go on there',
      request: {
        params: MachineParams,
        body: body(z.object({ agentIds: z.array(z.uuid()).min(1).max(100), target: MoveTarget })),
      },
      responses: { 200: json(MoveAgentsResult), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const result = await moveAgentsFromMachine(outageDeps(), c.get("user").id, orgId, machineId, c.req.valid("json"));
      return c.json(result, 200);
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

const DeviceBody = z.object({
  name: z.string().max(80).default(""),
  os: z.string().max(20).default("other"),
  arch: z.string().max(40).default(""),
  hostname: z.string().max(200).default(""),
  version: z.string().max(40).default(""),
  protocol: z.number().int().optional(),
  workspace: z.string().max(500).optional(),
  exec: z.boolean().optional(),
  /** A refused computer asking to come back as the machine it was (reconnect); ignored unless a uuid. */
  previousMachineId: z.string().max(64).optional(),
});

/** New codes per address per minute, and polls (every 3 s by contract: 20 a minute, with room for two computers). */
const DEVICE_START_LIMIT = { limit: 10, windowMs: 60_000 };
const DEVICE_POLL_LIMIT = { limit: 60, windowMs: 60_000 };

/**
 * What the runner calls, with no session (ADR 0025, ADR 0036): the
 * device-code connection (`POST /api/machines/device`, `…/device/token`;
 * rate limited per address), `PUT /api/machines/uploads/{uploadId}` and
 * `GET /api/machines/org-logo` (its machine token) and
 * `GET /api/machines/install.sh`. No CSRF: no cookie is
 * read here. The WebSocket `/api/machines/connect` lives in `Bun.serve`
 * (`realtime/machines.ts`).
 */
export function registerMachinePublicRoutes(api: OpenAPIHono, deps: AppDeps) {
  const { db, config, adapters } = deps;

  api.openapi(
    createRoute({
      method: "post",
      path: "/machines/device",
      tags,
      summary: "A computer asks for a connection code (the desktop app or `agentes-runner pair`)",
      request: { body: body(DeviceBody) },
      responses: {
        200: json(
          z
            .object({
              deviceCode: z.string().openapi({ description: "Secret: only the computer keeps it, to poll." }),
              userCode: z.string().openapi({ example: "K7Q4ZP" }),
              verificationUrl: z.string(),
              expiresIn: z.number().int(),
              interval: z.number().int(),
            })
            .openapi("MachineDeviceStart"),
        ),
        400: errorResponse("Invalid body or runner too old"),
        429: errorResponse("Too many requests or pending codes from this address"),
      },
    }),
    async (c) => {
      const ip = requestIp(c.req.raw.headers);
      const limit = await adapters.rateLimiter.consume(`machine-device:${ip}`, DEVICE_START_LIMIT);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many attempts; try again in a minute");
      try {
        const started = await startDeviceCode({ db, publicUrl: config.PUBLIC_URL }, c.req.valid("json"), { ip });
        return c.json(started, 200);
      } catch (error) {
        if (error instanceof DeviceCodeLimitError) return apiError(c, 429, "machine.device_too_many", error.message);
        if (error instanceof ValidationError) return apiError(c, 400, error.code, error.message);
        throw error;
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/machines/device/token",
      tags,
      summary: "The computer polls for its token (OAuth device flow errors until it is confirmed)",
      request: { body: body(z.object({ deviceCode: z.string().min(1).max(200) })) },
      responses: {
        200: json(
          z
            .object({
              token: z.string().openapi({ description: "The machine token (`agm_…`), returned once." }),
              machineId: z.uuid(),
              name: z.string(),
              org: z.object({ id: z.uuid(), name: z.string() }),
            })
            .openapi("MachineDeviceToken"),
        ),
        400: json(
          z
            .object({ error: z.enum(["authorization_pending", "slow_down", "access_denied", "expired_token"]) })
            .openapi("MachineDeviceTokenError"),
          "Not yet, too fast, refused or expired",
        ),
        429: errorResponse("Too many polls"),
      },
    }),
    async (c) => {
      const ip = requestIp(c.req.raw.headers);
      const limit = await adapters.rateLimiter.consume(`machine-device-poll:${ip}`, DEVICE_POLL_LIMIT);
      if (!limit.allowed) return c.json({ error: "slow_down" as const }, 400);
      const result = await pollDeviceToken({ db, pubsub: adapters.pubsub }, c.req.valid("json").deviceCode);
      if (!result.ok) return c.json({ error: result.error }, 400);
      const { ok: _ok, ...token } = result;
      return c.json(token, 200);
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

  // The organization's logo for the desktop app (the runner fetches it; the
  // app's web view never sees the token). The file name is a content hash: the ETag.
  api.get("/machines/org-logo", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const machine = token ? await authenticateMachine(db, token) : null;
    if (!machine) return apiError(c, 401, "machine.unauthorized", "This computer's token is not valid");
    const logo = await machineOrgLogo({ db, blobs: adapters.platformBlobs }, machine.orgId);
    if (!logo) return apiError(c, 404, "org.logo_not_found", "The organization has no logo");
    const etag = `"${logo.file}"`;
    const headers = { etag, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" };
    const match = c.req.header("if-none-match") ?? "";
    if (match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(logo.body, {
      status: 200,
      headers: { ...headers, "content-type": logo.contentType, "content-security-policy": "sandbox" },
    });
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
