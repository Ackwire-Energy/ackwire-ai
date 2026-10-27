import { describe, expect, test } from "bun:test";
import type { ConnectorDef, CustomServer, CustomTool, ToolAccess } from "@agenteschat/client";
import { type ReviewTool, reviewDecisions, reviewToolsOf } from "@agenteschat/client/lib/tool-review";
import {
  ADDRESS_STEPS,
  acceptAll,
  CATALOG_STEPS,
  catalogReviewTools,
  choicesOf,
  chosenLevel,
  choose,
  confirm,
  emptyReview,
  firstStep,
  isWaiting,
  returnHref,
  reviewAgain,
  reviewTarget,
  STEP_KEYS,
  subjectsOf,
  waitingHits,
} from "../../src/features/connectors/review";
import { translator } from "./fixtures";

const def = (id: string, over: Partial<ConnectorDef> = {}): ConnectorDef => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  description: `${id} for Acme`,
  kind: "catalog",
  category: "dev",
  auth: ["oauth"],
  oauthConfigured: true,
  available: true,
  needsServerUrl: false,
  serverUrl: null,
  iconUrl: null,
  brandColor: null,
  scopes: [],
  tools: [],
  ...over,
});

/** A tool as the server sends it, classified (as the backend does: the verb, or the judge for ambiguous names). */
const tool = (name: string, level: ToolAccess, over: Partial<CustomTool> = {}): CustomTool => ({
  name,
  description: "",
  readOnlyHint: null,
  suggestedAccess: level,
  access: null,
  level,
  suggestionSource: "verb",
  suggestionReason: null,
  sensitive: false,
  pending: false,
  off: false,
  subject: name.split("_").at(-1)?.replace(/s$/, ""),
  label: "",
  firstSeenAt: "2026-10-23T12:00:00.000Z",
  ...over,
});

const server = (tools: CustomTool[], over: Partial<CustomServer> = {}): CustomServer => ({
  id: "s-1",
  serverUrl: "https://mcp.acme.dev/mcp",
  label: "Suporte",
  authType: "api_key",
  tools,
  reviewedAt: null,
  createdAt: "2026-10-23T12:00:00.000Z",
  ...over,
});

/** One tool of the list, by its technical name. */
const named = (tools: ReviewTool[], name: string) => tools.find((x) => x.name === name) as ReviewTool;

const TOOLS = [
  tool("list_tickets", "read"),
  tool("create_ticket", "write"),
  tool("close_ticket", "write", { suggestionSource: "judge", suggestionReason: "changes_undoable", pending: true }),
  tool("delete_customer", "approval", { sensitive: true }),
];

describe("where the sheet is", () => {
  test("the steps: a catalog service starts with what it does, a server by address with connecting", () => {
    expect(CATALOG_STEPS).toEqual(["about", "connect", "review", "who"]);
    expect(ADDRESS_STEPS).toEqual(["connect", "review", "who"]);
  });

  test("a new service opens on what it does; a connection on who uses it, or its tools while they wait", () => {
    expect(firstStep(undefined, true)).toBe("about");
    expect(firstStep({ needsReview: false }, true)).toBe("who");
    expect(firstStep({ needsReview: true }, true)).toBe("review");
    // Only admins review (as on the web): anyone else sees who uses it.
    expect(firstStep({ needsReview: true }, false)).toBe("who");
    // Back from a sign-in: on its tools, reviewed or not; never for someone who can't change them.
    expect(firstStep({ needsReview: false }, true, "review")).toBe("review");
    expect(firstStep({ needsReview: true }, false, "review")).toBe("who");
  });

  test("each step has a name in both languages, and the dashes say where the flow is", async () => {
    for (const lng of ["pt-BR", "en"] as const) {
      const t = await translator(lng);
      for (const key of Object.values(STEP_KEYS)) expect(t(key)).not.toBe(key);
    }
    const t = await translator("pt-BR");
    expect(t("mobile.connectors.step", { n: 3, total: 4, label: t(STEP_KEYS.review) })).toBe(
      "Passo 3 de 4: O que faz",
    );
    const en = await translator("en");
    expect(en("mobile.connectors.step", { n: 2, total: 3, label: en(STEP_KEYS.review) })).toMatch(/^Step 2 of 3: /);
  });

  test("back from a sign-in on the link route, Conectores opens that connection's tools", () => {
    expect(returnHref("c-1")).toEqual({ pathname: "/connectors", params: { connected: "c-1" } });
  });
});

