import { afterEach, expect, test } from "bun:test";
import {
  FAKE_MILLIONSEND_INBOX_KEY,
  FAKE_MILLIONSEND_KEY,
  MailError,
  type MailSummary,
  standardWebhookSignature,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  createMillionSendAccount,
  createRoutine,
  createScheduleToolSource,
  ForbiddenError,
  ForbiddenSignatureError,
  handleMillionSendWebhook,
  listApprovals,
  listMailAccounts,
  listMillionSendInboxes,
  MAILBOX_NOT_GIVEN_TEXT,
  markNeedsReconnect,
  millionSendWebhookUrl,
  NotFoundError,
  pollMailWatches,
  type RoutineDeps,
  revokeMailAccount,
  sealSecret,
  setRoutineActive,
  UNTRUSTED_NOTE,
  updateMailAccount,
  ValidationError,
} from "../src";
import { addMember } from "./fixtures";
import { giveMail, imapAccount, type MailFixture, mailSetup, millionSendAccount, runContext } from "./mail-fixtures";

let m: MailFixture;
afterEach(async () => {
  await m?.f.close();
  m = undefined as never;
});

const HTTPS = "https://agentes.example.com";
const THREAD = "b9e1837b-c150-45c6-a055-73b02ec9f1dc";
const EMAIL = "155252fb-e93e-45ee-8c19-5080a929c28b";

const inboxOf = (x: MailFixture) => {
  const inbox = x.millionsend.state.inboxes[0];
  if (!inbox) throw new Error("no inbox");
  return inbox;
};

const routineDeps = (x: MailFixture): RoutineDeps => ({ db: x.f.db, pubsub: x.f.pubsub, mail: x.mail });

async function emailRoutine(x: MailFixture, accountId: string) {
  return createRoutine(routineDeps(x), x.f.owner.id, x.f.org.id, {
    agentId: x.f.agent.id,
    prompt: "Answer new support mail",
    target: { type: "dm" },
    trigger: { type: "email", accountId, folder: "INBOX", filter: {} },
  });
}

const runsOf = async (x: MailFixture, routineId: string) =>
  x.f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));

