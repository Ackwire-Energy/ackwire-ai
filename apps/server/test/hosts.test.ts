import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HumanAction, HumanCheck } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { enableCaches, listHosts, putHost } from "@agenteschat/engine";
import { createApp } from "../src/app";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { personUpgrade } from "../src/realtime/ws";
import { allowedOrigins, requestOriginAllowed } from "../src/routes/app/context";
import {
  type Browser,
  browser,
  createTestServer,
  fakeCloudflare,
  GOOGLE_ENV,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
  tokenMadeOn,
  turnstileCheck,
} from "./harness";

/** ADR 0194: the same server on extra hostnames, each with its own look before sign-in. */

const HOST = "app.northwind.example";
const HOST_ORIGIN = `https://${HOST}`;
const OTHER = "app.contoso.example";
const OWN_EXTRA = "https://chat.northwind.example";
const TOKEN = "operator-test-token-".padEnd(48, "x");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let t: TestServer | undefined;
afterEach(async () => {
  enableCaches(false);
  await t?.close();
  t = undefined;
});

async function server(env: Record<string, string> = {}, humanCheck?: HumanCheck | null) {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true", OPERATOR_API_TOKEN: TOKEN, ...env }, humanCheck });
  const s = t;
  const blobs = s.adapters.platformBlobs;
  const own = new Set<string>();
  await putHost({ db: s.db, blobs }, own, HOST, {
    name: "Northwind Studio",
    accent: "#7c3aed",
    logo: { contentType: "image/png", base64: PNG.toString("base64") },
  });
  await putHost({ db: s.db, blobs }, own, OTHER, { name: "Contoso" });
  return s;
}

/** A browser on `host`: every request carries that `Host` and that host's own origin unless told otherwise. */
function on(b: Browser, host: string, origin = `https://${host}`): Browser {
  const request = (path: string, init: Parameters<Browser>[1] = {}) =>
    b(path, { ...init, origin: init.origin === undefined ? origin : init.origin, headers: { host, ...init.headers } });
  return Object.assign(request, { cookie: b.cookie });
}

const codeOf = async (res: Response) =>
  ((await res.json()) as { error?: { code?: string }; code?: string }).error?.code;

const allowed = (s: TestServer, headers: Record<string, string>) =>
  requestOriginAllowed(s.db, allowedOrigins(s.config), new Headers(headers));

test("the origin rule: a registered host's own origin, on a request for that host only", async () => {
  const s = await server();
  expect(await allowed(s, { origin: ORIGIN })).toBe(true);
  expect(await allowed(s, { origin: ORIGIN, host: HOST })).toBe(true);
  expect(await allowed(s, { origin: HOST_ORIGIN, host: HOST })).toBe(true);
  expect(await allowed(s, { origin: HOST_ORIGIN, host: "App.Northwind.Example" })).toBe(true);
  expect(await allowed(s, { origin: HOST_ORIGIN, host: `${HOST}.` })).toBe(true);
  const refusals: Record<string, string>[] = [
    { origin: HOST_ORIGIN },
    { origin: HOST_ORIGIN, host: "localhost:3000" },
    { origin: HOST_ORIGIN, host: OTHER },
    { origin: `https://${OTHER}`, host: HOST },
    { origin: "https://app.unregistered.example", host: "app.unregistered.example" },
    { origin: `http://${HOST}`, host: HOST },
    { origin: `${HOST_ORIGIN}:443`, host: HOST },
    { origin: `${HOST_ORIGIN}:8443`, host: `${HOST}:8443` },
    { origin: HOST_ORIGIN, host: `${HOST}:443` },
    { origin: `${HOST_ORIGIN}.`, host: `${HOST}.` },
    { origin: "https://App.Northwind.Example", host: HOST },
    { origin: HOST_ORIGIN, host: "localhost:3000", "x-forwarded-host": HOST },
    { origin: HOST_ORIGIN, host: "localhost:3000", forwarded: `host=${HOST}` },
  ];
  for (const refused of refusals) {
    expect({ refused, allowed: await allowed(s, refused) }).toEqual({ refused, allowed: false });
  }
  // Without an Origin, the phone app alone, as before.
  expect(await allowed(s, { host: HOST, "x-agentes-client": "mobile" })).toBe(true);
  expect(await allowed(s, { host: HOST })).toBe(false);
});

