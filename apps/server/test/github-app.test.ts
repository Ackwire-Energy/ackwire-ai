import { afterEach, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  GITHUB_APP_ID: "123",
  // base64 of the PEM file, as people paste it into a hosting panel.
  GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey.export({ type: "pkcs1", format: "pem" }).toString()).toString(
    "base64",
  ),
  GITHUB_APP_SLUG: "agentes-chat",
  GITHUB_APP_CLIENT_ID: "Iv1.client",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_WEBHOOK_SECRET: "hook-secret",
};

/** GitHub: the code exchange, and the installations the person can see (only 7). */
const http = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "ghu_person" });
  if (url.startsWith("https://api.github.com/user/installations")) {
    return Response.json({
      installations: [{ id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "all" }],
    });
  }
  return new Response("unexpected", { status: 500 });
}) as unknown as typeof fetch;

test("install from the app: state, callback binding, list, and the webhook unbinding it", async () => {
  t = await createTestServer({ http, env });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);

  const info = (await (await owner(`/api/app/organizations/${orgId}/github-app`)).json()) as {
    installable: boolean;
    installations: unknown[];
  };
  expect(info).toEqual({ installable: true, installations: [] });

  const { installUrl } = (await (
    await owner(`/api/app/organizations/${orgId}/github-app/install`, { json: { returnTo: "/conectores" } })
  ).json()) as { installUrl: string };
  const url = new URL(installUrl);
  expect(url.origin + url.pathname).toBe("https://github.com/apps/agentes-chat/installations/new");
  const state = url.searchParams.get("state") ?? "";

  // An installation the person's GitHub account can't see is refused, back where it started.
  const foreign = await owner(
    `/api/app/github-app/callback?state=${state}&code=c&installation_id=8&setup_action=install`,
  );
  expect(foreign.headers.get("location")).toBe("http://localhost:3000/conectores?github_app_error=not_visible");

  const { installUrl: second } = (await (
    await owner(`/api/app/organizations/${orgId}/github-app/install`, { json: { returnTo: "/conectores" } })
  ).json()) as { installUrl: string };
  const state2 = new URL(second).searchParams.get("state") ?? "";
  const back = await owner(
    `/api/app/github-app/callback?state=${state2}&code=c&installation_id=7&setup_action=install`,
  );
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("http://localhost:3000/conectores?github_app=installed");
  const listed = (await (await owner(`/api/app/organizations/${orgId}/github-app`)).json()) as {
    installations: { installationId: number; accountLogin: string; repositorySelection: string }[];
  };
  expect(listed.installations).toMatchObject([{ installationId: 7, accountLogin: "acme", repositorySelection: "all" }]);

  // Webhook: unsigned or wrongly signed → 401; signed uninstall → unbound.
  const body = JSON.stringify({ action: "deleted", installation: { id: 7 } });
  const hook = (signature?: string) =>
    t.app.request("/api/github-app/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "installation",
        "content-type": "application/json",
        ...(signature ? { "x-hub-signature-256": signature } : {}),
      },
      body,
    });
  expect((await hook()).status).toBe(401);
  expect((await hook("sha256=00")).status).toBe(401);
  const signed = await hook(`sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`);
  expect(signed.status).toBe(202);
  expect(await signed.json()).toEqual({ ok: true, result: "removed" });
  const after = (await (await owner(`/api/app/organizations/${orgId}/github-app`)).json()) as {
    installations: unknown[];
  };
  expect(after.installations).toEqual([]);
});

test("without the app configured: not installable, webhook not mounted", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const info = (await (await owner(`/api/app/organizations/${orgId}/github-app`)).json()) as { installable: boolean };
  expect(info.installable).toBe(false);
  expect((await owner(`/api/app/organizations/${orgId}/github-app/install`, { json: {} })).status).toBe(400);
  const hook = await t.app.request("/api/github-app/webhook", { method: "POST", body: "{}" });
  expect(hook.status).toBe(404);
});

test("GitHub's return without a session in this browser: the sign-in page first, then it finishes", async () => {
  t = await createTestServer({ http, env });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { installUrl } = (await (
    await owner(`/api/app/organizations/${orgId}/github-app/install`, { json: { returnTo: "/conectores" } })
  ).json()) as { installUrl: string };
  const state = new URL(installUrl).searchParams.get("state") ?? "";
  const callback = `/api/app/github-app/callback?state=${state}&code=c&installation_id=7&setup_action=install`;
  const signedOut = await browser(t)(callback);
  expect(signedOut.status).toBe(302);
  const signIn = new URL(signedOut.headers.get("location") ?? "");
  expect(signIn.origin + signIn.pathname).toBe("http://localhost:3000/login");
  expect(signIn.searchParams.get("redirect")).toBe(callback);
  // Signed in, the same address finishes.
  expect((await owner(callback)).headers.get("location")).toBe("http://localhost:3000/conectores?github_app=installed");
});

test("GitHub's return that didn't install: why as a code where it started, never words", async () => {
  const refusing = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input) === "https://github.com/login/oauth/access_token" && String(init?.body).includes("code=bad")
      ? Response.json({ error: "bad_verification_code" })
      : http(input)) as unknown as typeof fetch;
  t = await createTestServer({ http: refusing, env: { ...env, ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const start = async () => {
    const res = await owner(`/api/app/organizations/${orgId}/github-app/install`, {
      json: { returnTo: "/conectores" },
    });
    return new URL(((await res.json()) as { installUrl: string }).installUrl).searchParams.get("state") ?? "";
  };
  const back = async (who: typeof owner, query: string) =>
    (await who(`/api/app/github-app/callback?${query}`)).headers.get("location") ?? "";
  const landing = "http://localhost:3000/conectores?github_app_error=";

  // Someone without rights on that GitHub account asked its owner to install: news, not a failure.
  expect(await back(owner, `state=${await start()}&setup_action=request`)).toBe(`${landing}requested`);
  expect(await back(owner, `state=${await start()}&error=access_denied`)).toBe(`${landing}cancelled`);
  expect(await back(owner, `state=${await start()}&code=c`)).toBe(`${landing}failed`);
  expect(await back(owner, `state=${await start()}&code=bad&installation_id=7&setup_action=install`)).toBe(
    `${landing}failed`,
  );
  const other = browser(t);
  await signUp(other, "other@example.com");
  expect(await back(other, `state=${await start()}&code=c&installation_id=7&setup_action=install`)).toBe(
    `${landing}other_account`,
  );
  expect(await back(owner, "code=c&installation_id=7&setup_action=request")).toBe(
    "http://localhost:3000/?github_app_error=requested",
  );
});
