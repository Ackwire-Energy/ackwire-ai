import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
/** agentes.chat's side in the relay tests: the server that is the inbox. */
let inbox: TestServer | undefined;
afterEach(async () => {
  const current = t;
  const other = inbox;
  t = undefined as unknown as TestServer;
  inbox = undefined;
  await current?.close();
  await other?.close();
});

const ID = "7b0c2c0e-5a51-4a3f-9d0e-0d6f6a4f1a01";

test("feedback: no address and the relay off, no form and no route", async () => {
  t = await createTestServer();
  const ana = browser(t);
  expect(await (await ana("/api/app/auth-config")).json()).toMatchObject({ feedback: false, feedbackRelay: false });
  await signUp(ana, "ana@example.com");
  expect((await ana("/api/app/feedback", { json: { id: ID, text: "The attach button is gone" } })).status).toBe(404);
});

test("feedback: one email to the server's address, through the outbox, answered to the person", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com" } });
  const ana = browser(t);
  expect(await (await ana("/api/app/auth-config")).json()).toMatchObject({ feedback: true, feedbackRelay: false });
  // Only agentes.chat's own servers take other servers' feedback.
  expect((await browser(t)("/api/feedback/inbox", { json: {}, origin: null })).status).toBe(404);
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const upload = (b: ReturnType<typeof browser>, bytes: Uint8Array, name: string, type = "image/png") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }), name);
  return b("/api/app/feedback/files", { method: "POST", body: form });
};

test("feedback: a picture is added, sent as a link good for a month, and opens only as a download", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com", ALLOW_SIGNUP: "true" } });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.drain();
  t.email.sent.length = 0;

  expect((await upload(browser(t), PNG, "a.png")).status).toBe(401);
  // What it calls itself doesn't matter: its bytes do.
  const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
  const refused = await upload(ana, html, "shot.png");
  expect(refused.status).toBe(400);
  expect(JSON.stringify(await refused.json())).toContain("feedback.file_type");

  const added = await upload(ana, PNG, "shot.png");
  expect(added.status).toBe(200);
  const file = (await added.json()) as { id: string; name: string; kind: string };
  expect(file).toMatchObject({ name: "shot.png", kind: "image" });
  const taken = (await (await upload(ana, PNG, "other.png")).json()) as { id: string };
  expect((await bia(`/api/app/feedback/files/${taken.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await ana(`/api/app/feedback/files/${taken.id}`, { method: "DELETE" })).status).toBe(204);

  // Someone else's file sends nothing, not even the text.
  const stolen = await bia("/api/app/feedback", { json: { id: ID, text: "Mine now", files: [file.id] } });
  expect(stolen.status).toBe(400);
  const sent = await ana("/api/app/feedback", {
    json: {
      id: ID,
      text: "This answer is wrong",
      about: { kind: "agent message", label: "Ada", text: "Deploy done." },
      facts: [["Route", "/org/$orgId/home"]],
      files: [file.id],
    },
  });
  expect(sent.status).toBe(204);
  await t.drain();
  expect(t.email.sent).toHaveLength(1);
  const mail = t.email.sent[0];
  expect(mail?.text).toContain("About agent message: Ada\n\n> Deploy done.");
  expect(mail?.text).toContain("Route: /org/$orgId/home");
  expect(mail?.inline).toMatchObject([{ filename: "shot.png", contentType: "image/png" }]);
  const link = /https?:\/\/\S+\/api\/feedback-files\/[\w-]+/.exec(mail?.text ?? "")?.[0] ?? "";
  expect(link).not.toBe("");

  // The link needs no session, and this origin never shows the file: a download, with nothing sniffed or run.
  const opened = await browser(t)(new URL(link).pathname);
  expect(opened.status).toBe(200);
  expect(opened.headers.get("content-type")).toBe("image/png");
  expect(opened.headers.get("content-disposition")).toStartWith('attachment; filename="shot.png"');
  expect(opened.headers.get("x-content-type-options")).toBe("nosniff");
  expect(opened.headers.get("content-security-policy")).toContain("sandbox");
  expect(new Uint8Array(await opened.arrayBuffer())).toEqual(PNG);
  expect((await browser(t)("/api/feedback-files/not-a-real-token-at-all-0000")).status).toBe(404);
  expect((await ana(`/api/app/feedback/files/${file.id}`, { method: "DELETE" })).status).toBe(404);
});

test("feedback: a screenshot named by macOS (a narrow no-break space before PM) still opens, its name kept", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com" } });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  await t.drain();
  t.email.sent.length = 0;
  const name = "Screenshot 2026-11-10 at 11.43.12 PM.png";
  const file = (await (await upload(ana, PNG, name)).json()) as { id: string; name: string };
  expect(file.name).toBe(name);
  expect((await ana("/api/app/feedback", { json: { id: ID, text: "Look", files: [file.id] } })).status).toBe(204);
  await t.drain();
  const link = /https?:\/\/\S+\/api\/feedback-files\/[\w-]+/.exec(t.email.sent[0]?.text ?? "")?.[0] ?? "";
  const opened = await browser(t)(new URL(link).pathname);
  expect(opened.status).toBe(200);
  expect(opened.headers.get("content-disposition")).toBe(
    `attachment; filename="Screenshot 2026-11-10 at 11.43.12_PM.png"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  expect(new Uint8Array(await opened.arrayBuffer())).toEqual(PNG);
});

test("feedback files: the hour's limit and the size are answered before the file is read", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com" } });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  // A body that says it is past the largest file is refused by that alone.
  const claimed = await ana("/api/app/feedback/files", {
    method: "POST",
    body: new FormData(),
    headers: { "content-length": String(60 * 1024 * 1024) },
  });
  expect(claimed.status).toBe(413);
  // Thirty an hour, tried or kept: the thirty-first is refused whatever it holds.
  const junk = new TextEncoder().encode("not a picture at all");
  for (let n = 0; n < 30; n++) expect((await upload(ana, junk, `${n}.png`)).status).toBe(400);
  expect((await upload(ana, PNG, "real.png")).status).toBe(429);
});

const INBOX_URL = "https://app.agentes.chat/api/feedback/inbox";
/** A server with no address of its own, whose network reaches only the inbox: `inbox`'s own app. */
async function relaying(down = false) {
  inbox = await createTestServer({
    env: { FEEDBACK_EMAIL: "team@example.com", PUBLIC_URL: "https://app.agentes.chat" },
  });
  const posted: string[] = [];
  const there = inbox;
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== INBOX_URL) return new Response(null, { status: 404 });
    posted.push(String(url));
    if (down) return new Response("busy", { status: 503 });
    return there.app.request(new URL(String(url)).pathname, init);
  }) as typeof fetch;
  t = await createTestServer({ env: { FEEDBACK_RELAY: "true" }, http });
  return posted;
}

