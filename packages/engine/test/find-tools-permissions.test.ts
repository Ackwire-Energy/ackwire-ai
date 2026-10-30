import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  type ConnectorDeps,
  createApiKeyConnection,
  createBrowserToolSource,
  createConnectorToolSource,
  createDesktopToolSource,
  createOrganization,
  decideApproval,
  drainOutbox,
  grantScopes,
  listApprovals,
  postPersonMessage,
  type ToolContext,
  toolDenyScope,
} from "../src";
import { fakeHub } from "./desktop-fixtures";
import { fakeGithubMcp } from "./fake-mcp";
import { addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { PUBLIC_URL, runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const NOT_YET = "Not allowed for you yet: ";
const TURNED_OFF = "Turned off for you by an admin";

/**
 * `@dev` on a computer that serves the browser, without `browser:use` (the fixture's agent), its issue tools on
 * demand (so `find_tools` is listed) and `request_permission`.
 */
async function browserAgent(options: Parameters<typeof setup>[0] = {}) {
  const computer = { machineId: "", orgId: "" };
  const hub = fakeHub(computer);
  hub.s.status = {
    executors: { browser: { available: true, version: "0.39.1" } },
    access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true } },
  };
  f = await setup({
    issueTools: true,
    permissionTools: true,
    ...options,
    toolSources: [createBrowserToolSource({ machines: { hub: hub.hub }, publicUrl: PUBLIC_URL })],
  });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  Object.assign(computer, { machineId: paired.machineId, orgId: f.org.id });
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
}

/** A run of the agent with no tool group loaded: everything but the core is behind `find_tools`. */
const nothingLoaded = async (): Promise<ToolContext> => ({ ...(await runContext(f)), loadedGroups: [] });

async function findTools(ctx: ToolContext, query: string) {
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name: "find_tools", input: { query } });
  return r?.type === "result" ? r.output.content : "";
}

const OPEN = "- browser_open: Opens a website in the agent's own browser.";

test("find_tools names a tool the agent isn't allowed yet, with the permission to ask for; once given, it's a tool it has", async () => {
  await browserAgent();
  const ctx = await nothingLoaded();
  const text = await findTools(ctx, "open a web page");
  const notYet = text.slice(text.indexOf(NOT_YET));
  expect(notYet).toStartWith(`${NOT_YET}ask a person with request_permission`);
  expect(notYet).toContain(
    `\n- permission "browser:use" (Use a browser: Browse websites in its own browser on the agent's connected computer (logins kept per agent). Needs the browser turned on on that computer.), for:\n  ${OPEN}\n`,
  );
  // Its input never: nothing there is a way to call it.
  expect(notYet).not.toContain("Full address");

  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "browser:use" }]);
  const given = await findTools(ctx, "open a web page");
  expect(given).toContain('other tools for "open a web page" (call one with use_tool):');
  expect(given).toContain("- browser_open: Opens a website");
  const after = given.indexOf(NOT_YET);
  expect(after < 0 ? "" : given.slice(after)).not.toContain("browser_open");
});

test("a tool an admin turned off by name is named as that, never as something to ask for", async () => {
  await browserAgent();
  const ctx = await nothingLoaded();
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "browser:use" },
    { connectionId: null, scope: toolDenyScope("browser_open") },
  ]);
  const text = await findTools(ctx, "open a web page");
  const [usable = "", turnedOff = ""] = text.split(TURNED_OFF);
  expect(turnedOff).toStartWith("; only an admin can turn them back on:\n");
  expect(turnedOff).toContain(OPEN);
  expect(turnedOff).not.toContain("request_permission");
  expect(turnedOff).not.toContain("permission");
  expect(usable).not.toContain("browser_open");
});

test("a tool of a connection the agent lacks names that connection's permission; nothing of another workspace shows", async () => {
  const mcp = fakeGithubMcp();
  const deps = (): ConnectorDeps => ({ db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" });
  f = await setup({
    issueTools: true,
    permissionTools: true,
    toolSources: [
      { name: "connectors", tools: (ctx) => createConnectorToolSource({ ...deps(), connect: mcp.connect }).tools(ctx) },
    ],
  });
  const github = await createApiKeyConnection(deps(), f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "ghp_secret_123456",
  });
  // A new connection is every agent's: take it away from this one, as an admin can.
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, github.id));
  const bia = await addUser(f.db, "bia");
  const { organization: other } = await createOrganization(f.db, bia.id, { name: "Other" });
  const theirs = await createApiKeyConnection(deps(), bia.id, other.id, {
    connector: "github",
    apiKey: "ghp_secret_123456",
  });

  const text = await findTools(await nothingLoaded(), "merge a pull request");
  expect(text.slice(text.indexOf(NOT_YET))).toContain(
    `\n- permission "connector:${github.id}" (GitHub), for:\n  - github_merge_pull_request: [GitHub] Merge a pull request\n`,
  );
  expect(text).not.toContain(theirs.id);
  // The server lists it, but it isn't in our catalog: no agent ever gets it.
  expect(text).not.toContain("delete_repository");
});

