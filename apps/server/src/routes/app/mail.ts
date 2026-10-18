import {
  completeComposioConnect,
  createImapAccount,
  getAgentMail,
  listMailAccounts,
  listMailFolders,
  type MailDeps,
  mailProviders,
  requirePermission,
  revokeMailAccount,
  setAgentMail,
  startComposioConnect,
  updateMailAccount,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError } from "../../http/errors";
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

const tags = ["Mail"];

const MailTestError = z
  .enum(["auth", "imap_unreachable", "smtp_unreachable", "tls", "blocked_host", "unknown"])
  .openapi("MailTestError");

const MailPreset = z
  .object({
    id: z.string(),
    label: z.string(),
    imapHost: z.string(),
    imapPort: z.number(),
    smtpHost: z.string(),
    smtpPort: z.number(),
    username: z.enum(["address", "local"]),
    appPasswordUrl: z.string().nullable(),
  })
  .openapi("MailPreset");

const MailActionName = z
  .enum(["search", "read", "folders", "draft", "organize", "send", "reply", "forward", "delete"])
  .openapi("MailAction");

const MailAccount = z
  .object({
    id: z.uuid(),
    provider: z.enum(["gmail", "outlook", "imap"]),
    via: z.enum(["composio", "imap"]),
    address: z.string(),
    label: z.string(),
    status: z.enum(["pending", "active", "needs_reconnect"]),
    lastError: z.string().nullable(),
    preset: z.string().nullable(),
    createdAt: z.string(),
    offActions: z.array(MailActionName),
    askActions: z.array(MailActionName),
    agents: z.array(z.object({ agentId: z.uuid(), level: z.enum(["read", "read_write"]), canDelete: z.boolean() })),
  })
  .openapi("MailAccount");

const MailFolder = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.enum(["inbox", "sent", "drafts", "trash", "archive", "spam", "all"]).optional(),
  })
  .openapi("MailFolder");

const MailPolicy = z
  .object({
    folders: z.array(z.string().max(300)).max(50),
    senders: z.array(z.string().max(320)).max(200),
    windowDays: z.number().int().min(1).max(3650).nullable(),
    allowedRecipients: z.array(z.string().max(320)).max(200),
    dailySendCap: z.number().int().min(0).max(1000),
    sendWithoutAsking: z.boolean(),
    fromAddress: z.string().max(320).nullable(),
  })
  .openapi("MailPolicy");

const AgentMailbox = z
  .object({
    accountId: z.uuid(),
    level: z.enum(["none", "read", "read_write"]),
    canDelete: z.boolean(),
    policy: MailPolicy,
  })
  .openapi("AgentMailbox");

const testFailed = { 422: json(z.object({ error: MailTestError }), "The connection test failed") };
const AccountParams = OrgParams.extend({ accountId: z.uuid() });

/**
 * People's mailboxes for agents (ADR 0038): the org connects Gmail/Outlook
 * (Composio) or any IMAP mailbox once; each agent gets a level and a policy
 * per mailbox.
 */