test("Better Auth trusts a registered host's origin on that host's requests only; with no request, today's list", async () => {
  const s = await server();
  const trusted = s.auth.options.trustedOrigins as (request?: Request) => Promise<string[]>;
  const base = await trusted();
  expect(base).toContain(ORIGIN);
  expect(base).not.toContain(HOST_ORIGIN);
  const at = (headers: Record<string, string>) =>
    trusted(new Request("http://localhost/api/auth/sign-in/email", { headers }));
  expect(await at({ host: HOST })).toEqual([...base, HOST_ORIGIN]);
  expect(await at({ host: "localhost:3000" })).toEqual(base);
  expect(await at({ host: OTHER })).toEqual([...base, `https://${OTHER}`]);
  expect(await at({ host: "localhost:3000", "x-forwarded-host": HOST })).toEqual(base);
  expect(await at({ host: "app.unregistered.example" })).toEqual(base);
});

test("by email on a registered host: sign-up, the app's writes, sign-out and sign-in; host-only cookies", async () => {
  const s = await server();
  const there = on(browser(s), HOST);
  const up = await signUp(there, "ana@example.com");
  const cookies = up.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) expect(cookie.toLowerCase()).not.toContain("domain=");

  // The app API's CSRF check: that host's origin writes there, nowhere else.
  expect((await there("/api/app/organizations", { json: { name: "Northwind" } })).status).toBe(201);
  const elsewhere = [
    on(there, "localhost:3000", HOST_ORIGIN),
    on(there, OTHER, HOST_ORIGIN),
    on(there, HOST, `http://${HOST}`),
    on(there, HOST, `https://${OTHER}`),
  ];
  for (const b of elsewhere) {
    const res = await b("/api/app/organizations", { json: { name: "X" } });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("bad_origin");
  }

  // The main address holds no session of its own: the browser keeps each host's cookie to that host.
  expect((await browser(s)("/api/app/me")).status).toBe(401);

  const out = await there("/api/auth/sign-out", { json: {} });
  expect(out.status).toBe(200);
  expect((await there("/api/app/me")).status).toBe(401);
  const signIn = await there("/api/auth/sign-in/email", {
    json: { email: "ana@example.com", password: "correct horse battery" },
  });
  expect(signIn.status).toBe(200);
  for (const cookie of signIn.headers.getSetCookie()) expect(cookie.toLowerCase()).not.toContain("domain=");
  expect((await there("/api/app/me")).status).toBe(200);
});

test("the bot check takes a token made on the request's own registered host, on that host only", async () => {
  const s = await server({}, turnstileCheck(fakeCloudflare().fetch));
  const made = (host: string, action: HumanAction) => ({ "x-captcha-response": tokenMadeOn(host, action) });
  const there = on(browser(s), HOST);
  const account = { email: "ana@example.com", password: "correct horse battery" };
  const up = await there("/api/auth/sign-up/email", {
    json: { ...account, name: "Ana" },
    headers: made(HOST, "sign-up"),
  });
  expect(up.status).toBe(200);
  const lookup = await there("/api/app/sign-in-options", {
    json: { email: account.email },
    headers: made(HOST, "email-lookup"),
  });
  expect(lookup.status).toBe(200);
  const reset = await there("/api/auth/request-password-reset", {
    json: { email: account.email, redirectTo: "/reset-password" },
    headers: made(HOST, "password-reset"),
  });
  expect(reset.status).toBe(200);
  const signIn = (b: Browser) => b("/api/auth/sign-in/email", { json: account, headers: made(HOST, "sign-in") });
  expect((await signIn(on(browser(s), HOST))).status).toBe(200);
  // The same token on a request for another registered host or for the main address: refused.
  for (const b of [on(browser(s), OTHER, HOST_ORIGIN), on(browser(s), OTHER), browser(s)]) {
    const res = await signIn(b);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("human_check");
  }
  // The main address's own tokens still count on a registered host.
  const main = await on(browser(s), HOST)("/api/auth/sign-in/email", {
    json: account,
    headers: made("localhost", "sign-in"),
  });
  expect(main.status).toBe(200);
});

