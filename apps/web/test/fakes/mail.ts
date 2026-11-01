/**
 * Test fake — mailboxes (ADR 0038), same shapes as the server's `…/mail/*` and
 * `…/agents/{id}/mail` routes. Off by default (no way in, like a server without
 * email): tests turn it on with `fake.providers = MAIL_PROVIDERS` and add
 * mailboxes through the API. An IMAP connect fails with the code in `fake.nextError`,
 * and so does the next MillionSend key read; MillionSend keys reach `fake.inboxes`.
 */
import type {
  AgentMailbox,
  ApiClient,
  MailAccount,
  MailConnectError,
  MailProviders,
  MillionSendInbox,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { defaultPolicy } from "@agenteschat/client/lib/mail";
import { clone, MockNotFoundError, mockId } from "./context";

export interface FakeMail {
  client: ApiClient["mail"];
  accounts: MailAccount[];
  providers: MailProviders;
  /** The next IMAP connect, password or key change, or MillionSend key read fails with this code (once). */
  nextError: MailConnectError | "mail.millionsend_inbox_not_found" | "mail.millionsend_no_connector_key" | null;
  /** Per agent, per mailbox. */
  agentMail: Map<string, Map<string, AgentMailbox>>;
  /** What `suggestedAddresses` answers (the mailbox's sent folder). */
  suggested: string[];
  /** The inboxes any MillionSend key reaches. */
  inboxes: Omit<MillionSendInbox, "connected">[];
  /** Whether the next MillionSend connect makes a webhook (new email at once). */
  instant: boolean;
}

export const MAIL_PROVIDERS: MailProviders = {
  composio: true,
  imap: true,
  millionsend: null,
  presets: [
    {
      id: "icloud",
      label: "iCloud",
      imapHost: "imap.mail.me.com",
      imapPort: 993,
      smtpHost: "smtp.mail.me.com",
      smtpPort: 587,
      username: "address",
      appPasswordUrl: "https://account.apple.com/account/manage",
    },
    {
      id: "locaweb",
      label: "Locaweb",
      imapHost: "email-ssl.com.br",
      imapPort: 993,
      smtpHost: "email-ssl.com.br",
      smtpPort: 465,
      username: "address",
      appPasswordUrl: null,
    },
    {
      id: "zoho",
      label: "Zoho",
      imapHost: "imap.zoho.com",
      imapPort: 993,
      smtpHost: "smtp.zoho.com",
      smtpPort: 465,
      username: "address",
      appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
    },
  ],
};

export function createFakeMail(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  meId: () => string | null = () => null,
): FakeMail {
  const fake: FakeMail = {
    accounts: [],
    providers: { composio: false, imap: false, presets: [], millionsend: null },
    nextError: null,
    agentMail: new Map(),
    suggested: [],
    inboxes: [
      {
        id: "7eeb9517-aed7-40d7-ad65-500be42ed147",
        address: "suporte@acme.agents.millionsend.com",
        name: "Suporte",
        kind: "agent",
        shared: true,
      },
      {
        id: "2c6d1e0a-5b4f-4a3e-9c2d-1b0a9f8e7d6c",
        address: "vendas@acme.com.br",
        name: "Vendas",
        kind: "human",
        shared: false,
      },
    ],
    instant: true,
    client: undefined as unknown as ApiClient["mail"],
  };
  const find = (id: string) => {
    const a = fake.accounts.find((x) => x.id === id);
    if (!a) throw new MockNotFoundError("Mailbox not found");
    return a;
  };
  const failOnce = () => {
    const code = fake.nextError;
    if (!code) return;
    fake.nextError = null;
    throw new ApiError(422, code, code);
  };
  const entry = (agentId: string, accountId: string): AgentMailbox =>
    fake.agentMail.get(agentId)?.get(accountId) ?? {
      accountId,
      level: "none",
      canDelete: false,
      policy: defaultPolicy(),
    };
  fake.client = {
    providers: async (orgId) => {
      log("mail.providers", orgId);
      return clone(fake.providers);
    },
    accounts: async () => clone(fake.accounts),
    connectImap: async (orgId, input) => {
      log("mail.connectImap", orgId, { ...input, password: "[redacted]" });
      failOnce();
      const account: MailAccount = {
        id: mockId("mail"),
        provider: "imap",
        via: "imap",
        address: input.address,
        label: input.label ?? input.address,
        status: "active",
        offActions: [],
        askActions: [],
        aliases: [],
        defaultFrom: null,
        lastError: null,
        preset: input.preset === "custom" ? null : input.preset,
        createdAt: now().toISOString(),
        ownerUserId: meId(),
        agents: [],
      };
      fake.accounts.push(account);
      return clone(account);
    },
    millionsendInboxes: async (orgId, input) => {
      log("mail.millionsendInboxes", orgId, input.apiKey ? { apiKey: "[redacted]" } : input);
      failOnce();
      const taken = new Set(fake.accounts.map((a) => a.address));
      return fake.inboxes.map((i) => ({ ...i, connected: taken.has(i.address) }));
    },
    connectMillionSend: async (orgId, { apiKey, ...input }) => {
      log("mail.connectMillionSend", orgId, apiKey ? { ...input, apiKey: "[redacted]" } : input);
      failOnce();
      const inbox = fake.inboxes.find((i) => i.id === input.inboxId);
      if (!inbox) throw new MockNotFoundError("This key doesn't reach that inbox");
      const account: MailAccount = {
        id: mockId("mail"),
        provider: "millionsend",
        via: "millionsend",
        address: inbox.address,
        label: inbox.name ?? inbox.address,
        status: "active",
        offActions: [],
        askActions: [],
        aliases: [],
        defaultFrom: null,
        lastError: null,
        preset: null,
        createdAt: now().toISOString(),
        agents: [],
      };
      fake.accounts.push(account);
      return { account: clone(account), instant: fake.instant };
    },
    connectComposio: async (orgId, input) => {
      log("mail.connectComposio", orgId, input);
      return { accountId: mockId("mail"), redirectUrl: `https://composio.example/connect/${input.provider}` };
    },
    update: async (orgId, accountId, input) => {
      log("mail.update", orgId, accountId, {
        ...input,
        ...(input.password ? { password: "[redacted]" } : {}),
        ...(input.apiKey ? { apiKey: "[redacted]" } : {}),
      });
      if (input.password || input.apiKey) failOnce();
      const a = find(accountId);
      if (input.label) a.label = input.label;
      if (input.offActions) a.offActions = [...input.offActions];
      if (input.askActions) a.askActions = [...input.askActions];
      if (input.aliases) a.aliases = input.aliases.map((x) => x.toLowerCase()).filter((x) => x !== a.address);
      if (input.defaultFrom !== undefined) a.defaultFrom = input.defaultFrom === a.address ? null : input.defaultFrom;
      if (input.password || input.apiKey) {
        a.status = "active";
        a.lastError = null;
      }
      return clone(a);
    },
    suggestedAddresses: async (orgId, accountId) => {
      log("mail.suggestedAddresses", orgId, accountId);
      find(accountId);
      return [...fake.suggested];
    },
    disconnect: async (orgId, accountId) => {
      log("mail.disconnect", orgId, accountId);
      fake.accounts = fake.accounts.filter((a) => a.id !== accountId);
    },
    folders: async (orgId, accountId) => {
      log("mail.folders", orgId, accountId);
      find(accountId);
      return [
        { id: "INBOX", name: "Caixa de entrada", role: "inbox" },
        { id: "Sent", name: "Enviados", role: "sent" },
        { id: "Clientes", name: "Clientes" },
      ];
    },
    // A mailbox still connecting has no agent access yet, as on the server.
    agent: async (_orgId, agentId) =>
      clone(fake.accounts.filter((a) => a.status !== "pending").map((a) => entry(agentId, a.id))),
    setAgent: async (orgId, agentId, accountId, input) => {
      log("mail.setAgent", orgId, agentId, accountId, input);
      if (input.policy.sendWithoutAsking && input.policy.allowedRecipients.length === 0)
        throw new ApiError(422, "send_without_recipients", "Allowed recipients are required");
      const a = fake.accounts.find((x) => x.id === accountId && x.status !== "pending");
      if (!a) throw new ApiError(404, "mail.account_not_found", "Mailbox not found");
      const saved: AgentMailbox = { accountId, ...clone(input) };
      const byAccount = fake.agentMail.get(agentId) ?? new Map<string, AgentMailbox>();
      byAccount.set(accountId, saved);
      fake.agentMail.set(agentId, byAccount);
      a.agents = a.agents.filter((x) => x.agentId !== agentId);
      if (input.level !== "none") a.agents.push({ agentId, level: input.level, canDelete: input.canDelete });
      return clone(saved);
    },
  };
  return fake;
}
