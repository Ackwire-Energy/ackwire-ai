import {
  accountLoginStatus,
  beginAccountLogin,
  cancelAccountLogin,
  getMachineAccounts,
  listAiAccounts,
  refreshAiAccounts,
  removeMachineAccount,
  renameMachineAccount,
  sendAccountLoginCode,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
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
import { AccountKind, MachineAccount, PlanUsage } from "./schemas";
import { SecretBox } from "./secrets";

const tags = ["Connected computers"];

const MachineParams = OrgParams.extend({ machineId: z.uuid() });
const LoginParams = MachineParams.extend({ loginId: z.uuid() });
const AccountParams = MachineParams.extend({ accountId: z.uuid() });

const AccountLogin = z
  .object({
    loginId: z.uuid(),
    kind: AccountKind,
    url: z.string().openapi({
      description: "The provider's page: Claude's sign-in, Codex's device page, or where a coding plan's key is made.",
    }),
    provider: z.string().optional().openapi({ description: "A coding plan's key account: the plan." }),
    publicKey: z.string().optional().openapi({
      description:
        "Claude Code: the computer's key for this sign-in (raw P-256, base64). The browser seals the pasted code to it (AAD `loginId|orgId|account`).",
    }),
    userCode: z.string().optional().openapi({ description: "Codex: the one-time code to type on its page." }),
    expiresAt: z.string(),
  })
  .openapi("AccountLogin");

const AccountLoginStatus = z
  .object({
    state: z.enum(["waiting", "done", "failed", "expired"]),
    account: MachineAccount.optional().openapi({ description: "Once `done`: the account, stored." }),
    error: z.string().optional().openapi({ description: "`failed`: why, for people." }),
    duplicate: z.object({ label: z.string() }).optional().openapi({
      description:
        "`failed`: the caller already has this account on this computer (named `label`); the new sign-in is removed there.",
    }),
  })
  .openapi("AccountLoginStatus");

const offline = {
  409: errorResponse("The computer is offline (`machine.offline`) or its runner is too old (`account.runner_old`)"),
};

/**
 * Accounts of the computer brains on a connected computer (ADR 0041, ADR
 * 0059): an account is the person's who started its sign-in (through the
 * provider's own CLI on the computer). The person who connected the computer
 * adds accounts there, or anyone on a computer nobody connected; only an
 * account's owner sees its email, renames it, continues its sign-in or
 * signs in to it again; its owner or whoever connected the computer removes it.
 * Session + CSRF like the rest of `/api/app`.
 */
export function machineAccountRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const withHub = () => {
    const hub = deps.extras?.sandbox?.machines?.hub;
    if (!hub) throw new ValidationError("Connected computers are not available on this server");
    return { db, pubsub, hub };
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/{machineId}/accounts",
      tags,
      security,
      summary:
        "The computer's Claude, ChatGPT and coding plan accounts (the person who connected it, an admin, or anyone where nobody did)",
      description:
        "Emails only of the caller's own accounts. Changes come as `machine.updated` org events with `accounts: true`.",
      request: { params: MachineParams },
      responses: {
        200: json(
          z.object({
            accounts: z.array(MachineAccount),
            canManage: z.boolean().openapi({
              description:
                "The caller adds accounts there (they connected it, or nobody did) and its runner knows accounts (protocol 13).",
            }),
            supported: z.boolean().openapi({ description: "Its runner knows accounts (protocol 13)." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      return c.json(await getMachineAccounts({ db }, c.get("user").id, orgId, machineId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins",
      tags,
      security,
      summary: "Start signing in an account on the computer, through the provider's own CLI there",
      description:
        "The account is the caller's from now on. The person who connected the computer adds accounts there, or anyone on a computer nobody connected.",
      request: {
        params: MachineParams,
        body: body(
          z.object({
            kind: AccountKind,
            accountId: z
              .string()
              .uuid()
              .optional()
              .openapi({ description: "Sign in again to this account of the caller's (it was signed out)." }),
            email: z.string().max(254).optional().openapi({
              description:
                "Claude Code: which account to sign in to (the CLI's login hint). Letters, digits and `._+-` only (`account.invalid_email`).",
            }),
            provider: z.string().max(20).optional().openapi({
              description:
                "A coding plan on Claude Code (`zai`, `kimi`, `minimax`, `opencode`): a key account. The key is sent next like a code, sealed to the computer (`account.invalid_plan`; a runner without plans' keys: `account.runner_old`).",
            }),
          }),
        ),
      },
      responses: {
        201: json(AccountLogin, "Started"),
        429: errorResponse("Too many sign-ins started"),
        ...errors,
        ...offline,
      },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const { kind, accountId, email, provider } = c.req.valid("json");
      const userId = c.get("user").id;
      // Each one starts the provider's CLI on the computer, and on a shared one any member may.
      const limit = await deps.adapters.rateLimiter.consume(`account-login:${userId}:${machineId}`, {
        limit: 10,
        windowMs: 15 * 60_000,
      });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many sign-ins started. Try again later.");
      const login = await beginAccountLogin(withHub(), userId, orgId, machineId, kind, accountId, email, provider);
      return c.json(login, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}/code",
      tags,
      security,
      summary:
        "Hand the Claude code (or a coding plan's key), sealed in the browser to the computer's key, to the waiting sign-in",
      description:
        "Only the person who started the sign-in. We relay it to the computer in memory and keep nothing of it.",
      request: { params: LoginParams, body: body(z.object({ box: SecretBox })) },
      responses: { 204: noContent[204], ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId, loginId } = c.req.valid("param");
      await sendAccountLoginCode(withHub(), c.get("user").id, orgId, machineId, loginId, c.req.valid("json").box);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}",
      tags,
      security,
      summary: "Where a sign-in is; once done, the account is stored and returned (the person who started it)",
      request: { params: LoginParams },
      responses: { 200: json(AccountLoginStatus), ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId, loginId } = c.req.valid("param");
      return c.json(await accountLoginStatus(withHub(), c.get("user").id, orgId, machineId, loginId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}",
      tags,
      security,
      summary: "Cancel a sign-in (the computer stops the CLI and removes its folder; the person who started it)",
      request: { params: LoginParams },
      responses: { 204: noContent[204], ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId, loginId } = c.req.valid("param");
      await cancelAccountLogin(withHub(), c.get("user").id, orgId, machineId, loginId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/ai-accounts",
      tags,
      security,
      summary: "The caller's AI accounts on the organization's computers, and where they can add one (any member)",
      description:
        "Their plans and keys, each with its computer (emails and key hints are the caller's own). Changes come as `machine.updated` org events with `accounts: true`.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z
            .object({
              accounts: z.array(MachineAccount.extend({ machineId: z.uuid(), computer: z.string() })),
              computers: z.array(
                z.object({
                  machineId: z.uuid(),
                  name: z.string(),
                  online: z.boolean(),
                  mine: z.boolean().openapi({ description: "The caller connected it." }),
                  canAdd: z.boolean().openapi({
                    description:
                      "The caller adds accounts there (they connected it, or nobody did) and its runner knows accounts.",
                  }),
                  keys: z.boolean().openapi({ description: "Its runner takes coding plans' keys (protocol 20)." }),
                  brains: z.object({ claude_code: z.boolean(), codex: z.boolean() }).openapi({
                    description:
                      "What it can think with now: Claude Code (Claude, the coding plans) and Codex (ChatGPT).",
                  }),
                  own: z
                    .object({
                      claude_code: z.object({ plan: z.string().optional(), usage: PlanUsage.optional() }).optional(),
                      codex: z.object({ plan: z.string().optional(), usage: PlanUsage.optional() }).optional(),
                    })
                    .openapi({
                      description:
                        "Each CLI's own sign-in there (\"this computer's account\"), on a computer the caller connected: its plan and usage when known.",
                    }),
                }),
              ),
            })
            .openapi("AiAccounts"),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await listAiAccounts({ db }, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/ai-accounts/refresh",
      tags,
      security,
      summary: "Look the caller's plans' usage up again (an accounts screen is open)",
      description:
        "The caller's accounts, and the own sign-ins of the computers they connected, on every online computer. Each computer looks at most every few minutes per account; what it finds comes as `machine.updated` org events with `accounts: true`.",
      request: { params: OrgParams },
      responses: { 202: { description: "Asked" }, ...errors },
    }),
    async (c) => {
      await refreshAiAccounts(withHub(), c.get("user").id, c.req.valid("param").orgId);
      return c.body(null, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/machines/{machineId}/accounts/{accountId}",
      tags,
      security,
      summary: "Rename an account (its owner)",
      request: { params: AccountParams, body: body(z.object({ label: z.string().min(1).max(40) })) },
      responses: { 200: json(MachineAccount), ...errors },
    }),
    async (c) => {
      const { orgId, machineId, accountId } = c.req.valid("param");
      const account = await renameMachineAccount(
        { db, pubsub },
        c.get("user").id,
        orgId,
        machineId,
        accountId,
        c.req.valid("json").label,
      );
      return c.json(account, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/machines/{machineId}/accounts/{accountId}",
      tags,
      security,
      summary:
        "Remove an account: the computer signs it out and deletes its folder; agents that used it go back to the computer's own sign-in",
      description:
        "Its owner, the person who connected the computer, or an admin where the computer or the account has no person. With the computer off, it is removed there when it comes back.",
      request: { params: AccountParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId, accountId } = c.req.valid("param");
      await removeMachineAccount(withHub(), c.get("user").id, orgId, machineId, accountId);
      return c.body(null, 204);
    },
  );

  return app;
}