test("the WebSocket upgrade takes the same rule", async () => {
  const s = await server();
  const there = on(browser(s), HOST);
  await signUp(there, "ana@example.com");
  const { orgId } = await seedOrg(there);
  const upgrade = (headers: Record<string, string>) =>
    personUpgrade(
      { auth: s.auth, db: s.db },
      allowedOrigins(s.config),
      new Request(`http://localhost/api/ws?orgId=${orgId}`, { headers: { cookie: there.cookie(), ...headers } }),
      orgId,
    );
  const opened = await upgrade({ host: HOST, origin: HOST_ORIGIN });
  expect(opened).not.toBeInstanceOf(Response);
  const refusals: Record<string, string>[] = [
    { host: "localhost:3000", origin: HOST_ORIGIN },
    { host: OTHER, origin: HOST_ORIGIN },
    { host: HOST, origin: `http://${HOST}` },
    { host: "localhost:3000", origin: HOST_ORIGIN, "x-forwarded-host": HOST },
  ];
  for (const headers of refusals) {
    const refused = await upgrade(headers);
    expect({ headers, status: refused instanceof Response ? refused.status : 200 }).toEqual({ headers, status: 403 });
  }
});

test("auth-config: unchanged on the main address; on a registered host its look and email alone", async () => {
  const s = await server(GOOGLE_ENV);
  const main = (await (await browser(s)("/api/app/auth-config")).json()) as Record<string, unknown>;
  expect(main.host).toBeNull();
  expect(main.socialProviders).toEqual({ google: true, github: false, apple: false });

  const there = (await (await on(browser(s), HOST)("/api/app/auth-config")).json()) as Record<string, unknown>;
  expect(there.socialProviders).toEqual({ google: false, github: false, apple: false });
  expect(there.host).toEqual({
    name: "Northwind Studio",
    accent: "#7c3aed",
    logoUrl: expect.stringMatching(/^\/api\/host-look\/logo\?v=[0-9a-f]{8}-[0-9a-f]{16}\.png$/),
  });
  const { host: _main, socialProviders: _a, ...mainRest } = main;
  const { host: _there, socialProviders: _b, ...thereRest } = there;
  expect(thereRest).toEqual(mainRest);
  expect(((await (await on(browser(s), OTHER)("/api/app/auth-config")).json()) as { host: unknown }).host).toEqual({
    name: "Contoso",
    accent: null,
    logoUrl: null,
  });

  // A provider's sign-in can't start on a registered host, and still starts on the main address.
  const social = (b: Browser) => b("/api/auth/sign-in/social", { json: { provider: "google", callbackURL: "/" } });
  const refused = await social(on(browser(s), HOST));
  expect(refused.status).toBe(404);
  expect(((await refused.json()) as { code: string }).code).toBe("PROVIDER_NOT_FOUND");
  expect((await social(browser(s))).status).toBe(200);
});

