import { afterEach, expect, test } from "bun:test";
import {
  createFakeComposioClient,
  createFakeMailConnector,
  createFakeMailPoller,
  createFakeMailTester,
  FAKE_COMPOSIO_SIGNATURE,
  type MailAdapters,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
  t = undefined as never;
});

const ICLOUD = {
  id: "icloud",
  label: "iCloud",
  imapHost: "imap.mail.me.com",
  imapPort: 993,
  smtpHost: "smtp.mail.me.com",
  smtpPort: 587,
  username: "address" as const,
  appPasswordUrl: "https://account.apple.com",
};

function fakeMail() {
  const box = createFakeMailConnector();
  const tester = createFakeMailTester();
  const composio = createFakeComposioClient();
  const mail: MailAdapters = {
    composio: { client: composio.client, connector: box.connector },
    imap: { connector: box.connector, poller: createFakeMailPoller().poller, tester: tester.tester, presets: [ICLOUD] },
  };
  return { mail, box, tester, composio };
}

test("without mail adapters: no providers, Gmail connect is a conflict", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  expect(await (await owner(`/api/app/organizations/${orgId}/mail/providers`)).json()).toEqual({
    composio: false,
    imap: false,
    presets: [],
  });
  const r = await owner(`/api/app/organizations/${orgId}/mail/accounts/composio`, { json: { provider: "gmail" } });
  expect(r.status).toBe(409);
  expect((await owner("/api/webhooks/composio", { json: {} })).status).toBe(404);
});

test("mail API: IMAP account (tested), Gmail through Composio, agent access, folders, disconnect", async () => {
  const fake = fakeMail();
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  expect(await (await api("/mail/providers")).json()).toEqual({ composio: true, imap: true, presets: [ICLOUD] });

  fake.tester.state.result = { ok: false, error: "auth" };
  const failed = await api("/mail/accounts/imap", {
    json: { preset: "icloud", address: "support@icloud.com", password: "wrong" },
  });
  expect(failed.status).toBe(422);
  expect(await failed.json()).toEqual({ error: "auth" });
  fake.tester.state.result = { ok: true, sentFolder: "Sent" };
  const created = await api("/mail/accounts/imap", {
    json: { preset: "icloud", address: "support@icloud.com", password: "abcd-efgh-ijkl", label: "Suporte" },
  });
  expect(created.status).toBe(201);
  const { account } = (await created.json()) as { account: { id: string; status: string } };
  expect(account.status).toBe("active");

  // Gmail: start, the person signs in at Composio, comes back to the callback.
  const started = (await (await api("/mail/accounts/composio", { json: { provider: "gmail" } })).json()) as {
    accountId: string;
    redirectUrl: string;
  };
  expect(started.redirectUrl).toBe("https://composio.example/connect/ca_1");
  fake.composio.activate("ca_1", "walt@gmail.com");
  const back = await owner(`/api/app/mail/composio/callback?account=${started.accountId}`);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe(
    `${t.config.PUBLIC_URL}/org/${orgId}/settings/connectors?mail=connected&account=${started.accountId}`,
  );

  const listed = await (await api("/mail/accounts")).text();
  expect(listed).not.toContain("abcd-efgh");
  const accounts = (JSON.parse(listed) as { accounts: { id: string; address: string; status: string }[] }).accounts;
  expect(accounts.map((a) => [a.address, a.status])).toEqual([
    ["support@icloud.com", "active"],
    ["walt@gmail.com", "active"],
  ]);

  // Agent access: sending without asking needs allowed recipients.
  const policy = {
    folders: [],
    senders: [],
    windowDays: null,
    allowedRecipients: [],
    dailySendCap: 25,
    sendWithoutAsking: true,
    fromAddress: null,
  };
  const bad = await api(`/agents/${agentId}/mail/${account.id}`, {
    method: "PUT",
    json: { level: "read_write", canDelete: false, policy },
  });
  expect(bad.status).toBe(422);
  expect(await bad.json()).toEqual({ error: "send_without_recipients" });
  const ok = await api(`/agents/${agentId}/mail/${account.id}`, {
    method: "PUT",
    json: { level: "read_write", canDelete: true, policy: { ...policy, allowedRecipients: ["@Acme.com"] } },
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ accountId: account.id, level: "read_write", canDelete: true });
  const mailboxes = (await (await api(`/agents/${agentId}/mail`)).json()) as {
    mailboxes: { accountId: string; level: string; policy: { allowedRecipients: string[] } }[];
  };
  expect(mailboxes.mailboxes.map((x) => [x.accountId, x.level])).toEqual([
    [account.id, "read_write"],
    [started.accountId, "none"],
  ]);
  expect(mailboxes.mailboxes[0]?.policy.allowedRecipients).toEqual(["@acme.com"]);
  const withAgents = (await (await api("/mail/accounts")).json()) as { accounts: { agents: unknown[] }[] };
  expect(withAgents.accounts[0]?.agents).toEqual([{ agentId, level: "read_write", canDelete: true }]);

  const folders = (await (await api(`/mail/accounts/${account.id}/folders`)).json()) as { folders: { id: string }[] };
  expect(folders.folders.map((f) => f.id)).toContain("INBOX");

  const renamed = await api(`/mail/accounts/${account.id}`, { method: "PATCH", json: { label: "Help desk" } });
  expect(((await renamed.json()) as { account: { label: string } }).account.label).toBe("Help desk");

  expect((await api(`/mail/accounts/${account.id}`, { method: "DELETE" })).status).toBe(204);
  expect(((await (await api("/mail/accounts")).json()) as { accounts: unknown[] }).accounts).toHaveLength(1);
  const scopes = await t.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, account.id));
  expect(scopes).toEqual([]);
});