test("feedback relay: with no address it goes to the agentes.chat team's inbox, pictures in the email", async () => {
  const posted = await relaying();
  const ana = browser(t);
  expect(await (await ana("/api/app/auth-config")).json()).toMatchObject({ feedback: true, feedbackRelay: true });
  await signUp(ana, "ana@example.com");
  const { orgId } = await seedOrg(ana);
  await t.drain();
  t.email.sent.length = 0;

  // No video goes that far, so none is taken.
  const video = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const refused = await upload(ana, video, "clip.webm", "video/webm");
  expect(refused.status).toBe(400);
  expect(JSON.stringify(await refused.json())).toContain("feedback.file_type");
  const file = (await (await upload(ana, PNG, "shot.png")).json()) as { id: string };

  const json = { id: ID, text: "The attach button is gone", orgId, where: "/org/x/home", app: "web", files: [file.id] };
  expect((await ana("/api/app/feedback", { json })).status).toBe(204);
  expect(posted).toEqual([]); // never inline in the request
  await t.drain();
  expect(posted).toEqual([INBOX_URL]);
  // This server mails nothing: the team's does, to its own address, answered to the person.
  expect(t.email.sent).toEqual([]);
  expect(inbox?.email.sent).toHaveLength(1);
  const mail = inbox?.email.sent[0];
  expect(mail).toMatchObject({ to: ["team@example.com"], replyTo: "ana@example.com" });
  expect(mail?.text).toContain("The attach button is gone");
  expect(mail?.text).toContain("Workspace: Acme");
  expect(mail?.text).toContain("Sent from: another server (not verified)");
  expect(mail?.text).toContain("(self-hosted)");
  expect(mail?.text).not.toContain("/api/feedback-files/");
  expect(mail?.inline).toMatchObject([{ filename: "shot.png", contentType: "image/png", content: PNG }]);
});

test("feedback relay: the inbox takes only a feedback, pictures by their bytes, thirty an hour", async () => {
  await relaying();
  const post = (body: unknown) =>
    (inbox as TestServer).app.request("/api/feedback/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const feedback = { name: "Ana", email: "ana@example.com", text: "Hello", version: "1.0.0" };
  expect((await post({ id: "a", feedback: { ...feedback, text: " " } })).status).toBe(400);
  expect((await post({ id: "a", feedback: { ...feedback, email: "nobody" } })).status).toBe(400);
  const html = Buffer.from("<!doctype html><script>alert(1)</script>").toString("base64");
  expect((await post({ id: "a", feedback, pictures: [{ name: "shot.png", data: html }] })).status).toBe(400);
  expect(inbox?.email.sent).toEqual([]);
  // An address it was sent with is never used: the team's own is.
  expect((await post({ id: "a", feedback: { ...feedback, to: "someone@example.com" } })).status).toBe(204);
  expect(inbox?.email.sent[0]?.to).toEqual(["team@example.com"]);
  // Sent again (its answer was lost), the same message is one email at the provider; another is another.
  expect((await post({ id: "a", feedback })).status).toBe(204);
  expect((await post({ id: "b", feedback })).status).toBe(204);
  const keys = inbox?.email.sent.map((m) => m.idempotencyKey) ?? [];
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  // Thirty an hour from one address, whatever they held.
  for (let n = 6; n < 30; n++) await post({ id: `n${n}`, feedback });
  expect((await post({ id: "last", feedback })).status).toBe(429);
});

test("feedback relay: the inbox can be turned off", async () => {
  t = await createTestServer({
    env: { FEEDBACK_EMAIL: "team@example.com", PUBLIC_URL: "https://app.agentes.chat", FEEDBACK_INBOX: "false" },
  });
  const feedback = { name: "Ana", email: "ana@example.com", text: "Hello", version: "1.0.0" };
  const res = await t.app.request("/api/feedback/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "a", feedback }),
  });
  expect(res.status).toBe(404);
  expect(t.email.sent).toEqual([]);
});

test("feedback relay: an inbox that is down is tried again, and nothing is mailed meanwhile", async () => {
  const posted = await relaying(true);
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  await t.drain();
  t.email.sent.length = 0;
  expect((await ana("/api/app/feedback", { json: { id: ID, text: "Anyone there?" } })).status).toBe(204);
  await t.drain();
  expect(posted).toEqual([INBOX_URL]);
  expect(t.email.sent).toEqual([]);
  expect(inbox?.email.sent).toEqual([]);
});