test("a reset link goes to the main address wherever it was asked; a confirmation back to a host only for its sign-up", async () => {
  const s = await server();
  const owner = browser(s);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  await s.drain();

  const resetLink = async (b: Browser) => {
    const asked = await b("/api/auth/request-password-reset", {
      json: { email: "owner@example.com", redirectTo: "/reset-password" },
    });
    expect(asked.status).toBe(200);
    await s.drain();
    return new URL(/https?:\/\/\S+\/reset-password\S*/.exec(s.email.sent.at(-1)?.text ?? "")?.[0] ?? "").origin;
  };
  // Anyone may ask for any account's reset: a registered host, whose traffic its owner reads, never gets its token.
  expect(await resetLink(on(browser(s), HOST))).toBe(ORIGIN);
  expect(await resetLink(browser(s))).toBe(ORIGIN);

  const confirmation = async (email: string) => {
    await s.drain();
    const text = s.email.sent.filter((m) => m.to[0] === email).at(-1)?.text ?? "";
    return new URL(/https?:\/\/\S+\/api\/auth\/verify-email\S*/.exec(text)?.[0] ?? "").origin;
  };
  await signUp(on(browser(s), HOST), "dani@example.com");
  expect(await confirmation("dani@example.com")).toBe(HOST_ORIGIN);
  // A link is stamped to the second: asked for within the sign-up's, it would be the same email.
  await Bun.sleep(1000 - (Date.now() % 1000));
  const again = await on(browser(s), HOST)("/api/auth/send-verification-email", {
    json: { email: "dani@example.com" },
  });
  expect(again.status).toBe(200);
  expect(await confirmation("dani@example.com")).toBe(ORIGIN);

  const invite = async (b: Browser, email: string) => {
    const res = await b(`/api/app/organizations/${orgId}/invitations`, { json: { email, roleIds: [] } });
    expect(res.status).toBe(201);
    await s.drain();
    const mailed = s.email.sent.find((m) => m.to[0] === email)?.text ?? "";
    return { url: new URL(((await res.json()) as { url: string }).url).origin, mailed };
  };
  const there = await invite(on(owner, HOST), "bia@example.com");
  expect(there.url).toBe(HOST_ORIGIN);
  expect(there.mailed).toContain(`${HOST_ORIGIN}/invite/`);
  expect(there.mailed).not.toContain(`${ORIGIN}/invite/`);
  const main = await invite(owner, "caio@example.com");
  expect(main.url).toBe(ORIGIN);
  expect(main.mailed).toContain(`${ORIGIN}/invite/`);
});

test("the logo route serves the request's own host's logo, never another's", async () => {
  const s = await server();
  const logo = (b: Browser, query = "") => b(`/api/host-look/logo${query}`);
  const mine = await logo(on(browser(s), HOST));
  expect(mine.status).toBe(200);
  expect(mine.headers.get("content-type")).toBe("image/png");
  expect(mine.headers.get("cache-control")).toBe("public, max-age=300");
  expect(new Uint8Array(await mine.arrayBuffer()).subarray(0, 8)).toEqual(new Uint8Array(PNG.subarray(0, 8)));
  // A host without a logo, the main address and an unregistered host: none, whatever the query names.
  expect((await logo(on(browser(s), OTHER), `?host=${HOST}`)).status).toBe(404);
  expect((await logo(browser(s), `?host=${HOST}`)).status).toBe(404);
  expect((await logo(on(browser(s), "app.unregistered.example"))).status).toBe(404);
});

const operatorApp = (s: TestServer, read?: string) =>
  createOperatorApp(
    {
      db: s.db,
      config: s.config,
      version: "test",
      log: createLogger("error"),
      blobs: s.adapters.platformBlobs,
    },
    TOKEN,
    read,
  );

test("a server whose PUBLIC_URL isn't https registers no host: its cookies there would carry no Secure flag", async () => {
  const s = await server();
  const res = await operatorApp(s).request(`/api/operator/v1/hosts/b.northwind.example`, {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "B" }),
  });
  expect([res.status, await codeOf(res)]).toEqual([409, "host.needs_https"]);
  expect((await listHosts(s.db)).map((h) => h.host)).toEqual([OTHER, HOST]);
});

