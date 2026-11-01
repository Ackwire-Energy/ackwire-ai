import { describe, expect, test } from "bun:test";
import type { Connection, ConnectorDef, CustomServer } from "@agenteschat/client";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { choiceOf, MAIL_BRANDS } from "@agenteschat/client/lib/mail";
import type { TFunction } from "i18next";
import {
  accountActions,
  authAnswerOf,
  brandOf,
  capabilityLines,
  connectHow,
  connectionOf,
  doneFinishing,
  galleryTiles,
  iconUri,
  isFinishing,
  isHttpsUrl,
  markFinishing,
  monogram,
  needsKeyText,
  noResults,
  ownMarkUri,
  searchConnectors,
  shownMailboxes,
  stateOf,
  suggestionsOf,
} from "../../src/features/connectors/logic";
import { translator } from "./fixtures";

const def = (id: string, over: Partial<ConnectorDef> = {}): ConnectorDef => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  description: `${id} for Acme`,
  kind: "catalog",
  category: "dev",
  auth: ["oauth", "api_key"],
  oauthConfigured: true,
  available: true,
  serverUrl: `https://mcp.${id}.example/mcp`,
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

const server = (serverUrl: string): CustomServer => ({
  id: "s-1",
  serverUrl,
  label: "Sentry",
  authType: "oauth",
  tools: [],
  reviewedAt: "2026-10-23T12:00:00.000Z",
  createdAt: "2026-10-23T12:00:00.000Z",
});

