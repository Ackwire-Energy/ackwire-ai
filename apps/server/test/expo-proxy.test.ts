import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, ORIGIN, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    env: {
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
    },
  });
});
afterEach(() => t.close());

const proxy = (authorizationURL: string) =>
  browser(t)(`/api/auth/expo-authorization-proxy?${new URLSearchParams({ authorizationURL })}`, { origin: null });

const google = (params: Record<string, string>) =>
  `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: "google-client",
    redirect_uri: `${ORIGIN}/api/auth/callback/google`,
    response_type: "code",
    state: "state-1",
    ...params,
  })}`;

test("the phone's sign-in proxy goes on to a configured provider, for our client and our callback", async () => {
  const res = await proxy(google({}));
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(google({}));
  const github = `https://github.com/login/oauth/authorize?${new URLSearchParams({
    client_id: "github-client",
    redirect_uri: `${ORIGIN}/api/auth/callback/github`,
    state: "state-2",
  })}`;
  expect((await proxy(github)).status).toBe(302);
});

test("anywhere else is refused, and no state cookie is set", async () => {
  const refused = [
    // Another site: an open redirect on our domain, and a state cookie of the attacker's choosing.
    "https://evil.example/?state=attacker-state",
    // The provider, but someone else's app or callback (it would send the person, or the code, elsewhere).
    google({ client_id: "attacker-client" }),
    google({ redirect_uri: "https://evil.example/callback" }),
    `${google({})}&client_id=attacker-client`,
    // A provider that isn't configured here.
    "https://appleid.apple.com/auth/authorize?client_id=x&redirect_uri=x&state=s",
    "https://accounts.google.com.evil.example/o/oauth2/v2/auth?state=s",
  ];
  for (const url of refused) {
    const res = await proxy(url);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.getSetCookie().some((c) => c.includes("state="))).toBe(false);
  }
});