describe("what the review shows", () => {
  test("a server by address: its own tools, whatever the catalog says; ours by scope; else wait for the list", () => {
    const s = server(TOOLS);
    expect(reviewTarget("s-1", null, [s], false)).toEqual({ kind: "server", server: s });
    // A vendor's server from the catalog (Sentry's) is a server too.
    const sentry = def("sentry", { kind: "remote_mcp", serverUrl: s.serverUrl });
    expect(reviewTarget("s-1", sentry, [s], false).kind).toBe("server");
    const github = def("github");
    expect(reviewTarget("c-github", github, [s], false)).toEqual({ kind: "catalog", def: github });
    // Just connected: the servers' list is still catching up.
    expect(reviewTarget("s-2", null, [s], true).kind).toBe("loading");
    expect(reviewTarget("s-2", sentry, undefined, false).kind).toBe("loading");
    expect(reviewTarget("s-2", null, [s], false).kind).toBe("none");
  });

  test("our catalog tools, read-only: sensitive ones ask, `.read` scopes only read, the rest change things", async () => {
    const t = await translator("pt-BR");
    const github = def("github", {
      tools: [
        { name: "github_list_issues", scope: "github:issues.read", sensitive: false },
        { name: "github_create_issue", scope: "github:issues.write", sensitive: false },
        { name: "github_merge_pull_request", scope: "github:pulls.write", sensitive: true },
      ],
    });
    const tools = catalogReviewTools(t, github);
    expect(tools.map((x) => [x.name, x.level, x.pending])).toEqual([
      ["github_list_issues", "read", false],
      ["github_create_issue", "write", false],
      ["github_merge_pull_request", "approval", false],
    ]);
    // Readable names in the person's language (the service's prefix dropped), grouped by what they're about.
    expect(tools[0]?.label).toBe("Listar issues");
    expect(tools[0]?.subject).toBe("issue");
    expect(choicesOf(named(tools, "github_merge_pull_request"))).toEqual(["approval", "off"]);
  });
});

describe("deciding", () => {
  test("the web's choices: four levels, sensitive tools only ask or are off", async () => {
    const t = await translator("pt-BR");
    const tools = reviewToolsOf(t, server(TOOLS));
    expect(choicesOf(named(tools, "list_tickets"))).toEqual(["read", "write", "approval", "off"]);
    expect(choicesOf(named(tools, "delete_customer"))).toEqual(["approval", "off"]);
    expect(t("toolReview.short.approval")).toBe("Aprovação");
  });

  test("a waiting tool leaves the group when a level is picked or its suggestion confirmed", async () => {
    const t = await translator("pt-BR");
    const tools = reviewToolsOf(t, server(TOOLS));
    const list = named(tools, "list_tickets");
    const close = named(tools, "close_ticket");
    let state = emptyReview();
    expect(tools.filter((x) => isWaiting(state, x)).map((x) => x.name)).toEqual(["close_ticket"]);
    // Changing a settled tool keeps it where it is.
    state = choose(state, list, "off");
    expect(chosenLevel(state, list)).toBe("off");
    expect(state.decided.size).toBe(0);
    // OK keeps the suggestion and decides it.
    const ok = confirm(state, close);
    expect(chosenLevel(ok, close)).toBe("write");
    expect(isWaiting(ok, close)).toBe(false);
    // Picking another level decides it too.
    const picked = choose(state, close, "approval");
    expect(chosenLevel(picked, close)).toBe("approval");
    expect(isWaiting(picked, close)).toBe(false);
    // "Aceitar as sugestões", then "Rever as sugestões" brings them back with the levels kept.
    const all = acceptAll(picked, tools);
    expect(tools.some((x) => isWaiting(all, x))).toBe(false);
    const again = reviewAgain(all);
    expect(isWaiting(again, close)).toBe(true);
    expect(chosenLevel(again, close)).toBe("approval");
  });

  test("what Continuar saves: every tool's level; a waiting one nobody decided stays unconfirmed", async () => {
    const t = await translator("pt-BR");
    const tools = reviewToolsOf(t, server(TOOLS));
    const state = choose(emptyReview(), named(tools, "list_tickets"), "off");
    expect(reviewDecisions(tools, state.levels, state.decided).map((d) => [d.name, d.access, d.confirmed])).toEqual([
      ["list_tickets", "off", true],
      ["create_ticket", "write", true],
      ["close_ticket", "write", false],
      ["delete_customer", "approval", true],
    ]);
    const decided = confirm(state, named(tools, "close_ticket"));
    expect(reviewDecisions(tools, decided.levels, decided.decided)[2]?.confirmed).toBe(true);
  });
});

describe("the list", () => {
  test("by subject (the decided ones join theirs), searchable by the readable or the technical name", async () => {
    const t = await translator("pt-BR");
    const tools = reviewToolsOf(t, server(TOOLS));
    const state = emptyReview();
    const settled = tools.filter((x) => !isWaiting(state, x));
    const groups = subjectsOf(t, settled, "");
    expect(groups.map((g) => [g.label, g.tools.map((x) => x.name)])).toEqual([
      ["Chamados", ["list_tickets", "create_ticket"]],
      ["Clientes", ["delete_customer"]],
    ]);
    expect(waitingHits(state, tools, "").map((h) => h.tool.name)).toEqual(["close_ticket"]);
    // The readable name ("Listar chamados"), else the technical one (then shown under it).
    expect(subjectsOf(t, settled, "listar").flatMap((g) => g.hits.map((h) => [h.tool.name, h.tech]))).toEqual([
      ["list_tickets", false],
    ]);
    expect(subjectsOf(t, settled, "delete_cus").flatMap((g) => g.hits.map((h) => [h.tool.name, h.tech]))).toEqual([
      ["delete_customer", true],
    ]);
    expect(subjectsOf(t, settled, "nada disso")).toEqual([]);
    expect(waitingHits(state, tools, "nada disso")).toEqual([]);
  });
});
