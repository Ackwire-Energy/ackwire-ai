import { and, asc, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { BROWSER_SCOPE, BROWSER_TOOL_INFO, BROWSER_TOOLS, DESKTOP_SCOPE, DESKTOP_TOOL_INFO } from "./browser/types";
import { caches } from "./cache";
import { CONNECTOR_CATALOG } from "./connectors/catalog";
import { connectorGrantValidator } from "./connectors/connections";
import { classifiedTools, customScope, isCustom, type ToolAccess } from "./connectors/custom";
import { exposedToolName } from "./connectors/mcp";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { can, requirePermission } from "./organizations";
import { ALWAYS_SENSITIVE } from "./tools/gateway";
import {
  type AccessState,
  ALL_TOOLS,
  BUILTIN_SCOPES,
  CONNECTOR_ALL,
  grantKey,
  impliedByWrite,
  notMailGrant,
  type ScopeGrant,
  toolAccess,
  toolAllowScope,
  toolDenyScope,
} from "./tools/scopes";

const { agentScopes, connectorConnections, agents } = schema;

/**
 * Built-in tools by scope (what the built-in sources offer). `ask_user` and `react` need no scope. Every
 * built-in scope has an entry, with tools or not: the app saves an agent's access from this tree, so a
 * scope missing here would be dropped by any save.
 */
export const BUILTIN_TOOLS: Record<string, string[]> = {
  "": ["ask_user", "react"],
  "context:read": ["search_context", "get_summary", "expand"],
  "memory:write": ["remember", "update_memory", "forget", "propose_instruction_change"],
  "drive:read": ["read_artifact", "list_artifacts", "share_artifact"],
  "drive:write": ["create_artifact", "update_artifact"],
  "issues:read": ["list_issues"],
  "issues:write": ["create_issue", "update_issue", "comment_issue"],
  "calendar:read": ["list_events", "find_free_time"],
  "calendar:write": ["propose_event"],
  "skills:read": ["load_skill", "read_skill_file"],
  "schedule:write": [
    "schedule_reminder",
    "create_routine",
    "list_routines",
    "update_routine",
    "list_reminders",
    "cancel_reminder",
  ],
  "forum:write": ["suggest_forum_topic", "open_forum_topic", "post_in_forum", "read_forum_topic"],
  "wiki:read": ["search_wiki", "read_wiki_page"],
  "wiki:write": ["create_wiki_page", "update_wiki_page", "link_to_wiki"],
  "sandbox:run": [
    "run_code",
    "write_file",
    "read_file",
    "list_files",
    "export_file",
    "upload_file",
    "import_file",
    "run_skill_script",
    "computer_start",
    "computer_stop",
    "computer_status",
  ],
  [BROWSER_SCOPE]: [...BROWSER_TOOLS],
  [DESKTOP_SCOPE]: Object.keys(DESKTOP_TOOL_INFO),
};

export interface ToolRef {
  connectionId: string | null;
  name: string;
}

export interface AccessInput {
  all: boolean;
  /** Connection id → every tool of that connection (now and later). */
  connectors: Record<string, boolean>;
  scopes: ScopeGrant[];
  tools: { allow: ToolRef[]; deny: ToolRef[] };
}

export interface AccessTool {
  name: string;
  /** Human name (English); the app translates built-ins by tool name. */
  label: string;
  description: string;
  connectionId: string | null;
  scope: string;
  sensitive: boolean;
  /** Only reads (built-in `:read` scopes, MCP `readOnlyHint` or classified as read, catalog read scopes). */
  readOnly: boolean;
  state: AccessState;
}

/**
 * Labels and descriptions of the built-in tools (English). The app translates
 * them by tool name (`tools.{name}.label` / `.description`), with these as defaults.
 */
export const BUILTIN_TOOL_INFO: Record<string, { label: string; description: string }> = {
  ask_user: { label: "Ask the person", description: "Asks a short question and waits for the answer." },
  react: { label: "React", description: "Reacts with an emoji instead of replying to a simple thanks or ok." },
  search_context: { label: "Search context", description: "Searches messages, summaries, facts and lessons." },
  get_summary: { label: "Read summary", description: "Reads the summary of a thread or period." },
  expand: { label: "Open item", description: "Opens a memory or message in full." },
  remember: { label: "Remember", description: "Saves a note when someone asks." },
  update_memory: { label: "Update memory", description: "Corrects a saved note." },
  forget: { label: "Forget", description: "Archives a note when someone asks." },
  propose_instruction_change: {
    label: "Propose an instruction change",
    description: "Suggests changing its own instructions or the org context; a person decides.",
  },
  read_artifact: { label: "Read file", description: "Reads a Drive file." },
  list_artifacts: { label: "List files", description: "Lists the Drive files it can see." },
  share_artifact: {
    label: "Share file",
    description:
      "Brings into the conversation a file it made in another one (such as a DM), if the person asking has access.",
  },
  create_artifact: { label: "Create file", description: "Creates a document, table, diff, diagram or page." },
  update_artifact: { label: "Update file", description: "Saves a new version of a file." },
  list_issues: { label: "View issues", description: "Lists and opens issues." },
  create_issue: { label: "Create issue", description: "Creates an issue with acceptance criteria." },
  update_issue: { label: "Update issue", description: "Changes status or priority, or links a PR." },
  comment_issue: { label: "Comment on issue", description: "Comments on progress in an issue." },
  list_events: { label: "View calendar", description: "Lists events." },
  find_free_time: { label: "Find free time", description: "Looks for free slots in common." },
  propose_event: { label: "Propose event", description: "Suggests an event; the person asking confirms." },
  load_skill: { label: "Load skill", description: "Loads a skill's instructions." },
  read_skill_file: { label: "Read skill file", description: "Reads a reference file of a skill." },
  schedule_reminder: {
    label: "Create reminder",
    description: "Schedules a reminder in this conversation, for the person asking.",
  },
  create_routine: {
    label: "Create routine",
    description: "Creates a recurring routine in this conversation or in a channel.",
  },
  list_routines: {
    label: "View routines",
    description: "Lists the agent's routines, or another agent's to check them (read only).",
  },
  update_routine: { label: "Change routine", description: "Changes a routine's instructions, schedule or channel." },
  list_reminders: { label: "View reminders", description: "Lists the pending reminders of the person asking." },
  cancel_reminder: { label: "Cancel reminder", description: "Cancels a reminder of the person asking." },
  suggest_forum_topic: {
    label: "Suggest forum topic",
    description: "Suggests a discussion among agents; a person opens it.",
  },
  open_forum_topic: {
    label: "Open forum topic",
    description: "Takes a subject to a discussion among agents when a person asks.",
  },
  post_in_forum: { label: "Post in forum", description: "Posts in a topic outside its own turn." },
  read_forum_topic: { label: "Read forum topic", description: "Reads a topic's goal and replies." },
  search_wiki: { label: "Search wiki", description: "Searches the organization's wiki pages." },
  read_wiki_page: { label: "Read wiki page", description: "Reads a whole wiki page." },
  create_wiki_page: { label: "Create wiki page", description: "Creates a page when someone asks." },
  update_wiki_page: {
    label: "Edit wiki page",
    description: "Adds or rewrites a section when someone asks.",
  },
  link_to_wiki: { label: "Link wiki pages", description: "Links a page to others when someone asks." },
  run_code: { label: "Run code", description: "Runs Python, Node or bash in the conversation's isolated environment." },
  write_file: { label: "Write to environment", description: "Writes a file in the code environment." },
  read_file: { label: "Read from environment", description: "Reads a file from the code environment." },
  list_files: { label: "List environment", description: "Lists the files in the code environment." },
  export_file: { label: "Save to Drive", description: "Takes a file from the environment to the Drive." },
  upload_file: {
    label: "Upload to Drive",
    description: "Uploads a file or folder from the computer to the Drive as is (PDF, images, zip…).",
  },
  import_file: { label: "Bring from Drive", description: "Copies a Drive file into the environment." },
  run_skill_script: { label: "Run skill script", description: "Runs a skill's script in the environment." },
  computer_start: {
    label: "Turn on the computer",
    description: "Turns on the agent's computer (creates it the first time).",
  },
  computer_stop: { label: "Turn off the computer", description: "Turns off the computer; the files stay." },
  computer_status: {
    label: "Check the computer",
    description: "Says whether it is on, the disk used and this month's cost.",
  },
  ...BROWSER_TOOL_INFO,
  ...DESKTOP_TOOL_INFO,
};

const humanize = (name: string) => {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type CatalogTool = { name: string; label: string; description: string; sensitive: boolean; readOnly: boolean };

export interface AccessScope {
  scope: string;
  label: string;
  state: AccessState;
  tools: AccessTool[];
}

export interface AccessTree {
  all: boolean;
  builtins: AccessScope[];
  connectors: {
    connectionId: string;
    connector: string;
    label: string;
    custom: boolean;
    state: AccessState;
    scopes: AccessScope[];
  }[];
}

/** Every tool the org offers, from the catalogs (no network): built-ins, catalog connectors, classified custom tools. */
export async function orgToolCatalog(db: Database, orgId: string) {
  const connections = await db
    .select()
    .from(connectorConnections)
    .where(and(eq(connectorConnections.orgId, orgId), isNull(connectorConnections.revokedAt)))
    .orderBy(asc(connectorConnections.createdAt));
  const out: {
    connectionId: string;
    connector: string;
    label: string;
    custom: boolean;
    scopes: { scope: string; label: string; tools: CatalogTool[] }[];
  }[] = [];
  for (const c of connections) {
    if (isCustom(c)) {
      const tools = await classifiedTools(db, c.id);
      const prefix =
        c.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, 24) || "mcp";
      const byScope = new Map<string, CatalogTool[]>();
      for (const t of tools) {
        const scope = customScope(c.id, t.access as ToolAccess);
        const list = byScope.get(scope) ?? [];
        list.push({
          name: exposedToolName(prefix, t.name),
          label: t.label || humanize(t.name),
          description: t.description,
          sensitive: t.access === "approval",
          readOnly: t.access === "read" || t.readOnlyHint === true,
        });
        byScope.set(scope, list);
      }
      out.push({
        connectionId: c.id,
        connector: "custom",
        label: c.label,
        custom: true,
        scopes: [...byScope].map(([scope, list]) => ({
          scope,
          label: scope.endsWith(":read") ? "Read" : "Write",
          tools: list,
        })),
      });
      continue;
    }
    const def = CONNECTOR_CATALOG[c.connector];
    if (!def) continue;
    out.push({
      connectionId: c.id,
      connector: def.id,
      label: c.label,
      custom: false,
      scopes: Object.entries(def.scopes).map(([id, s]) => ({
        scope: `${def.id}:${id}`,
        label: s.label,
        tools: Object.entries(def.tools)
          .filter(([, t]) => t.scope === id)
          .map(([name, t]) => {
            const exposed = exposedToolName(def.id, name);
            return {
              name: exposed,
              label: humanize(name),
              description: s.description,
              sensitive: t.sensitive === true || ALWAYS_SENSITIVE.test(exposed),
              readOnly: id.endsWith(".read"),
            };
          }),
      })),
    });
  }
  return out;
}

async function grantsOf(db: Database, orgId: string, agentId: string) {
  const rows = await db
    .select({ connectionId: agentScopes.connectionId, scope: agentScopes.scope })
    .from(agentScopes)
    .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId)));
  return new Set(rows.map((r) => grantKey(r.connectionId, r.scope)));
}

