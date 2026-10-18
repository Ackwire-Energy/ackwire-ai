import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type DeviceCode,
  devicePair,
  type FetchFn,
  formatUserCode,
  orgSlug,
  pollDeviceToken,
  uniqueWorkspace,
} from "../../runner/pairing";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const SERVER = "https://agentes.test";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake server: `/device` hands out a code, `/device/token` answers from a script. */
function fakeServer(answers: Response[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/api/machines/device")) {
      return json(200, {
        deviceCode: "dc_secret",
        userCode: "K7Q4ZP",
        verificationUrl: `${SERVER}/conectar?code=K7Q4ZP`,
        expiresIn: 600,
        interval: 3,
      });
    }
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  };
  return { fetch, calls };
}

const GRANT = { token: "agm_new", machineId: "m1", name: "Notebook", org: { id: "o1", name: "Acme" } };

test("device flow: pending, slow_down (+5 s), then the token", async () => {
  const server = fakeServer([
    json(400, { error: "authorization_pending" }),
    json(400, { error: "slow_down" }),
    json(400, { error: "authorization_pending" }),
    json(200, GRANT),
  ]);
  const sleeps: number[] = [];
  const codes: DeviceCode[] = [];
  const grant = await devicePair(
    SERVER,
    { name: "Notebook", os: "darwin", arch: "arm64", hostname: "nb", version: "0.9.0" },
    (c) => codes.push(c),
    { fetch: server.fetch, sleep: async (ms) => void sleeps.push(ms) },
  );
  expect(grant).toEqual(GRANT);
  expect(codes[0]).toMatchObject({ userCode: "K7Q4ZP", verificationUrl: `${SERVER}/conectar?code=K7Q4ZP` });
  expect(sleeps).toEqual([3000, 3000, 8000, 8000]);
  expect(server.calls[0]).toEqual({
    url: `${SERVER}/api/machines/device`,
    body: { name: "Notebook", os: "darwin", arch: "arm64", hostname: "nb", version: "0.9.0" },
  });
  expect(server.calls.slice(1).every((c) => (c.body as { deviceCode: string }).deviceCode === "dc_secret")).toBe(true);
});

test("device flow: expired and denied stop with their own code; a network blip is retried", async () => {
  const code: DeviceCode = { deviceCode: "dc", userCode: "ABC234", verificationUrl: "x", expiresIn: 600, interval: 1 };
  const sleep = async () => {};
  const expired = fakeServer([json(400, { error: "expired_token" })]);
  await expect(pollDeviceToken(SERVER, code, { fetch: expired.fetch, sleep })).rejects.toMatchObject({
    code: "expired",
  });

  const denied = fakeServer([json(400, { error: "authorization_pending" }), json(400, { error: "access_denied" })]);
  await expect(pollDeviceToken(SERVER, code, { fetch: denied.fetch, sleep })).rejects.toMatchObject({ code: "denied" });

  // The server's other error shape (`{ error: { code } }`) is understood too.
  const nested = fakeServer([json(400, { error: { code: "expired_token", message: "gone" } })]);
  await expect(pollDeviceToken(SERVER, code, { fetch: nested.fetch, sleep })).rejects.toMatchObject({
    code: "expired",
  });

  let n = 0;
  const flaky: FetchFn = async () => {
    n++;
    if (n === 1) throw new Error("ECONNRESET");
    if (n === 2) return json(503, {});
    return json(200, GRANT);
  };
  expect(await pollDeviceToken(SERVER, code, { fetch: flaky, sleep })).toEqual(GRANT);

  // The code's time runs out while the person hasn't confirmed: expired.
  let clock = 0;
  const pending: FetchFn = async () => json(400, { error: "authorization_pending" });
  await expect(
    pollDeviceToken(
      SERVER,
      { ...code, expiresIn: 5 },
      {
        fetch: pending,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    ),
  ).rejects.toMatchObject({ code: "expired" });
});

test("a canceled pairing stops at once", async () => {
  const ac = new AbortController();
  const code: DeviceCode = { deviceCode: "dc", userCode: "ABC234", verificationUrl: "x", expiresIn: 600, interval: 3 };
  const p = pollDeviceToken(SERVER, code, {
    fetch: async () => json(400, { error: "authorization_pending" }),
    signal: ac.signal,
  });
  ac.abort();
  await expect(p).rejects.toMatchObject({ code: "canceled" });
});

test("the code is shown as K7Q·4ZP; workspaces are named after the organization", () => {
  expect(formatUserCode("K7Q4ZP")).toBe("K7Q·4ZP");
  expect(formatUserCode("k7q-4zp")).toBe("K7Q·4ZP");
  expect(orgSlug("Ação & Cia.")).toBe("acao-cia");
  expect(orgSlug("!!!")).toBe("org");

  const base = tempDir("agentes-");
  dirs.push(base);
  expect(uniqueWorkspace(base, "Acme")).toBe(path.join(base, "acme"));
  mkdirSync(path.join(base, "acme"));
  // An empty folder of that name is fine; one with something in it is taken.
  expect(uniqueWorkspace(base, "Acme")).toBe(path.join(base, "acme"));
  writeFileSync(path.join(base, "acme", "notes.txt"), "mine");
  expect(uniqueWorkspace(base, "Acme")).toBe(path.join(base, "acme-2"));
});