test("the operator's routes: auth, shapes, refusals, and the cache dropped on a write", async () => {
  const s = await server({ EXTRA_TRUSTED_ORIGINS: OWN_EXTRA, PUBLIC_URL: "https://chat.example.com" });
  enableCaches(true);
  const READ = "operator-read-token-".padEnd(48, "x");
  const app = operatorApp(s, READ);
  const call = (method: string, path: string, json?: unknown, token: string | null = TOKEN) =>
    app.request(`/api/operator/v1${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  const refusal = async (res: Response) => [res.status, await codeOf(res)];

  expect(await refusal(await call("GET", "/hosts", undefined, null))).toEqual([401, "unauthorized"]);
  expect(await refusal(await call("PUT", "/hosts/a.northwind.example", { name: "A" }, READ))).toEqual([
    403,
    "forbidden",
  ]);
  const listed = (await (await call("GET", "/hosts", undefined, READ)).json()) as { hosts: Record<string, unknown>[] };
  expect(listed.hosts.map((h) => h.host)).toEqual([OTHER, HOST]);
  expect(listed.hosts[1]).toEqual({
    host: HOST,
    name: "Northwind Studio",
    accent: "#7c3aed",
    logo: true,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });

  // Read once through the cache, then replaced here: the next read sees it at once.
  const look = async () =>
    ((await (await on(browser(s), HOST)("/api/app/auth-config")).json()) as { host: { name: string } }).host;
  expect((await look()).name).toBe("Northwind Studio");
  const put = await call("PUT", `/hosts/${HOST}`, { name: "Northwind", accent: "#0F766E" });
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ host: HOST, name: "Northwind", accent: "#0f766e", logo: true });
  expect(await look()).toMatchObject({ name: "Northwind", accent: "#0f766e" });
  expect(await (await call("PUT", `/hosts/${HOST}`, { name: "Northwind", logo: null })).json()).toMatchObject({
    logo: false,
    accent: "#0f766e",
  });

  for (const [host, code] of [
    ["localhost", "host.invalid"],
    ["app.northwind.example:443", "host.invalid"],
    ["203.0.113.7", "host.invalid"],
    ["chat.northwind.example", "host.own"],
    ["Chat.Northwind.Example.", "host.own"],
  ] as const) {
    expect({ host, r: await refusal(await call("PUT", `/hosts/${encodeURIComponent(host)}`, { name: "N" })) }).toEqual({
      host,
      r: [400, code],
    });
  }
  for (const bad of [{ name: "" }, { name: "x".repeat(61) }, { name: "N", accent: "purple" }]) {
    expect({ bad, status: (await call("PUT", "/hosts/b.northwind.example", bad)).status }).toEqual({
      bad,
      status: 400,
    });
  }
  await s.db
    .insert(schema.hosts)
    .values(Array.from({ length: 998 }, (_, i) => ({ host: `h${i}.northwind.example`, name: `H${i}` })));
  expect(await refusal(await call("PUT", "/hosts/one-more.northwind.example", { name: "N" }))).toEqual([
    409,
    "host.too_many",
  ]);

  expect((await call("DELETE", `/hosts/${HOST}`)).status).toBe(204);
  expect(await look()).toBeNull();
  expect(await refusal(await call("DELETE", `/hosts/${HOST}`))).toEqual([404, "not_found"]);
});

test("the app's page says it is on a registered host, so its boot hides the product's mark", async () => {
  const s = await server();
  const index = readFileSync(join(import.meta.dir, "../../web/index.html"), "utf8");
  expect(index).toContain("[data-host] .boot img { display: none; }");
  const web = mkdtempSync(join(tmpdir(), "agentes-web-"));
  try {
    writeFileSync(join(web, "index.html"), index);
    const app = createApp({
      edition: "cloud",
      version: "test",
      modules: [],
      pingDatabase: async () => {},
      services: { db: s.db, auth: s.auth, config: s.config, adapters: s.adapters },
      webDir: web,
    });
    const page = async (path: string, host: string) => {
      const res = await app.request(path, { headers: { host } });
      expect(res.status).toBe(200);
      return res.text();
    };
    for (const path of ["/", "/login", "/invite/abc"]) {
      expect(await page(path, HOST)).toStartWith('<!doctype html>\n<html data-host lang="en"');
      expect(await page(path, "localhost:3000")).toBe(index);
    }
  } finally {
    rmSync(web, { recursive: true, force: true });
  }
});