const WHY = "I need a person's answer before I go on: this decides what I change next.";
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

test("the request_permission call find_tools suggests is the one the card grants", async () => {
  await browserAgent({
    toolsOnDemand: true,
    reply: (req) => {
      const last = lastText(req);
      if (last.includes("Turned on")) return { chunks: ["Ligado."] };
      // The permission exactly as find_tools wrote it (quotes come escaped in the JSON).
      const permission = /permission \\"([^"\\]+)\\"/.exec(last)?.[1];
      if (permission) {
        return {
          chunks: [],
          toolUses: [{ name: "request_permission", input: { why: WHY, permission, reason: "Open the landing page." } }],
        };
      }
      if (last.includes("open the site"))
        return { chunks: [], toolUses: [{ name: "find_tools", input: { query: "open a web page" } }] };
      return { chunks: ["Feito."] };
    },
  });
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);

  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(approval).toMatchObject({ tool: "request_permission", title: "Turn on: Use a browser" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, f.handlers);

  const scopes = await f.db
    .select({ scope: schema.agentScopes.scope })
    .from(schema.agentScopes)
    .where(eq(schema.agentScopes.agentId, f.agent.id));
  expect(scopes.map((s) => s.scope)).toContain("browser:use");
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  expect(run?.status).toBe("done");
});

const DESKTOP_DO =
  "- desktop_do: Does several steps on the agent's desktop in one go (open an app, click, type, press keys), checking each one.";
const RUN_CODE = `permission "sandbox:run" (Run code: Run code and skill scripts on the agent's computer (files kept between conversations).)`;

test('the desktop, which "all tools" never covers, is named with what giving it means, and with the Run code it needs', async () => {
  f = await setup({
    issueTools: true,
    permissionTools: true,
    toolSources: [
      createDesktopToolSource({ machines: { hub: fakeHub({ machineId: "", orgId: "" }).hub }, publicUrl: PUBLIC_URL }),
    ],
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "*" }]);
  const ctx = await nothingLoaded();
  expect(await findTools(ctx, "click a button in an app")).toContain(
    `${NOT_YET}ask a person with request_permission (the permission as written here, and why), if the request needs it.\n- permission "desktop:use" (Use its desktop: Use any app on its own desktop on the agent's computer; people can watch and take control. It can run anything there, so it also needs Run code, and the desktop turned on on that computer.) and ${RUN_CODE}, for:\n  ${DESKTOP_DO}\n`,
  );

  // Its own permission given, Run code is what's left to ask for: named, and a call says so.
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "desktop:use" }]);
  expect(await findTools(ctx, "click a button in an app")).toContain(`\n- ${RUN_CODE}, for:\n  ${DESKTOP_DO}\n`);
  const call = await f.tools?.invoke(ctx, { toolUseId: "tu_desktop", name: "desktop_do", input: { steps: [] } });
  expect(call?.type === "result" ? call.output.content : "").toBe(
    "Not allowed: this agent lacks the scope sandbox:run. If the request needs it, ask for it with request_permission",
  );
});

test("use_tool with the name of a tool not allowed yet answers as a direct call does", async () => {
  await browserAgent();
  const r = await f.tools?.invoke(await nothingLoaded(), {
    toolUseId: "tu_use",
    name: "use_tool",
    input: { tool: "browser_open", arguments: { url: "https://example.com" } },
  });
  expect(r?.type === "result" ? r.output.content : "").toBe(
    "Not allowed: this agent lacks the scope browser:use. If the request needs it, ask for it with request_permission",
  );
});

test("a tool the run's policy refuses anyway is never named as not allowed yet", async () => {
  await browserAgent();
  const ctx = await nothingLoaded();
  // A routine's background run, which only reads: the browser is refused whatever its grants.
  await f.db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, ctx.runId));
  const text = await findTools(ctx, "open a web page");
  expect(text).toStartWith('No other tool matches "open a web page".');
  expect(text).not.toContain("browser_open");
});

test("a run that can't call request_permission is never told to", async () => {
  await browserAgent({ permissionTools: false });
  const text = await findTools(await nothingLoaded(), "open a web page");
  expect(text).toContain(
    `${NOT_YET}a person can turn these on for you; you can't ask for them from here.\n- permission "browser:use" (Use a browser`,
  );
  expect(text).toContain(`, for:\n  ${OPEN}\n`);
  expect(text).not.toContain("request_permission");
});
