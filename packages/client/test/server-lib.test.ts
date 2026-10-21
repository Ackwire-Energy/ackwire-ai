import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/api/http";
import {
  APP_API,
  checkServer,
  connectLink,
  isTailnet,
  normalizeServer,
  parseConnectLink,
  readInstance,
  serverHost,
} from "../src/lib/server";

const instance = (over: Record<string, unknown> = {}) => ({
  name: "agentes.chat",
  version: "1.2.0",
  api: APP_API,
  minApi: APP_API,
  url: "https://box.tail1234.ts.net",
  signIn: { email: true, google: false, github: false, apple: false },
  signup: "invite",
  ...over,
});

/** Answers per origin; a string throws that error message instead. */
function fakeFetch(answers: Record<string, { status: number; body?: unknown } | string>): FetchLike {
  return async (url) => {
    const answer = answers[new URL(url).origin];
    if (answer === undefined || typeof answer === "string") throw new TypeError(answer ?? "Network request failed");
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  };
}

describe("server addresses", () => {
  test("a host or a full URL becomes the server's origin", () => {
    expect(normalizeServer("agentes.tail1234.ts.net")).toBe("https://agentes.tail1234.ts.net");
    expect(normalizeServer("  https://Chat.Example.com/login?x=1 ")).toBe("https://chat.example.com");
    expect(normalizeServer("box.tail1234.ts.net:8443")).toBe("https://box.tail1234.ts.net:8443");
    expect(normalizeServer("https://agentes.chat/")).toBe("https://agentes.chat");
  });

  test("https only; http just for a development build on the local network", () => {
    expect(normalizeServer("http://chat.example.com")).toBeNull();
    expect(normalizeServer("http://chat.example.com", { allowHttp: true })).toBeNull();
    expect(normalizeServer("http://192.168.0.12:3000")).toBeNull();
    expect(normalizeServer("http://192.168.0.12:3000", { allowHttp: true })).toBe("http://192.168.0.12:3000");
    expect(normalizeServer("http://localhost:3000", { allowHttp: true })).toBe("http://localhost:3000");
    expect(normalizeServer("http://mac-mini.local:3000", { allowHttp: true })).toBe("http://mac-mini.local:3000");
  });

  test("not a server address", () => {
    for (const bad of ["", "   ", "agentes chat", "ftp://files.example.com", "https://ana:segredo@chat.example.com"])
      expect(normalizeServer(bad)).toBeNull();
  });

  test("the host to show, and whether it is on a tailnet", () => {
    expect(serverHost("https://box.tail1234.ts.net")).toBe("box.tail1234.ts.net");
    expect(serverHost("https://chat.example.com:8443")).toBe("chat.example.com:8443");
    expect(isTailnet("https://box.tail1234.ts.net")).toBe(true);
    expect(isTailnet("https://agentes.chat")).toBe(false);
  });
});

describe("connect links", () => {
  test("round trip, with and without a sign-in token", () => {
    const link = connectLink("https://box.tail1234.ts.net", "tok_123");
    expect(link).toBe("agenteschat://connect?server=https%3A%2F%2Fbox.tail1234.ts.net&token=tok_123");
    expect(parseConnectLink(link)).toEqual({ server: "https://box.tail1234.ts.net", token: "tok_123" });
    expect(parseConnectLink(connectLink("https://agentes.chat"))).toEqual({ server: "https://agentes.chat" });
    expect(parseConnectLink("agenteschat:///connect?server=https://agentes.chat")).toEqual({
      server: "https://agentes.chat",
    });
  });

  test("anything else is not a connect link", () => {
    for (const other of [
      "https://agentes.chat",
      "agenteschat://chat/123",
      "agenteschat://connect",
      "agenteschat://connect?server=",
      "agenteschat://connect?server=http%3A%2F%2Fchat.example.com",
      "WIFI:S:office;T:WPA;P:secret;;",
    ])
      expect(parseConnectLink(other)).toBeNull();
  });
});

describe("checking a server", () => {
  test("an agentes.chat server the app can use", () => {
    expect(readInstance("https://box.tail1234.ts.net", instance())).toMatchObject({ ok: true });
  });

  test("not ours, or a version that doesn't match", () => {
    expect(readInstance("https://x", { status: "ok" })).toEqual({ ok: false, problem: "not-agentes" });
    expect(readInstance("https://x", null)).toEqual({ ok: false, problem: "not-agentes" });
    expect(readInstance("https://x", instance({ api: APP_API - 1, minApi: APP_API - 1 }))).toEqual({
      ok: false,
      problem: "server-too-old",
    });
    expect(readInstance("https://x", instance({ api: APP_API + 2, minApi: APP_API + 1 }))).toEqual({
      ok: false,
      problem: "app-too-old",
    });
  });

  test("asks GET /api/instance", async () => {
    const box = "https://box.tail1234.ts.net";
    const ok = await checkServer(box, fakeFetch({ [box]: { status: 200, body: instance() } }));
    expect(ok).toMatchObject({ ok: true, server: box, instance: { signup: "invite" } });
    expect(await checkServer(box, fakeFetch({ [box]: { status: 404, body: { error: "nope" } } }))).toEqual({
      ok: false,
      problem: "not-agentes",
    });
    expect(await checkServer(box, fakeFetch({ [box]: { status: 502 } }))).toEqual({
      ok: false,
      problem: "unreachable",
    });
  });

  test("a name not found reads as unreachable; a bad certificate is said as such", async () => {
    const box = "https://box.tail1234.ts.net";
    const unknownHost = 'fetch failed: Unable to resolve host "box.tail1234.ts.net"';
    expect(await checkServer(box, fakeFetch({ [box]: unknownHost }))).toEqual({ ok: false, problem: "unreachable" });
    for (const tls of [
      "fetch failed: The certificate for this server is invalid.",
      "fetch failed: O certificado deste servidor é inválido.",
      "fetch failed: javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found.",
    ])
      expect(await checkServer(box, fakeFetch({ [box]: tls }))).toEqual({ ok: false, problem: "certificate" });
  });

  test("gives up after the timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted."))),
      );
    expect(await checkServer("https://box.tail1234.ts.net", hang, 10)).toEqual({ ok: false, problem: "unreachable" });
  });

  test("the server's own address wins when it answers; otherwise the one typed stays", async () => {
    const typed = "https://100.101.102.103";
    const own = "https://box.tail1234.ts.net";
    const both = fakeFetch({ [typed]: { status: 200, body: instance() }, [own]: { status: 200, body: instance() } });
    expect(await checkServer(typed, both)).toMatchObject({ ok: true, server: own });
    const onlyTyped = fakeFetch({ [typed]: { status: 200, body: instance() } });
    expect(await checkServer(typed, onlyTyped)).toMatchObject({ ok: true, server: typed });
    // A server that calls itself by an http address keeps the one typed.
    const local = fakeFetch({ [typed]: { status: 200, body: instance({ url: "http://localhost:3000" }) } });
    expect(await checkServer(typed, local)).toMatchObject({ ok: true, server: typed });
  });
});
