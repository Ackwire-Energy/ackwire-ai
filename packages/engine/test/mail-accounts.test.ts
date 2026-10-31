import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  completeComposioConnect,
  createImapAccount,
  ForbiddenError,
  getAgentMail,
  listAgentScopes,
  listMailAccounts,
  markNeedsReconnect,
  openMailProvider,
  revokeMailAccount,
  setAgentScopes,
  startComposioConnect,
  suggestMailAddresses,
  updateMailAccount,
  ValidationError,
} from "../src";
import { addMember } from "./fixtures";
import { giveMail, gmailAccount, imapAccount, type MailFixture, mailSetup, PUBLIC_URL } from "./mail-fixtures";

let m: MailFixture;
afterEach(async () => {
  await m?.f.close();
  m = undefined as never;
});

test("an IMAP mailbox is tested before it's saved; the password is sealed and never in a view", async () => {
  m = await mailSetup();
  const { f, deps, tester } = m;
  tester.state.result = { ok: false, error: "auth" };
  expect(
    await createImapAccount(deps, f.owner.id, f.org.id, {
      preset: "icloud",
      address: "a@example.com",
      password: "nope",
    }),
  ).toEqual({ ok: false, error: "auth" });
  expect(await f.db.select().from(schema.mailAccounts)).toEqual([]);

  tester.state.result = { ok: true, sentFolder: "Sent Messages" };
  const r = await createImapAccount(deps, f.owner.id, f.org.id, {
    preset: "icloud",
    address: "Support@Example.com",
    password: "abcd-efgh-ijkl-mnop",
    label: "Suporte",
  });
  if (!r.ok) throw new Error("expected ok");
  expect(r.account).toMatchObject({
    provider: "imap",
    via: "imap",
    address: "support@example.com",
    label: "Suporte",
    status: "active",
    preset: "icloud",
    agents: [],
  });
  expect(tester.state.calls.at(-1)?.imap).toMatchObject({
    host: "imap.mail.me.com",
    smtpHost: "smtp.mail.me.com",
    username: "support@example.com",
    password: "abcd-efgh-ijkl-mnop",
  });
  const [row] = await f.db.select().from(schema.mailAccounts);
  expect(row?.secretCiphertext).toBeTruthy();
  expect(row?.secretCiphertext).not.toContain("abcd-efgh");
  expect(row?.sentFolder).toBe("Sent Messages");
  expect(JSON.stringify(await listMailAccounts(f.db, f.owner.id, f.org.id))).not.toContain("abcd-efgh");
  // The connector gets the opened password, in memory, only when the mailbox is used.
  await openMailProvider(deps, f.org.id, r.account.id);
  expect(m.box.state.opened.at(-1)?.imap?.password).toBe("abcd-efgh-ijkl-mnop");

  await expect(
    createImapAccount(deps, f.owner.id, f.org.id, { preset: "icloud", address: "support@example.com", password: "x" }),
  ).rejects.toBeInstanceOf(ConflictError);
  const member = await addMember(f.db, f.org.id, "member");
  await expect(
    createImapAccount(deps, member.id, f.org.id, { preset: "icloud", address: "b@example.com", password: "x" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("custom hosts can't point inside our network", async () => {
  m = await mailSetup();
  const { f, deps, tester } = m;
  const custom = (imapHost: string, smtpHost = "smtp.example.com") =>
    createImapAccount(deps, f.owner.id, f.org.id, {
      preset: "custom",
      address: "me@host.example.com",
      password: "pw",
      imapHost,
      smtpHost,
    });
  expect(await custom("localhost")).toEqual({ ok: false, error: "blocked_host" });
  expect(await custom("169.254.169.254")).toEqual({ ok: false, error: "blocked_host" });
  expect(await custom("mail.internal-corp.net")).toEqual({ ok: false, error: "blocked_host" }); // resolves to 10.x
  expect(await custom("imap.example.com", "10.0.0.1")).toEqual({ ok: false, error: "blocked_host" });
  expect(tester.state.calls).toEqual([]);
  expect((await custom("imap.example.com")).ok).toBe(true);
  await expect(
    createImapAccount(deps, f.owner.id, f.org.id, { preset: "nope", address: "x@y.com", password: "pw" }),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("rotating an IMAP password re-tests it and brings a mailbox back from needs_reconnect", async () => {
  m = await mailSetup();
  const { f, deps, tester } = m;
  const account = await imapAccount(m);
  await f.db
    .update(schema.mailAccounts)
    .set({ status: "needs_reconnect" })
    .where(eq(schema.mailAccounts.id, account.id));
  tester.state.result = { ok: false, error: "auth" };
  expect(await updateMailAccount(deps, f.owner.id, f.org.id, account.id, { password: "bad" })).toEqual({
    ok: false,
    error: "auth",
  });
  tester.state.result = { ok: true, sentFolder: null };
  const r = await updateMailAccount(deps, f.owner.id, f.org.id, account.id, { password: "good-one", label: "Help" });
  expect(r).toMatchObject({ ok: true, account: { status: "active", label: "Help" } });
  await openMailProvider(deps, f.org.id, account.id);
  expect(m.box.state.opened.at(-1)?.imap?.password).toBe("good-one");
});

test("a mailbox's other addresses: normalised, a default among them, pinned agents reset when one goes", async () => {
  m = await mailSetup();
  const { f, deps } = m;
  const account = await imapAccount(m, "me@icloud.com");
  expect(account).toMatchObject({ aliases: [], defaultFrom: null });
  const r = await updateMailAccount(deps, f.owner.id, f.org.id, account.id, {
    aliases: [" Support@Acme.com", "support@acme.com", "ME@icloud.com", "sales@acme.com"],
    defaultFrom: "Support@acme.com",
  });
  expect(r).toMatchObject({
    ok: true,
    account: { aliases: ["support@acme.com", "sales@acme.com"], defaultFrom: "support@acme.com" },
  });
  await expect(
    updateMailAccount(deps, f.owner.id, f.org.id, account.id, { defaultFrom: "ceo@acme.com" }),
  ).rejects.toMatchObject({ code: "mail.from_not_mailbox" });
  await expect(
    updateMailAccount(deps, f.owner.id, f.org.id, account.id, { aliases: ["not an address"] }),
  ).rejects.toMatchObject({ code: "mail.invalid_alias" });
  // The main address as the default is stored as "none" (it is the default anyway).
  expect(
    await updateMailAccount(deps, f.owner.id, f.org.id, account.id, { defaultFrom: "me@icloud.com" }),
  ).toMatchObject({ account: { defaultFrom: null } });

  await updateMailAccount(deps, f.owner.id, f.org.id, account.id, { defaultFrom: "sales@acme.com" });
  await giveMail(m, account.id, "read_write", { fromAddress: "sales@acme.com" });
  // sales@ goes: the default and the agent pinned to it go back to the main address and "automatic".
  const after = await updateMailAccount(deps, f.owner.id, f.org.id, account.id, { aliases: ["support@acme.com"] });
  expect(after).toMatchObject({ account: { aliases: ["support@acme.com"], defaultFrom: null } });
  expect((await getAgentMail(f.db, f.owner.id, f.org.id, f.agent.id))[0]?.policy.fromAddress).toBeNull();

  const member = await addMember(f.db, f.org.id, "member");
  await expect(updateMailAccount(deps, member.id, f.org.id, account.id, { aliases: [] })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

test("suggested addresses are the Froms of the sent folder's recent mail", async () => {
  m = await mailSetup();
  const { f, deps } = m;
  const account = await imapAccount(m, "me@icloud.com");
  m.box.add({ id: "s1", folder: "Sent", from: { address: "support@acme.com" }, date: "2026-10-20T10:00:00Z" });
  m.box.add({ id: "s2", folder: "Sent", from: { address: "me@icloud.com" }, date: "2026-10-21T10:00:00Z" });
  m.box.add({ id: "s3", folder: "Sent", from: { address: "Sales@Acme.com" }, date: "2026-10-22T10:00:00Z" });
  m.box.add({ id: "i1", folder: "INBOX", from: { address: "ana@client.com" } });
  expect(await suggestMailAddresses(deps, f.owner.id, f.org.id, account.id)).toEqual([
    "sales@acme.com",
    "support@acme.com",
  ]);
  // A mailbox that can't be read suggests nothing (the person types them).
  m.box.state.failWith = new Error("down");
  expect(await suggestMailAddresses(deps, f.owner.id, f.org.id, account.id)).toEqual([]);
});

test("Gmail through Composio: a pending row, Composio's link, then active with its address", async () => {
  m = await mailSetup();
  const { f, deps, composio } = m;
  const started = await startComposioConnect(deps, f.owner.id, f.org.id, { provider: "gmail" });
  expect(started.redirectUrl).toBe("https://composio.example/connect/ca_1");
  expect(composio.state.links[0]).toMatchObject({
    toolkit: "gmail",
    userId: `org_${f.org.id}`,
    callbackUrl: `${PUBLIC_URL}/api/app/mail/composio/callback?account=${started.accountId}`,
  });
  expect((await listMailAccounts(f.db, f.owner.id, f.org.id))[0]).toMatchObject({ status: "pending", address: "" });

  // Not finished at Composio yet: stays pending.
  expect(await completeComposioConnect(deps, f.owner.id, started.accountId)).toEqual({ orgId: f.org.id, ok: false });
  composio.activate("ca_1", "Team@Example.com");
  expect(await completeComposioConnect(deps, f.owner.id, started.accountId)).toEqual({ orgId: f.org.id, ok: true });
  expect((await listMailAccounts(f.db, f.owner.id, f.org.id))[0]).toMatchObject({
    provider: "gmail",
    via: "composio",
    status: "active",
    address: "team@example.com",
  });

  // A connection that failed at Composio goes away.
  const second = await startComposioConnect(deps, f.owner.id, f.org.id, { provider: "outlook" });
  const ca = composio.state.links[1]?.connectedAccountId ?? "";
  const remote = composio.state.accounts.get(ca);
  if (remote) remote.status = "failed";
  expect(await completeComposioConnect(deps, f.owner.id, second.accountId)).toEqual({ orgId: f.org.id, ok: false });
  expect(await listMailAccounts(f.db, f.owner.id, f.org.id)).toHaveLength(1);
});

test("Reconectar on a Gmail that needs it: the new sign-in takes the mailbox's place, and its agents stay", async () => {
  m = await mailSetup();
  const { f, deps, composio } = m;
  const gmail = await gmailAccount(m);
  await giveMail(m, gmail.accountId, "read_write");
  await markNeedsReconnect(f.db, gmail.accountId, "composio_expired");
  const signInAgain = async (address: string) => {
    const started = await startComposioConnect(deps, f.owner.id, f.org.id, {
      provider: "gmail",
      accountId: gmail.accountId,
    });
    const link = composio.state.links.at(-1);
    composio.activate(link?.connectedAccountId ?? "", address);
    return { link, done: await completeComposioConnect(deps, f.owner.id, started.accountId) };
  };

  // Signed in to another mailbox: it doesn't take this one's place.
  const other = await signInAgain("someone@example.com");
  expect(other.done).toEqual({ orgId: f.org.id, ok: false });
  expect(await listMailAccounts(f.db, f.owner.id, f.org.id)).toMatchObject([
    { id: gmail.accountId, address: "team@example.com", status: "needs_reconnect", lastError: "other_mailbox" },
  ]);

  const same = await signInAgain("Team@Example.com");
  expect(same.link?.callbackUrl).toBe(`${PUBLIC_URL}/api/app/mail/composio/callback?account=${gmail.accountId}`);
  expect(same.done).toEqual({ orgId: f.org.id, ok: true });
  expect(await listMailAccounts(f.db, f.owner.id, f.org.id)).toMatchObject([
    {
      id: gmail.accountId,
      address: "team@example.com",
      status: "active",
      lastError: null,
      agents: [{ agentId: f.agent.id, level: "read_write" }],
    },
  ]);
  // Composio forgets the refused account and the other mailbox's, and nothing is revoked at Google.
  expect(composio.state.deletedAccounts).toEqual([gmail.connectedAccountId, other.link?.connectedAccountId ?? ""]);
  expect(composio.state.revokedAccounts).toEqual([]);

  // Only a mailbox that needs it reconnects this way.
  await expect(
    startComposioConnect(deps, f.owner.id, f.org.id, { provider: "gmail", accountId: gmail.accountId }),
  ).rejects.toBeInstanceOf(ConflictError);
});

test("without Composio configured, connecting Gmail is a conflict", async () => {
  m = await mailSetup({ composio: false });
  await expect(startComposioConnect(m.deps, m.f.owner.id, m.f.org.id, { provider: "gmail" })).rejects.toBeInstanceOf(
    ConflictError,
  );
});

test("disconnecting removes the agents' mail grants and Composio's account; other grants stay", async () => {
  m = await mailSetup();
  const { f, deps, composio } = m;
  const gmail = await gmailAccount(m);
  await giveMail(m, gmail.accountId, "read_write");
  expect(await getAgentMail(f.db, f.owner.id, f.org.id, f.agent.id)).toMatchObject([
    { accountId: gmail.accountId, level: "read_write", canDelete: false },
  ]);
  // Replacing the agent's other scopes keeps its mail grants (the mail API manages them).
  await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "context:read" }]);
  expect((await listAgentScopes(f.db, f.org.id, f.agent.id)).map((g) => g.scope).sort()).toEqual([
    "context:read",
    "mail:draft",
    "mail:organize",
    "mail:read",
    "mail:send",
  ]);
  // Sending them back unchanged (the agent screen round-trips its scopes) works too.
  await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, await listAgentScopes(f.db, f.org.id, f.agent.id));

  await revokeMailAccount(deps, f.owner.id, f.org.id, gmail.accountId);
  expect(composio.state.deletedAccounts).toEqual([gmail.connectedAccountId]);
  expect(composio.state.revokedAccounts).toEqual([gmail.connectedAccountId]);
  expect((await listAgentScopes(f.db, f.org.id, f.agent.id)).map((g) => g.scope)).toEqual(["context:read"]);
  expect(await listMailAccounts(f.db, f.owner.id, f.org.id)).toEqual([]);
  expect(await getAgentMail(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual([]);
});

test("agent policies are normalised; sending without asking needs allowed recipients", async () => {
  m = await mailSetup();
  const account = await imapAccount(m);
  await expect(giveMail(m, account.id, "read_write", { sendWithoutAsking: true })).rejects.toMatchObject({
    code: "mail.send_without_asking_needs_recipients",
  });
  await expect(giveMail(m, account.id, "read", { dailySendCap: 5000 })).rejects.toBeInstanceOf(ValidationError);
  await expect(giveMail(m, account.id, "read", { senders: ["not an address"] })).rejects.toBeInstanceOf(
    ValidationError,
  );
  // The agent's From is one of the mailbox's addresses.
  await expect(giveMail(m, account.id, "read", { fromAddress: "hi@example.com" })).rejects.toMatchObject({
    code: "mail.from_not_mailbox",
  });
  await updateMailAccount(m.deps, m.f.owner.id, m.f.org.id, account.id, { aliases: ["hi@example.com"] });
  const r = await giveMail(
    m,
    account.id,
    "read",
    {
      senders: ["Bob@Acme.com", "ACME.COM", "@x.org"],
      allowedRecipients: ["@Acme.com"],
      fromAddress: "Hi@Example.com",
    },
    true,
  );
  expect(r).toMatchObject({
    level: "read",
    canDelete: true,
    policy: {
      senders: ["bob@acme.com", "@acme.com", "@x.org"],
      allowedRecipients: ["@acme.com"],
      fromAddress: "hi@example.com",
    },
  });
  const member = await addMember(m.f.db, m.f.org.id, "member");
  await expect(
    giveMail({ ...m, f: { ...m.f, owner: member } } as MailFixture, account.id, "read"),
  ).rejects.toBeInstanceOf(ForbiddenError);
});