test("email routines through the routines API, woken by a signed Composio webhook", async () => {
  const fake = fakeMail();
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const { accountId } = (await (await api("/mail/accounts/composio", { json: { provider: "gmail" } })).json()) as {
    accountId: string;
  };
  fake.composio.activate("ca_1", "walt@gmail.com");
  await owner(`/api/app/mail/composio/callback?account=${accountId}`);
  await api(`/agents/${agentId}/mail/${accountId}`, {
    method: "PUT",
    json: {
      level: "read",
      canDelete: false,
      policy: {
        folders: [],
        senders: [],
        windowDays: null,
        allowedRecipients: [],
        dailySendCap: 25,
        sendWithoutAsking: false,
        fromAddress: null,
      },
    },
  });

  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Triage support mail",
      target: { type: "dm" },
      trigger: { type: "email", accountId, filter: { from: ["@acme.com"] } },
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as { id: string; trigger: Record<string, unknown> };
  expect(routine.trigger).toEqual({
    type: "email",
    accountId,
    folder: "INBOX",
    filter: { from: ["@acme.com"] },
    status: "active",
  });
  const [triggerId] = [...fake.composio.state.triggers.keys()];

  const hook = (body: unknown, signature = FAKE_COMPOSIO_SIGNATURE) =>
    t.app.request("/api/webhooks/composio", {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-signature": signature },
      body: JSON.stringify(body),
    });
  const event = {
    type: "mail.received",
    triggerId,
    connectedAccountId: "ca_1",
    message: {
      id: "g1",
      from: { address: "ana@acme.com" },
      to: [],
      cc: [],
      subject: "Help",
      date: new Date().toISOString(),
      snippet: "please",
      unread: true,
      hasAttachments: false,
    },
  };
  expect((await hook(event, "v1,forged")).status).toBe(401);
  const accepted = await hook(event);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ ok: true, type: "mail.received", fired: 1 });
  // Retried by Composio: the same message never runs twice.
  expect(await (await hook(event)).json()).toMatchObject({ fired: 0 });
  const runs = await t.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  expect(runs).toHaveLength(1);

  // Listing shows the email trigger; deleting the routine deletes the trigger.
  const listed = (await (await api("/routines")).json()) as { routines: { id: string; trigger: { type: string } }[] };
  expect(listed.routines.find((r) => r.id === routine.id)?.trigger.type).toBe("email");
  expect((await api(`/routines/${routine.id}`, { method: "DELETE" })).status).toBe(204);
  expect(fake.composio.state.triggers.size).toBe(0);
});