function scopeState(granted: Set<string>, connectionId: string | null, scope: string): AccessState {
  if (granted.has(grantKey(connectionId, scope))) return "granted";
  const writeScope = impliedByWrite(scope);
  if (!connectionId && writeScope && granted.has(grantKey(null, writeScope))) return "inherited";
  if (connectionId && granted.has(grantKey(connectionId, CONNECTOR_ALL))) return "inherited";
  if (granted.has(grantKey(null, ALL_TOOLS))) return "inherited";
  return "off";
}

function builtinInfo(name: string, scope: string): Omit<AccessTool, "state"> {
  const info = BUILTIN_TOOL_INFO[name];
  return {
    name,
    label: info?.label ?? humanize(name),
    description: info?.description ?? "",
    connectionId: null,
    scope,
    sensitive: false,
    readOnly: scope.endsWith(":read"),
  };
}

function treeFor(granted: Set<string>, catalog: Awaited<ReturnType<typeof orgToolCatalog>>): AccessTree {
  const builtins: AccessScope[] = Object.entries(BUILTIN_TOOLS).map(([scope, names]) => ({
    scope,
    label: scope === "" ? "Ask the person" : (BUILTIN_SCOPES[scope]?.label ?? scope),
    state: scope === "" ? "inherited" : scopeState(granted, null, scope),
    tools: names.map((name) => ({
      ...builtinInfo(name, scope),
      state: toolAccess(granted, { name, scope, connectionId: null }),
    })),
  }));
  return {
    all: granted.has(grantKey(null, ALL_TOOLS)),
    builtins,
    connectors: catalog.map((c) => ({
      connectionId: c.connectionId,
      connector: c.connector,
      label: c.label,
      custom: c.custom,
      state: granted.has(grantKey(c.connectionId, CONNECTOR_ALL))
        ? "granted"
        : granted.has(grantKey(null, ALL_TOOLS))
          ? "inherited"
          : "off",
      scopes: c.scopes.map((s) => ({
        scope: s.scope,
        label: s.label,
        state: scopeState(granted, c.connectionId, s.scope),
        tools: s.tools.map((t) => ({
          ...t,
          connectionId: c.connectionId,
          scope: s.scope,
          state: toolAccess(granted, { name: t.name, scope: s.scope, connectionId: c.connectionId }),
        })),
      })),
    })),
  };
}

