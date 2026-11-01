import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, signUp, type TestServer } from "./harness";

/** Voice messages over HTTP (ADR 0098): sending, playing, expiry, the switch and the owner's provider. */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A fake Groq: the words of any recording. */
const groq = (async () => Response.json({ text: "Ada, oi" })) as unknown as typeof fetch;

async function start(env: Record<string, string> = { GROQ_API_KEY: "groq-key-1234" }) {
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true", ...env },
    speechFetch: groq,
    signedBlobs: false,
  });
  t = server;
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const other = browser(server);
  await signUp(other, "other@example.com");
  const created = (await (await owner("/api/app/organizations", { json: { name: "Acme" } })).json()) as {
    organization: { id: string };
    generalChannelId: string;
  };
  return { server, owner, other, orgId: created.organization.id, channelId: created.generalChannelId };
}

function send(b: Browser, orgId: string, channelId: string, over: Record<string, string> = {}, name = "voice.m4a") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(32)], name));
  form.set("durationMs", "2000");
  form.set("peaks", "[0.2,0.4]");
  form.set("clientId", crypto.randomUUID());
  for (const [key, value] of Object.entries(over)) form.set(key, value);
  return b(`/api/app/organizations/${orgId}/channels/${channelId}/voice`, { method: "POST", body: form });
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("a recording is stored and played back, with ranges", async () => {
  const { owner, orgId, channelId } = await start();
  const res = await send(owner, orgId, channelId);
  expect(res.status).toBe(202);
  const { clipId } = (await res.json()) as { clipId: string };
  const audio = await owner(`/api/app/organizations/${orgId}/voice/${clipId}/audio`);
  expect(audio.status).toBe(200);
  expect(audio.headers.get("content-type")).toBe("audio/x-m4a");
  expect(audio.headers.get("x-content-type-options")).toBe("nosniff");
  const part = await owner(`/api/app/organizations/${orgId}/voice/${clipId}/audio`, {
    headers: { range: "bytes=0-9" },
  });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 0-9/32");
});

test("a browser's .webm recording arrives as video and is kept as audio", async () => {
  const { owner, orgId, channelId } = await start();
  const res = await send(owner, orgId, channelId, {}, "voice.webm");
  expect(res.status).toBe(202);
  const { clipId } = (await res.json()) as { clipId: string };
  const audio = await owner(`/api/app/organizations/${orgId}/voice/${clipId}/audio`);
  expect(audio.headers.get("content-type")).toBe("audio/webm");
});

test("what isn't audio is refused, and an outsider can't play one", async () => {
  const { owner, other, orgId, channelId } = await start();
  const refused = await send(owner, orgId, channelId, {}, "page.html");
  expect(refused.status).toBe(400);
  expect(await errorCode(refused)).toBe("voice.bad_type");
  const { clipId } = (await (await send(owner, orgId, channelId)).json()) as { clipId: string };
  const res = await other(`/api/app/organizations/${orgId}/voice/${clipId}/audio`);
  expect([403, 404]).toContain(res.status);
});

test("a swept recording answers 410", async () => {
  const { server, owner, orgId, channelId } = await start();
  const { clipId } = (await (await send(owner, orgId, channelId)).json()) as { clipId: string };
  await server.db
    .update(schema.voiceClips)
    .set({ audioDeletedAt: new Date(), status: "sent" })
    .where(eq(schema.voiceClips.id, clipId));
  const res = await owner(`/api/app/organizations/${orgId}/voice/${clipId}/audio`);
  expect(res.status).toBe(410);
  expect(await errorCode(res)).toBe("voice.expired");
});

test("the workspace's switch and the server's engine decide the microphone", async () => {
  const { owner, orgId, channelId } = await start();
  const settings = async () =>
    (await (await owner(`/api/app/organizations/${orgId}/settings`)).json()) as {
      voiceMessages: boolean;
      voiceAvailable: boolean;
    };
  expect(await settings()).toMatchObject({ voiceMessages: true, voiceAvailable: true });
  await owner(`/api/app/organizations/${orgId}/settings`, { method: "PATCH", json: { voiceMessages: false } });
  expect((await settings()).voiceMessages).toBe(false);
  const refused = await send(owner, orgId, channelId);
  expect(refused.status).toBe(409);
  expect(await errorCode(refused)).toBe("voice.unavailable");
  const allowed = await owner(`/api/app/organizations/${orgId}/voice/allowed`);
  expect(await allowed.json()).toEqual({ allowed: false });
});

test("with no engine there is no voice", async () => {
  const { owner, orgId } = await start({});
  const settings = await (await owner(`/api/app/organizations/${orgId}/settings`)).json();
  expect(settings).toMatchObject({ voiceAvailable: false });
});

test("the provider is only for the installation's owner", async () => {
  const { owner, other } = await start();
  expect((await owner("/api/app/speech-key")).status).toBe(200);
  expect((await other("/api/app/speech-key")).status).toBe(404);
  const saved = await owner("/api/app/speech-key", {
    method: "PUT",
    json: { provider: "groq", apiKey: "good-key-5678" },
  });
  expect(saved.status).toBe(200);
  const view = await saved.json();
  expect(view).toMatchObject({ provider: "groq", hint: "5678", state: "ok" });
  expect(JSON.stringify(view)).not.toContain("good-key");
});

test("on agentes.chat the provider can't be chosen", async () => {
  const origin = "https://app.agentes.chat";
  const server = await createTestServer({ env: { ALLOW_SIGNUP: "true", PUBLIC_URL: origin }, speechFetch: groq });
  t = server;
  const owner = browser(server);
  await owner("/api/auth/sign-up/email", {
    json: { email: "owner@example.com", password: "correct horse battery", name: "Owner" },
    origin,
  });
  expect((await owner("/api/app/speech-key", { origin })).status).toBe(404);
});
