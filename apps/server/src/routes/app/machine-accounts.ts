import {
  accountLoginStatus,
  beginAccountLogin,
  cancelAccountLogin,
  getMachineAccounts,
  removeMachineAccount,
  renameMachineAccount,
  sendAccountLoginCode,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { errorResponse } from "../../http/errors";
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
import { AccountKind, MachineAccount } from "./schemas";
import { SecretBox } from "./secrets";

const tags = ["Connected computers"];

const MachineParams = OrgParams.extend({ machineId: z.uuid() });
const LoginParams = MachineParams.extend({ loginId: z.uuid() });
const AccountParams = MachineParams.extend({ accountId: z.uuid() });

const AccountLogin = z
  .object({
    loginId: z.uuid(),
    kind: AccountKind,
    url: z.string().openapi({ description: "The provider's page: Claude's sign-in, or Codex's device page." }),
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
  })
  .openapi("AccountLoginStatus");

const offline = {
  409: errorResponse("The computer is offline (`machine.offline`) or its runner is too old (`account.runner_old`)"),
};

/**
 * Accounts of the computer brains on a connected computer (ADR 0041): only
 * the person who connected it adds (signs in through the provider's own
 * CLI on the computer), renames or removes them. Session + CSRF like the
 * rest of `/api/app`.
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
      summary: "The computer's Claude Code and Codex accounts (the person who connected it, or an admin)",
      description: "Changes come as `machine.updated` org events with `accounts: true`.",
      request: { params: MachineParams },
      responses: {
        200: json(
          z.object({
            accounts: z.array(MachineAccount),
            canManage: z
              .boolean()
              .openapi({ description: "The caller connected it and its runner knows accounts (protocol 13)." }),
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
      request: { params: MachineParams, body: body(z.object({ kind: AccountKind })) },
      responses: { 201: json(AccountLogin, "Started"), ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const login = await beginAccountLogin(withHub(), c.get("user").id, orgId, machineId, c.req.valid("json").kind);
      return c.json(login, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}/code",
      tags,
      security,
      summary: "Hand the Claude code, sealed in the browser to the computer's key, to the waiting sign-in",
      description: "We relay it to the computer in memory and keep nothing of it.",
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
      summary: "Where a sign-in is; once done, the account is stored and returned",
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
      summary: "Cancel a sign-in (the computer stops the CLI and removes its folder)",
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
      method: "patch",
      path: "/organizations/{orgId}/machines/{machineId}/accounts/{accountId}",
      tags,
      security,
      summary: "Rename an account (the person who connected the computer)",
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
      request: { params: AccountParams },
      responses: { 204: noContent[204], ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId, accountId } = c.req.valid("param");
      await removeMachineAccount(withHub(), c.get("user").id, orgId, machineId, accountId);
      return c.body(null, 204);
    },
  );

  return app;
}