export function mailRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  for (const path of ["/organizations/*", "/mail/*"]) app.use(path, requireSession(deps.auth));
  const mailDeps: MailDeps = {
    db,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    mail: adapters.mail,
    publicUrl: config.PUBLIC_URL,
    resolveHost: deps.extras?.resolveHost,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/mail/providers",
      tags,
      security,
      summary: "Which mailboxes this server can connect (Gmail/Outlook through Composio, IMAP presets)",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ composio: z.boolean(), imap: z.boolean(), presets: z.array(MailPreset) })),
        ...errors,
      },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "read");
      return c.json(mailProviders(adapters.mail), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/mail/accounts",
      tags,
      security,
      summary: "Connected mailboxes and which agents use them (no secrets)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ accounts: z.array(MailAccount) })), ...errors },
    }),
    async (c) => {
      const accounts = await listMailAccounts(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ accounts }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/mail/accounts/imap",
      tags,
      security,
      summary: "Connect an IMAP/SMTP mailbox with an app password (admins); tested before saving",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            preset: z.string().min(1).max(40),
            address: z.string().min(3).max(320),
            password: z.string().min(1).max(500),
            label: z.string().max(80).optional(),
            username: z.string().max(320).optional(),
            imapHost: z.string().max(253).optional(),
            imapPort: z.number().int().min(1).max(65535).optional(),
            smtpHost: z.string().max(253).optional(),
            smtpPort: z.number().int().min(1).max(65535).optional(),
          }),
        ),
      },
      responses: { 201: json(z.object({ account: MailAccount }), "Connected"), ...testFailed, ...errors },
    }),
    async (c) => {
      const r = await createImapAccount(mailDeps, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      if (!r.ok) return c.json({ error: r.error }, 422);
      return c.json({ account: r.account }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/mail/accounts/composio",
      tags,
      security,
      summary: "Start connecting Gmail or Outlook (admins); open the returned URL",
      description: "409 when Gmail and Outlook are not configured on this server.",
      request: {
        params: OrgParams,
        body: body(z.object({ provider: z.enum(["gmail", "outlook"]), label: z.string().max(80).optional() })),
      },
      responses: { 200: json(z.object({ accountId: z.uuid(), redirectUrl: z.string() })), ...errors },
    }),
    async (c) => {
      const r = await startComposioConnect(mailDeps, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json(r, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/mail/composio/callback",
      tags,
      security,
      summary: "Where Composio sends the person back (browser navigation)",
      description:
        "Reads the connected account, then redirects to the connectors screen with `mail=connected` or `mail=failed`, and `account=<id>`.",
      request: { query: z.object({ account: z.uuid() }) },
      responses: { 302: { description: "Back to the web app" }, ...errors },
    }),
    async (c) => {
      const base = config.PUBLIC_URL.replace(/\/$/, "");
      const accountId = c.req.valid("query").account;
      const r = await completeComposioConnect(mailDeps, c.get("user").id, accountId).catch(() => null);
      const account = `account=${encodeURIComponent(accountId)}`;
      if (!r) return c.redirect(`${base}/?mail=failed&${account}`, 302);
      return c.redirect(
        `${base}/org/${r.orgId}/settings/connectors?mail=${r.ok ? "connected" : "failed"}&${account}`,
        302,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/mail/accounts/{accountId}",
      tags,
      security,
      summary:
        "Rename a mailbox, turn its actions on or off for every agent, or replace an IMAP mailbox's app password (tested first) (admins)",
      request: {
        params: AccountParams,
        body: body(
          z.object({
            label: z.string().max(80).optional(),
            password: z.string().min(1).max(500).optional(),
            offActions: z.array(MailActionName).max(9).optional(),
            askActions: z
              .array(z.enum(["draft", "organize"]))
              .max(2)
              .optional(),
          }),
        ),
      },
      responses: { 200: json(z.object({ account: MailAccount })), ...testFailed, ...errors },
    }),
    async (c) => {
      const { orgId, accountId } = c.req.valid("param");
      const r = await updateMailAccount(mailDeps, c.get("user").id, orgId, accountId, c.req.valid("json"));
      if (!r.ok) return c.json({ error: r.error }, 422);
      return c.json({ account: r.account }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/mail/accounts/{accountId}",
      tags,
      security,
      summary: "Disconnect a mailbox (agents lose access; routines watching it stop) (admins)",
      request: { params: AccountParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, accountId } = c.req.valid("param");
      await revokeMailAccount(mailDeps, c.get("user").id, orgId, accountId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/mail/accounts/{accountId}/folders",
      tags,
      security,
      summary: "A mailbox's folders (for limiting an agent to some of them) (admins)",
      request: { params: AccountParams },
      responses: { 200: json(z.object({ folders: z.array(MailFolder) })), ...errors },
    }),
    async (c) => {
      const { orgId, accountId } = c.req.valid("param");
      const folders = await listMailFolders(mailDeps, c.get("user").id, orgId, accountId);
      return c.json({ folders }, 200);
    },
  );

  // ── Agents' access ─────────────────────────────────────────────────────────
  const AgentParams = OrgParams.extend({ agentId: z.uuid() });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/mail",
      tags,
      security,
      summary: "What an agent may do with each connected mailbox",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ mailboxes: z.array(AgentMailbox) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ mailboxes: await getAgentMail(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/mail/{accountId}",
      tags,
      security,
      summary: "Set an agent's access to a mailbox: level, delete, and its policy (admins)",
      description:
        "`sendWithoutAsking` needs a non-empty `allowedRecipients` (422 otherwise). Addresses and domains are lowercased.",
      request: {
        params: AgentParams.extend({ accountId: z.uuid() }),
        body: body(
          z.object({ level: z.enum(["none", "read", "read_write"]), canDelete: z.boolean(), policy: MailPolicy }),
        ),
      },
      responses: {
        200: json(AgentMailbox),
        422: json(z.object({ error: z.literal("send_without_recipients") }), "Sending without asking needs recipients"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId, accountId } = c.req.valid("param");
      try {
        const r = await setAgentMail(db, c.get("user").id, orgId, agentId, accountId, c.req.valid("json"));
        return c.json(r, 200);
      } catch (error) {
        // The web app reads this plain code (like the IMAP test errors).
        if (error instanceof ValidationError && error.code === "mail.send_without_asking_needs_recipients") {
          return c.json({ error: "send_without_recipients" as const }, 422);
        }
        if (error instanceof ValidationError) return apiError(c, 400, error.code, error.message, error.params);
        throw error;
      }
    },
  );

  return app;
}
