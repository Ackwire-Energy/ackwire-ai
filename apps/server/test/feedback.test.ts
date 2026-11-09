import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const ID = "7b0c2c0e-5a51-4a3f-9d0e-0d6f6a4f1a01";

test("feedback: no address, no form and no route", async () => {
  t = await createTestServer();
  const ana = browser(t);
  expect(await (await ana("/api/app/auth-config")).json()).toMatchObject({ feedback: false });
  await signUp(ana, "ana@example.com");
  expect((await ana("/api/app/feedback", { json: { id: ID, text: "The attach button is gone" } })).status).toBe(404);
});

test("feedback: one email to the server's address, through the outbox, answered to the person", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com" } });
  const ana = browser(t);
  expect(await (await ana("/api/app/auth-config")).json()).toMatchObject({ feedback: true });
  expect((await browser(t)("/api/app/feedback", { json: { id: ID, text: "hi" } })).status).toBe(401);
  await signUp(ana, "ana@example.com");
  const { orgId } = await seedOrg(ana);
  await t.drain();
  t.email.sent.length = 0;

  const send = (json: Record<string, unknown>) => ana("/api/app/feedback", { json });
  expect((await send({ id: ID, text: "   " })).status).toBe(400);
  const sent = await send({
    id: ID,
    text: "The attach button is gone\n<b>on a narrow window</b>",
    orgId,
    where: "/org/x/dm/agent/y",
    app: "web",
  });
  expect(sent.status).toBe(204);
  // The same message sent again (a retry of the request) goes once.
  expect((await send({ id: ID, text: "The attach button is gone" })).status).toBe(204);
  expect(t.email.sent).toEqual([]); // never inline in the request
  await t.drain();
  expect(t.email.sent).toHaveLength(1);
  const mail = t.email.sent[0];
  expect(mail).toMatchObject({ to: ["feedback@example.com"], replyTo: "ana@example.com" });
  expect(mail?.subject).toStartWith("Feedback from ");
  expect(mail?.text).toContain("The attach button is gone\n<b>on a narrow window</b>");
  expect(mail?.text).toContain("<ana@example.com>");
  expect(mail?.text).toContain("Workspace: Acme");
  expect(mail?.text).toContain("Screen: /org/x/dm/agent/y");
  // What the person typed is text in the HTML part, never markup.
  expect(mail?.html).toContain("&lt;b&gt;on a narrow window&lt;/b&gt;");
  expect(mail?.html).not.toContain("<b>on a narrow window</b>");
});

test("feedback: a workspace that isn't theirs is not named, and an hour takes ten", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com", ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.drain();
  t.email.sent.length = 0;

  const id = (n: number) => `7b0c2c0e-5a51-4a3f-9d0e-0d6f6a4f1a${String(n).padStart(2, "0")}`;
  expect((await bia("/api/app/feedback", { json: { id: id(0), text: "From outside", orgId } })).status).toBe(204);
  await t.drain();
  expect(t.email.sent[0]?.text).not.toContain("Workspace:");
  for (let n = 1; n < 10; n++)
    expect((await bia("/api/app/feedback", { json: { id: id(n), text: `Again ${n}` } })).status).toBe(204);
  expect((await bia("/api/app/feedback", { json: { id: id(10), text: "One too many" } })).status).toBe(429);
});
