import { describe, expect, test } from "bun:test";
import type { Connection, ConnectorDef } from "@agenteschat/client";
import {
  authAnswerOf,
  brandOf,
  capabilityLines,
  connectHow,
  connectionOf,
  doneFinishing,
  iconUri,
  isFinishing,
  isHttpsUrl,
  markFinishing,
  monogram,
  searchConnectors,
  stateOf,
  suggestionsOf,
} from "../../src/features/connectors/logic";

const def = (id: string, over: Partial<ConnectorDef> = {}): ConnectorDef => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  description: `${id} for Acme`,
  kind: "catalog",
  category: "dev",
  auth: ["oauth", "api_key"],
  oauthConfigured: true,
  available: true,
  needsServerUrl: false,
  serverUrl: null,
  iconUrl: `/connectors/${id}.svg`,
  brandColor: "#181717",
  scopes: [],
  tools: [],
  ...over,
});

const conn = (connector: string, over: Partial<Connection> = {}): Connection => ({
  id: `c-${connector}`,
  connector,
  label: connector,
  serverUrl: "https://mcp.example.com",
  authType: "oauth",
  accountLabel: null,
  tokenExpiresAt: null,
  createdAt: "2026-10-23T12:00:00.000Z",
  revokedAt: null,
  ...over,
});

describe("connectors gallery", () => {
  test("a connection is matched by service, or by address for a vendor's own server; revoked ones don't count", () => {
    const linear = def("linear", { kind: "remote_mcp", serverUrl: "https://mcp.linear.app/sse" });
    expect(connectionOf(def("github"), [conn("github")])?.id).toBe("c-github");
    expect(connectionOf(linear, [conn("custom", { serverUrl: "https://mcp.linear.app/sse" })])).toBeDefined();
    expect(connectionOf(def("github"), [conn("github", { revokedAt: "2026-10-23T13:00:00.000Z" })])).toBeUndefined();
  });

  test("suggestions: the first three ready here and not connected, in our order", () => {
    const catalog = ["github", "linear", "notion", "drive", "sentry"].map((id) => def(id));
    catalog[2] = def("notion", { available: false });
    expect(suggestionsOf(catalog, [conn("github")]).map((d) => d.id)).toEqual(["linear", "drive", "sentry"]);
  });

  test("search covers the name, id, description and the translated text", () => {
    const list = [def("github"), def("stripe", { description: "Payments" })];
    expect(searchConnectors(list, "pay").map((d) => d.id)).toEqual(["stripe"]);
    const shown = (d: ConnectorDef) => (d.id === "stripe" ? "Cobranças" : "");
    expect(searchConnectors(list, "cobrança", shown).map((d) => d.id)).toEqual(["stripe"]);
    expect(searchConnectors(list, "  ")).toHaveLength(2);
  });

  test("how it connects on the phone", () => {
    expect(connectHow(def("github"))).toBe("either");
    expect(connectHow(def("sentry", { oauthConfigured: false }))).toBe("key");
    expect(connectHow(def("drive", { auth: ["oauth"] }))).toBe("signIn");
    expect(connectHow(def("linear", { kind: "remote_mcp" }))).toBe("signIn");
  });

  test("what agents could do: our plain lines when we have them (ask last), else the scopes", () => {
    const words: Record<string, string> = {
      "connectors.can.github.1": "Ler código",
      "connectors.can.github.2": "Abrir PRs",
      "connectors.can.github.ask": "Fazer merge",
    };
    const tr = (k: string) => words[k] ?? k;
    const exists = (k: string) => k in words;
    expect(capabilityLines(tr, exists, def("github"), () => "")).toEqual([
      { text: "Ler código", asks: false },
      { text: "Abrir PRs", asks: false },
      { text: "Fazer merge", asks: true },
    ]);
    const sentry = def("sentry", {
      scopes: [
        { id: "sentry:issues.read", label: "Read issues", description: "", sensitive: false },
        { id: "sentry:issues.resolve", label: "Resolve issues", description: "", sensitive: true },
      ],
    });
    expect(capabilityLines(tr, exists, sentry, (s) => s.label)).toEqual([
      { text: "Read issues", asks: false },
      { text: "Resolve issues", asks: true },
    ]);
  });
});

describe("the browser round trip", () => {
  test("the state in the authorize URL, and the answer the browser brings back", () => {
    expect(stateOf("https://github.com/login/oauth/authorize?state=abc&client_id=x")).toBe("abc");
    expect(stateOf("not a url")).toBeNull();
    expect(authAnswerOf("agenteschat://connectors/oauth?state=abc&code=123")).toEqual({
      kind: "code",
      state: "abc",
      code: "123",
    });
    expect(authAnswerOf("agenteschat://connectors/oauth?error=access_denied")).toEqual({
      kind: "error",
      error: "access_denied",
    });
    expect(authAnswerOf("agenteschat://connectors/oauth?state=abc")).toBeNull();
  });

  test("an authorization the sheet is finishing is left alone by the link route", () => {
    markFinishing("s1");
    expect(isFinishing("s1")).toBe(true);
    doneFinishing("s1");
    expect(isFinishing("s1")).toBe(false);
  });
});

test("icons only from our own path; brand colors only as #rrggbb; monograms; https addresses", () => {
  expect(iconUri("https://agentes.chat", "/connectors/github.svg")).toBe("https://agentes.chat/connectors/github.svg");
  expect(iconUri("https://agentes.chat", "https://evil.example/x.svg")).toBeNull();
  expect(iconUri("https://agentes.chat", null)).toBeNull();
  expect(brandOf("#1a2b3c")).toBe("#1a2b3c");
  expect(brandOf("red")).toBeNull();
  expect(monogram("Google Drive")).toBe("GD");
  expect(monogram("acme")).toBe("A");
  expect(isHttpsUrl("https://mcp.acme.dev/sse")).toBe(true);
  expect(isHttpsUrl("http://mcp.acme.dev")).toBe(false);
});