/** `GET …/agents/{id}/access`: the effective access as a tree. */
export async function getAgentAccess(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  return treeFor(await grantsOf(db, orgId, agentId), await orgToolCatalog(db, orgId));
}

/**
 * `PUT …/agents/{id}/access` (admins or the agent's owner): replaces the
 * agent's grants. Approvals never change: sensitive tools still ask a person.
 */
export async function setAgentAccess(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  input: AccessInput,
): Promise<AccessTree> {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership.role, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can change its access");
  }
  const active = new Set(
    (
      await db
        .select({ id: connectorConnections.id })
        .from(connectorConnections)
        .where(and(eq(connectorConnections.orgId, orgId), isNull(connectorConnections.revokedAt)))
    ).map((r) => r.id),
  );
  const rows: ScopeGrant[] = [];
  if (input.all) rows.push({ connectionId: null, scope: ALL_TOOLS });
  for (const [connectionId, on] of Object.entries(input.connectors ?? {})) {
    if (!on) continue;
    if (!active.has(connectionId)) throw new ValidationError(`${connectionId} is not an active connection`);
    rows.push({ connectionId, scope: CONNECTOR_ALL });
  }
  for (const grant of input.scopes ?? []) {
    if (grant.connectionId) {
      const problem = await connectorGrantValidator(db, orgId, grant);
      if (problem) throw new ValidationError(problem);
    } else if (!BUILTIN_SCOPES[grant.scope]) {
      throw new ValidationError(`Unknown scope ${grant.scope}`);
    }
    rows.push(grant);
  }
  const toolRow = (ref: ToolRef, deny: boolean) => {
    const name = ref.name.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new ValidationError(`Invalid tool name ${ref.name}`);
    if (ref.connectionId && !active.has(ref.connectionId)) {
      throw new ValidationError(`${ref.connectionId} is not an active connection`);
    }
    return { connectionId: ref.connectionId ?? null, scope: deny ? toolDenyScope(name) : toolAllowScope(name) };
  };
  for (const ref of input.tools?.allow ?? []) rows.push(toolRow(ref, false));
  for (const ref of input.tools?.deny ?? []) rows.push(toolRow(ref, true));
  const unique = new Map(rows.map((r) => [grantKey(r.connectionId, r.scope), r]));
  await db.transaction(async (tx) => {
    // Mailbox grants are managed by the mail API (ADR 0038): kept as they are.
    await tx
      .delete(agentScopes)
      .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId), notMailGrant(orgId)));
    if (unique.size > 0) {
      await tx.insert(agentScopes).values(
        [...unique.values()].map((g) => ({
          orgId,
          agentId,
          connectionId: g.connectionId,
          scope: g.scope,
          grantedByUserId: actorId,
        })),
      );
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.access_changed",
      target: { type: "agent", id: agentId },
      details: {
        all: input.all,
        connectors: Object.keys(input.connectors ?? {}).filter((k) => input.connectors[k]),
        scopes: (input.scopes ?? []).map((s) => s.scope),
        allow: (input.tools?.allow ?? []).map((t) => t.name),
        deny: (input.tools?.deny ?? []).map((t) => t.name),
      },
    });
  });
  caches.scopes.deletePrefix(`${orgId}:${agentId}`);
  return treeFor(await grantsOf(db, orgId, agentId), await orgToolCatalog(db, orgId));
}