/** An `inbox.email.received` delivery, signed with `secret` as MillionSend signs it. */
function delivery(inboxId: string, secret: string, over: { folder?: string; emailId?: string } = {}) {
  const body = JSON.stringify({
    type: "inbox.email.received",
    created_at: new Date().toISOString(),
    data: {
      source: "system",
      inbox_id: inboxId,
      thread_id: THREAD,
      email_id: over.emailId ?? EMAIL,
      thread: {
        object: "inbox_thread",
        id: THREAD,
        subject: "Pedido 1042",
        folder: over.folder ?? "inbox",
        read: false,
      },
      email: {
        id: over.emailId ?? EMAIL,
        direction: "inbound",
        from: "Maria Silva <maria@example.org>",
        to: [inboxOf(m).address],
        cc: [],
        subject: "Pedido 1042",
        attachments: [],
        read: false,
        received_at: new Date().toISOString(),
      },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const id = `msg_${Math.random()}`;
  const headers = new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": standardWebhookSignature(secret, id, ts, body),
  });
  return { headers, body };
}

test("the key's inboxes come first; the mailbox keeps its key sealed and never shows it", async () => {
  m = await mailSetup();
  const { f, deps } = m;
  const inbox = inboxOf(m);
  expect(await listMillionSendInboxes(deps, f.owner.id, f.org.id, { apiKey: "ms_wrong" })).toEqual({
    ok: false,
    error: "auth",
  });
  await expect(listMillionSendInboxes(deps, f.owner.id, f.org.id, {})).rejects.toBeInstanceOf(ValidationError);
  expect(await listMillionSendInboxes(deps, f.owner.id, f.org.id, { apiKey: FAKE_MILLIONSEND_KEY })).toEqual({
    ok: true,
    inboxes: [{ ...inbox, connected: false }],
  });
  // Only who manages connectors.
  const member = await addMember(f.db, f.org.id, "member");
  await expect(
    listMillionSendInboxes(deps, member.id, f.org.id, { apiKey: FAKE_MILLIONSEND_KEY }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    createMillionSendAccount(deps, f.owner.id, f.org.id, {
      apiKey: FAKE_MILLIONSEND_KEY,
      inboxId: "00000000-0000-4000-8000-000000000999",
    }),
  ).rejects.toBeInstanceOf(NotFoundError);

  const r = await millionSendAccount(m);
  expect(r.account).toMatchObject({
    provider: "millionsend",
    via: "millionsend",
    address: inbox.address,
    label: "Suporte",
    status: "active",
    agents: [],
  });
  // This server isn't reachable (http): no webhook, polled.
  expect(r.instant).toBe(false);
  expect(m.millionsend.state.webhooks.size).toBe(0);
  const [row] = await f.db.select().from(schema.mailAccounts);
  expect(row?.externalAccountId).toBe(inbox.id);
  expect(JSON.stringify(row)).not.toContain(FAKE_MILLIONSEND_KEY);
  expect(JSON.stringify(await listMailAccounts(f.db, f.owner.id, f.org.id))).not.toContain(FAKE_MILLIONSEND_KEY);
  const again = await listMillionSendInboxes(deps, f.owner.id, f.org.id, { apiKey: FAKE_MILLIONSEND_KEY });
  expect(again.ok && again.inboxes[0]?.connected).toBe(true);
  await expect(millionSendAccount(m)).rejects.toBeInstanceOf(ConflictError);
});

test("the webhook: only for a server MillionSend can reach, signed with our secret, gone on disconnect", async () => {
  expect(millionSendWebhookUrl("http://localhost:3000")).toBeNull();
  expect(millionSendWebhookUrl("https://localhost")).toBeNull();
  expect(millionSendWebhookUrl("https://agentes.local")).toBeNull();
  expect(millionSendWebhookUrl("https://10.0.0.5")).toBeNull();
  expect(millionSendWebhookUrl(`${HTTPS}/`)).toBe(`${HTTPS}/api/webhooks/millionsend`);

  m = await mailSetup({ publicUrl: HTTPS });
  const { f, deps } = m;
  const inbox = inboxOf(m);
  // A key limited to the inbox reads it, but can't create webhooks: polled.
  const limited = await millionSendAccount(m, FAKE_MILLIONSEND_INBOX_KEY);
  expect(limited.instant).toBe(false);
  await revokeMailAccount(deps, f.owner.id, f.org.id, limited.account.id);

  const r = await millionSendAccount(m);
  expect(r.instant).toBe(true);
  const [id, hook] = [...m.millionsend.state.webhooks][0] ?? [];
  expect(hook).toMatchObject({ endpoint: `${HTTPS}/api/webhooks/millionsend`, inboxId: inbox.id });
  expect(hook?.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  await giveMail(m, r.account.id, "read");
  await revokeMailAccount(deps, f.owner.id, f.org.id, r.account.id);
  expect(m.millionsend.state.deletedWebhooks).toEqual([id ?? "none"]);
  const grants = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, r.account.id));
  expect(grants).toEqual([]);
});

test("agents read it like any mailbox: the same grants, the content wrapped as untrusted", async () => {
  m = await mailSetup();
  const r = await millionSendAccount(m);
  const ctx = await runContext(m.f);
  const names = async () => (await m.tools.list(ctx)).map((t) => t.name).filter((n) => n.startsWith("mail_"));
  expect(await names()).toEqual([]);
  await giveMail(m, r.account.id, "read");
  expect(await names()).toEqual([
    "mail_suporte_attachment",
    "mail_suporte_folders",
    "mail_suporte_read",
    "mail_suporte_search",
  ]);
  m.box.add({ id: `${THREAD}:${EMAIL}`, from: { address: "maria@example.org" }, subject: "Pedido", text: "Oi" });
  const read = await m.tools.invoke(ctx, {
    toolUseId: "tu_1",
    name: "mail_suporte_read",
    input: { message_id: `${THREAD}:${EMAIL}` },
  });
  if (read.type !== "result") throw new Error("expected a result");
  expect(read.output.content.startsWith(UNTRUSTED_NOTE)).toBe(true);
  // The connector got the inbox and its key, opened for this call.
  expect(m.box.state.opened.at(-1)?.millionsend).toEqual({ apiKey: FAKE_MILLIONSEND_KEY, inboxId: inboxOf(m).id });
});

test("a reply asks first, its card names MillionSend, and goes out in the message's thread once approved", async () => {
  m = await mailSetup();
  const r = await millionSendAccount(m);
  await giveMail(m, r.account.id, "read_write");
  const id = `${THREAD}:${EMAIL}`;
  m.box.add({ id, from: { address: "maria@example.org" }, to: [{ address: r.account.address }], subject: "Pedido" });
  const ctx = await runContext(m.f);
  const asked = await m.tools.invoke(ctx, {
    toolUseId: "tu_reply",
    name: "mail_suporte_reply",
    input: { message_id: id, body: "Sai hoje.", why: "The customer asked where order 1042 is, and this answers them." },
  });
  if (asked.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(asked)}`);
  const [listed] = await listApprovals(m.f.db, m.f.owner.id, m.f.org.id);
  expect(listed?.email).toMatchObject({ verb: "reply", provider: "MillionSend", to: ["maria@example.org"] });
  await m.tools.executeApproved(ctx, { ...asked.approval, status: "approved" });
  expect(m.box.state.sent).toMatchObject([{ to: ["maria@example.org"], text: "Sai hoje.", inReplyTo: id }]);
});

test("a signed delivery wakes the routine at once; forged, other inboxes, spam and paused routines don't", async () => {
  m = await mailSetup({ publicUrl: HTTPS });
  const r = await millionSendAccount(m);
  await giveMail(m, r.account.id, "read");
  const routine = await emailRoutine(m, r.account.id);
  const [hook] = [...m.millionsend.state.webhooks.values()];
  const secret = hook?.secret ?? "";
  const inbox = inboxOf(m).id;

  const forged = delivery(inbox, "whsec_Zm9yZ2Vk");
  await expect(handleMillionSendWebhook(m.deps, forged.headers, forged.body)).rejects.toBeInstanceOf(
    ForbiddenSignatureError,
  );
  const elsewhere = delivery("00000000-0000-4000-8000-000000000999", secret);
  await expect(handleMillionSendWebhook(m.deps, elsewhere.headers, elsewhere.body)).rejects.toBeInstanceOf(
    ForbiddenSignatureError,
  );
  expect(await runsOf(m, routine.id)).toEqual([]);

  const good = delivery(inbox, secret);
  expect(await handleMillionSendWebhook(m.deps, good.headers, good.body)).toEqual({ type: "mail.received", fired: 1 });
  const runs = await runsOf(m, routine.id);
  expect(runs).toHaveLength(1);
  const event = runs[0]?.event as { messages: { id: string; from: string }[]; summary: string };
  expect(event.messages).toMatchObject([{ id: `${THREAD}:${EMAIL}`, from: "Maria Silva <maria@example.org>" }]);
  expect(event.summary).toContain("mail_suporte_read");
  expect(event.summary).toContain(`"Pedido 1042" · id ${THREAD}:${EMAIL}`);
  expect(event.summary).not.toMatch(/ · $/m);

  // MillionSend retries: the same message never runs twice (nor when a poll sees it later).
  const retried = delivery(inbox, secret);
  expect(await handleMillionSendWebhook(m.deps, retried.headers, retried.body)).toEqual({
    type: "mail.received",
    fired: 0,
  });
  const spam = delivery(inbox, secret, { folder: "spam", emailId: "2a6a1c0e-0b0b-4c4c-8d8d-9e9e9e9e9e9e" });
  expect(await handleMillionSendWebhook(m.deps, spam.headers, spam.body)).toEqual({ type: "mail.received", fired: 0 });

  await setRoutineActive(routineDeps(m), m.f.owner.id, m.f.org.id, routine.id, false);
  const held = await runsOf(m, routine.id);
  const paused = delivery(inbox, secret, { emailId: "3b7b2d1f-1c1c-4d5d-8e8e-0f0f0f0f0f0f" });
  expect(await handleMillionSendWebhook(m.deps, paused.headers, paused.body)).toEqual({
    type: "mail.received",
    fired: 0,
  });
  expect(await runsOf(m, routine.id)).toEqual(held);
});

test("without a webhook the watch is polled like IMAP, with the inbox's key", async () => {
  m = await mailSetup();
  const r = await millionSendAccount(m);
  await giveMail(m, r.account.id, "read");
  const routine = await emailRoutine(m, r.account.id);
  const poll = async () => {
    await m.f.db.update(schema.mailWatches).set({ lastCheckedAt: new Date(Date.now() - 3600_000) });
    return pollMailWatches(m.deps, { intervalMs: 60_000 });
  };
  expect(await poll()).toEqual({ checked: 1, fired: 0, failed: 0 });
  expect(m.poller.state.calls[0]?.account).toMatchObject({
    via: "millionsend",
    millionsend: { apiKey: FAKE_MILLIONSEND_KEY, inboxId: inboxOf(m).id },
  });
  const message: MailSummary = {
    id: `${THREAD}:${EMAIL}`,
    from: { address: "maria@example.org" },
    to: [],
    cc: [],
    subject: "Pedido",
    date: new Date().toISOString(),
    snippet: "",
    unread: true,
    hasAttachments: false,
  };
  m.poller.deliver("INBOX", message);
  expect(await poll()).toEqual({ checked: 1, fired: 1, failed: 0 });
  expect(await runsOf(m, routine.id)).toHaveLength(1);
});

test("a refused key asks to reconnect; a new key that reaches the inbox brings it back", async () => {
  m = await mailSetup({ publicUrl: HTTPS });
  const { f, deps } = m;
  const r = await millionSendAccount(m, FAKE_MILLIONSEND_INBOX_KEY);
  await markNeedsReconnect(f.db, r.account.id, "MillionSend refused the API key");
  expect(await updateMailAccount(deps, f.owner.id, f.org.id, r.account.id, { apiKey: "ms_wrong" })).toEqual({
    ok: false,
    error: "auth",
  });
  await expect(updateMailAccount(deps, f.owner.id, f.org.id, r.account.id, { password: "x" })).rejects.toBeInstanceOf(
    ValidationError,
  );
  const back = await updateMailAccount(deps, f.owner.id, f.org.id, r.account.id, { apiKey: FAKE_MILLIONSEND_KEY });
  expect(back.ok && back.account.status).toBe("active");
  // The new key may create the webhook the first one couldn't.
  expect(m.millionsend.state.webhooks.size).toBe(1);
});

test("the workspace's MillionSend connector key, when it has one, connects the inbox", async () => {
  m = await mailSetup();
  const { f, deps } = m;
  const inbox = inboxOf(m);
  const connect = async (authType: "api_key" | "oauth", secret: Record<string, string>) => {
    const id = crypto.randomUUID();
    const wrapper = deps.keyWrappers[0];
    if (!wrapper) throw new Error("no wrapper");
    const sealed = await sealSecret(wrapper, JSON.stringify(secret), `connector-connection|${f.org.id}|${id}`);
    await f.db.insert(schema.connectorConnections).values({
      id,
      orgId: f.org.id,
      connector: `custom:${id}`,
      toolPrefix: "millionsend",
      label: "MillionSend",
      serverUrl: "https://api.millionsend.com/mcp",
      authType,
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
    });
    return id;
  };
  // Signed in: a token for MillionSend's MCP, not a key for its API.
  const signedIn = await connect("oauth", { accessToken: "fake-token" });
  await expect(
    createMillionSendAccount(deps, f.owner.id, f.org.id, { useConnector: true, inboxId: inbox.id }),
  ).rejects.toBeInstanceOf(ValidationError);
  await f.db
    .update(schema.connectorConnections)
    .set({ revokedAt: new Date() })
    .where(eq(schema.connectorConnections.id, signedIn));
  await connect("api_key", { apiKey: FAKE_MILLIONSEND_KEY });
  const r = await createMillionSendAccount(deps, f.owner.id, f.org.id, { useConnector: true, inboxId: inbox.id });
  expect(r.ok && r.account.address).toBe(inbox.address);
});

test("an agent that can't read any mailbox is told where a person lets it, never left guessing", async () => {
  m = await mailSetup();
  await millionSendAccount(m);
  const ctx = await runContext(m.f);
  const tools = await createScheduleToolSource({ pubsub: m.f.pubsub, context: m.f.context, mail: m.mail }).tools(ctx);
  const create = tools.find((t) => t.name === "create_routine");
  const out = await create?.execute({ prompt: "Leia os emails.", trigger: { type: "email" } }, ctx);
  expect(out?.isError).toBe(true);
  expect(out?.content).toContain(MAILBOX_NOT_GIVEN_TEXT);
  expect(out?.content).toContain("Settings › Connectors › Who uses it");
  expect(out?.content).toContain("Configurações › Conectores › Quem usa");
  expect(out?.content).toContain("Você › Conectores");
});

test("with another mailbox in the workspace, the inbox an agent names is told apart: not connected, or not given", async () => {
  m = await mailSetup();
  const imap = await imapAccount(m);
  await giveMail(m, imap.id, "read");
  const ctx = await runContext(m.f);
  const tools = await createScheduleToolSource({ pubsub: m.f.pubsub, context: m.f.context, mail: m.mail }).tools(ctx);
  const create = tools.find((t) => t.name === "create_routine");
  const watch = (mailbox: string) =>
    create?.execute({ prompt: "Leia os emails.", trigger: { type: "email", mailbox } }, ctx);
  const inbox = inboxOf(m).address;

  // Made at MillionSend, never connected here: where a person connects it.
  const unknown = await watch(inbox);
  expect(unknown?.isError).toBe(true);
  expect(unknown?.content).toContain(`"${inbox}" isn't a mailbox connected here`);
  expect(unknown?.content).toContain("Settings › Connectors › Add connector › Email");
  expect(unknown?.content).toContain("Você › Conectores › MillionSend");

  // Connected, but not this agent's: where a person lets it.
  await millionSendAccount(m);
  const notGiven = await watch(inbox.toUpperCase());
  expect(notGiven?.isError).toBe(true);
  expect(notGiven?.content).toContain(`You can't read "${inbox.toUpperCase()}" yet`);
  expect(notGiven?.content).toContain("Settings › Connectors › Who uses it");
  expect(notGiven?.content).not.toContain("Add connector");
});

test("organizing says the whole conversation moves, as it does at MillionSend, on the tools and the card", async () => {
  m = await mailSetup();
  const r = await millionSendAccount(m);
  await giveMail(m, r.account.id, "read_write", {}, true);
  const ctx = await runContext(m.f);
  const tools = await m.tools.list(ctx);
  const text = (verb: string) => tools.find((t) => t.name === `mail_suporte_${verb}`)?.description ?? "";
  for (const verb of ["move", "mark", "archive", "trash"]) expect(text(verb)).toContain("whole conversation");
  const id = `${THREAD}:${EMAIL}`;
  m.box.add({ id, from: { address: "maria@example.org" }, subject: "Pedido" });
  const asked = await m.tools.invoke(ctx, {
    toolUseId: "tu_trash",
    name: "mail_suporte_trash",
    input: { message_id: id, why: "The customer asked us to delete this conversation." },
  });
  if (asked.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(asked)}`);
  expect(asked.approval.detail).toBe(`Moves the whole conversation to the trash of ${r.account.address}.`);
});

test("a delivery for an inbox disconnected while MillionSend was down deletes its webhook then, and runs nothing", async () => {
  m = await mailSetup({ publicUrl: HTTPS });
  const r = await millionSendAccount(m);
  await giveMail(m, r.account.id, "read");
  const routine = await emailRoutine(m, r.account.id);
  const [hookId, hook] = [...m.millionsend.state.webhooks][0] ?? [];
  if (!hookId || !hook) throw new Error("expected a webhook");
  const client = m.millionsend.client;
  const remove = client.deleteWebhook;
  client.deleteWebhook = async () => {
    throw new MailError("MillionSend can't answer now (503)", true);
  };
  await revokeMailAccount(m.deps, m.f.owner.id, m.f.org.id, r.account.id);
  client.deleteWebhook = remove;
  expect(m.millionsend.state.webhooks.has(hookId)).toBe(true);

  // Taken (refused, MillionSend would tell the team its webhook fails), and the webhook goes with the inbox's key.
  const late = delivery(inboxOf(m).id, hook.secret);
  expect(await handleMillionSendWebhook(m.deps, late.headers, late.body)).toEqual({ type: "mail.received", fired: 0 });
  expect(m.millionsend.state.deletedWebhooks).toEqual([hookId]);
  expect(await runsOf(m, routine.id)).toEqual([]);
  const forged = delivery(inboxOf(m).id, "whsec_Zm9yZ2Vk");
  await expect(handleMillionSendWebhook(m.deps, forged.headers, forged.body)).rejects.toBeInstanceOf(
    ForbiddenSignatureError,
  );
});