describe("connectors gallery", () => {
  test("connected as the web counts it: our connector's connection, or a vendor's server by its address", () => {
    const github = def("github");
    const sentry = def("sentry", { kind: "remote_mcp", serverUrl: "https://mcp.sentry.dev/mcp" });
    const catalog = [github, sentry];
    expect(connectionOf(github, connectedItems([conn("github")], [], catalog))?.id).toBe("c-github");
    // Sentry connected on the web lives in the servers' list (its address may differ by a slash or case).
    const items = connectedItems([], [server("https://MCP.sentry.dev/mcp/")], catalog);
    expect(connectionOf(sentry, items)?.id).toBe("s-1");
    expect(connectionOf(github, items)).toBeUndefined();
    const revoked = conn("github", { revokedAt: "2026-10-23T13:00:00.000Z" });
    expect(connectionOf(github, connectedItems([revoked], [], catalog))).toBeUndefined();
  });

  test("suggestions: the first three ready here and not connected, in our order", () => {
    const catalog = ["github", "linear", "notion", "drive", "sentry"].map((id) => def(id));
    catalog[2] = def("notion", { available: false });
    const items = connectedItems([conn("github")], [], catalog);
    expect(suggestionsOf(catalog, items).map((d) => d.id)).toEqual(["linear", "drive", "sentry"]);
  });

  test("'Em breve': a vendor that hasn't approved agentes.chat yet is last, greyed with a lock, and opens nothing", () => {
    const asana = def("asana", { kind: "remote_mcp", available: false, soon: true });
    const slack = def("slack", { available: false });
    expect(
      galleryTiles([asana, def("github"), slack, def("linear")], []).map((x) => [x.def.id, x.opens, x.locked]),
    ).toEqual([
      ["github", true, false],
      ["linear", true, false],
      ["asana", false, true],
      ["slack", false, false],
    ]);
  });

  test("a 'soon' one connected by its address (with a key) is a connection like any other: a check, no lock, it opens", () => {
    const asana = def("asana", {
      kind: "remote_mcp",
      serverUrl: "https://mcp.asana.com/mcp",
      available: false,
      soon: true,
    });
    const list = [def("slack", { available: false }), asana, def("github")];
    const items = connectedItems([], [server("https://mcp.asana.com/mcp")], list);
    // With the ones that open, before what can't connect here.
    expect(galleryTiles(list, items).map((x) => [x.def.id, x.connected, x.opens, x.locked])).toEqual([
      ["asana", true, true, false],
      ["github", false, true, false],
      ["slack", false, false, false],
    ]);
  });

  test("through Composio on a server without it: hidden, unless already connected (ADR 0107)", () => {
    const url = "https://backend.composio.dev/api/v3.1/toolkits/googledrive";
    const drive = def("drive", { kind: "remote_mcp", via: "composio", available: false, serverUrl: url });
    expect(galleryTiles([drive, def("github")], []).map((x) => x.def.id)).toEqual(["github"]);
    const items = connectedItems([], [{ ...server(url), via: "composio" }], [drive]);
    expect(galleryTiles([drive], items).map((x) => [x.def.id, x.connected, x.opens])).toEqual([["drive", true, true]]);
    // Its account shows no address: Composio's means nothing to people.
    expect(items[0]?.account).toBeNull();
  });

  test("a server whose OAuth only lets in apps it approved says so; one with no sign-in just asks for a key", async () => {
    const pt = await translator("pt-BR");
    expect(needsKeyText(pt, { status: "needs_key", reason: "not_approved" }, "Asana")).toBe(
      "Asana só deixa entrar apps que aprovou, e o agentes.chat ainda não foi aprovado. Se ele te der uma chave de API, dá para conectar com ela.",
    );
    expect(needsKeyText(pt, { status: "needs_key" }, "Asana")).toBe("Esse servidor pede uma chave.");
    const en = await translator("en");
    expect(needsKeyText(en, { status: "needs_key", reason: "not_approved" }, "Asana")).toBe(
      "Asana only lets apps it approved sign in, and agentes.chat isn't approved yet. If it gives you an API key, you can connect with that.",
    );
    // The server's own words under ours: which one refused and why.
    const said = { status: "needs_key", reason: "not_approved", detail: "invalid_redirect_uri: not allowed" } as const;
    expect(needsKeyText(pt, said, "Asana")).toBe(
      "Asana só deixa entrar apps que aprovou, e o agentes.chat ainda não foi aprovado. Se ele te der uma chave de API, dá para conectar com ela.\nO servidor respondeu: invalid_redirect_uri: not allowed",
    );
    expect(needsKeyText(en, said, "Asana").split("\n")[1]).toBe(
      "The server answered: invalid_redirect_uri: not allowed",
    );
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

  test("a MillionSend inbox's sheet says what agents can do there as the web's card does, in both languages", async () => {
    const routines = { "pt-BR": "Acordar rotinas quando chega um email", en: "Wake routines when an email arrives" };
    for (const lng of ["pt-BR", "en"] as const) {
      const tr = (await translator(lng)) as unknown as (key: string) => string;
      const lines = capabilityLines(
        tr,
        (k) => tr(k) !== k,
        { id: "mail-millionsend", scopes: [] },
        () => "",
      );
      expect(lines).toHaveLength(4);
      expect(lines[2]).toEqual({ text: routines[lng], asks: false });
      expect(lines[3]?.asks).toBe(true);
    }
    // Its tile and a connected inbox's: MillionSend's M, tinted in the ink like the connector's.
    const mark = MAIL_BRANDS[choiceOf({ provider: "millionsend", preset: null })];
    expect(mark).toEqual({ name: "MillionSend", iconUrl: "/connectors/millionsend.svg", brandColor: null });
    expect(iconUri("https://app.agentes.chat", mark?.iconUrl ?? null)).toBe(
      "https://app.agentes.chat/connectors/millionsend.svg",
    );
  });

  test("the connected row leaves out sign-ins still pending; a search the Email card matches isn't 'no results'", () => {
    const boxes = [
      { id: "m1", status: "active", label: "Suporte" },
      { id: "m2", status: "pending", label: "" },
      { id: "m3", status: "needs_reconnect", label: "Vendas" },
    ];
    expect(shownMailboxes(boxes).map((a) => a.id)).toEqual(["m1", "m3"]);
    // "caixa" matches only the MillionSend card under Email.
    expect(noResults(0, true, true)).toBe(false);
    expect(noResults(0, true, false)).toBe(true);
    // Not searching, the card is always there: a category with no tiles still says so.
    expect(noResults(0, false, true)).toBe(true);
    expect(noResults(2, true, false)).toBe(false);
  });
});

describe("several accounts of one service", () => {
  const t = ((key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key) as unknown as TFunction;
  const sentry = def("sentry", { kind: "remote_mcp", serverUrl: "https://mcp.sentry.dev/mcp" });
  const items = connectedItems(
    [conn("github", { label: "Github" })],
    [
      server("https://mcp.sentry.dev/mcp"),
      { ...server("https://mcp.sentry.dev/mcp"), id: "s-2", label: "Sentry 2", createdAt: "2026-10-24T12:00:00.000Z" },
    ],
    [def("github"), sentry],
  );

  test("the connected strip and each screen name every account apart", () => {
    expect(items.map((i) => itemName(t, i))).toEqual(["Github", "Sentry", "Sentry 2"]);
  });

  test("a connected account's screen: rename and sign in again; an MCP server also takes another account", () => {
    expect(items.map((i) => accountActions(i))).toEqual([
      ["rename", "reconnect"],
      ["rename", "reconnect", "add"],
      ["rename", "reconnect", "add"],
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
  expect(iconUri("https://app.agentes.chat", "/connectors/github.svg")).toBe(
    "https://app.agentes.chat/connectors/github.svg",
  );
  expect(iconUri("https://app.agentes.chat", "https://evil.example/x.svg")).toBeNull();
  expect(iconUri("https://app.agentes.chat", null)).toBeNull();
  // A mark in its maker's colors (PayPal's, Canva's) is drawn as it is, never tinted, and only a file of ours.
  expect(ownMarkUri("https://app.agentes.chat", "/brands/paypal.svg")).toBe(
    "https://app.agentes.chat/brands/paypal.svg",
  );
  expect(iconUri("https://app.agentes.chat", "/brands/paypal.svg")).toBeNull();
  expect(ownMarkUri("https://app.agentes.chat", "/connectors/github.svg")).toBeNull();
  expect(ownMarkUri("https://app.agentes.chat", "/brands/../x.svg")).toBeNull();
  expect(ownMarkUri("https://app.agentes.chat", "https://evil.example/brands/x.svg")).toBeNull();
  expect(brandOf("#1a2b3c")).toBe("#1a2b3c");
  expect(brandOf("red")).toBeNull();
  expect(monogram("Google Drive")).toBe("GD");
  expect(monogram("acme")).toBe("A");
  expect(isHttpsUrl("https://mcp.acme.dev/sse")).toBe(true);
  expect(isHttpsUrl("http://mcp.acme.dev")).toBe(false);
});