/** `GET …/access-matrix` (admins): agents × tools with the effective state. */
export async function accessMatrix(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const catalog = await orgToolCatalog(db, orgId);
  const tools: (Omit<AccessTool, "state"> & { group: string; key: string })[] = [
    ...Object.entries(BUILTIN_TOOLS).flatMap(([scope, names]) =>
      names.map((name) => ({ ...builtinInfo(name, scope), group: "agentes", key: `builtin|${name}` })),
    ),
    ...catalog.flatMap((c) =>
      c.scopes.flatMap((s) =>
        s.tools.map((t) => ({
          ...t,
          connectionId: c.connectionId,
          scope: s.scope,
          group: c.label,
          key: `${c.connectionId}|${t.name}`,
        })),
      ),
    ),
  ];
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt));
  const grants = agentRows.length
    ? await db
        .select({ agentId: agentScopes.agentId, connectionId: agentScopes.connectionId, scope: agentScopes.scope })
        .from(agentScopes)
        .where(
          inArray(
            agentScopes.agentId,
            agentRows.map((a) => a.id),
          ),
        )
    : [];
  const cells: Record<string, Record<string, AccessState>> = {};
  for (const a of agentRows) {
    const granted = new Set(grants.filter((g) => g.agentId === a.id).map((g) => grantKey(g.connectionId, g.scope)));
    cells[a.id] = Object.fromEntries(tools.map((t) => [t.key, toolAccess(granted, t)]));
  }
  return { agents: agentRows, tools, cells };
}

export interface PendingConnector {
  label: string;
  reason: string;
}

/**
 * Connectors the org has that this agent can't use yet, and why: tools not
 * classified yet (custom MCP), or no permission. The prompt lists them so the
 * agent says what's missing and who can fix it, instead of "I don't have it".
 */
export async function pendingConnectors(
  db: Database,
  orgId: string,
  offeredToolNames: Set<string>,
): Promise<PendingConnector[]> {
  const [any] = await db
    .select({ id: connectorConnections.id })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.orgId, orgId), isNull(connectorConnections.revokedAt)))
    .limit(1);
  if (!any) return [];
  const out: PendingConnector[] = [];
  for (const c of await orgToolCatalog(db, orgId)) {
    const tools = c.scopes.flatMap((s) => s.tools);
    if (tools.length === 0) {
      out.push({
        label: c.label,
        reason: c.custom ? "connected, waiting for an admin to classify the tools" : "connected, no tools available",
      });
    } else if (!tools.some((t) => offeredToolNames.has(t.name))) {
      out.push({
        label: c.label,
        reason:
          "connected, but the tools were not enabled for you; ask an admin to enable them in Agents and access or on the agent's page",
      });
    }
  }
  return out;
}
