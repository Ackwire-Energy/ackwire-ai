import type { JsonSchema } from "./json-schema";
import type { ToolDefinition } from "./types";

/**
 * Big connectors as a directory (D58): a connector with more tools than the
 * model can take in at once (TikTok Ads: 382) is listed as two tools of ours,
 * `<prefix>_find_tools` (a local search over its tools, no model call) and
 * `<prefix>_use_tool` (runs one of them by its real name). Same for every
 * brain: the API's tool loop, Claude Code and Codex through the MCP bridge.
 *
 * `use_tool` is only a way in: the gateway runs the real tool through the
 * same path as a direct call (scope, schema validation, call checks,
 * approval, run steps), so permissions and approval cards never see the
 * directory.
 */

/** A connector with more tools than this is listed as a directory. */
export const DIRECTORY_MAX_TOOLS = 40;
/** …or with more than this in descriptions and schemas. */
export const DIRECTORY_MAX_CHARS = 100_000;
/** Matches `find_tools` returns by default, and at most. */
export const FIND_DEFAULT = 8;
export const FIND_MAX = 20;
/** A match's input schema in the result, at most (characters). */
const SCHEMA_CHARS = 1_500;

/** The directory a listed tool stands for (only on the two directory tools). */
export interface DirectoryRole {
  kind: "find" | "use";
  /** The connector's real tools (already filtered by the agent's grants). */
  tools: ToolDefinition[];
  prefix: string;
  label: string;
}

const roles = new WeakMap<ToolDefinition, DirectoryRole>();

/** The directory behind a listed tool, if it is `find_tools` or `use_tool`. */
export const directoryRole = (tool: ToolDefinition | undefined) => (tool ? roles.get(tool) : undefined);

const sizeOf = (t: ToolDefinition) => t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;

/** The part of the tools' names they all start with (`tiktok_ad_create`, `tiktok_report_get` → `tiktok`). */
function prefixOf(tools: ToolDefinition[], label: string) {
  const first = tools[0]?.name.split("_")[0] ?? "";
  if (first && tools.every((t) => t.name.startsWith(`${first}_`))) return first;
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24);
  return slug || "connector";
}

/** The real tool's name as the model may write it: full, or without the connector's prefix. */
export function resolveDirectoryTool(role: DirectoryRole, name: string) {
  const n = name.trim();
  return (
    role.tools.find((t) => t.name === n) ??
    (role.prefix ? role.tools.find((t) => t.name === `${role.prefix}_${n}`) : undefined)
  );
}

/** The most common topics in the connector's tool names (`ad`, `campaign`, `report`…), for the search's description. */
function areasOf(tools: ToolDefinition[], prefix: string) {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const word = t.name.slice(prefix.length + 1).split("_")[0];
    if (word && word.length > 1) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([w]) => w);
}

type IsSensitive = (tool: ToolDefinition) => boolean;

function directoryTools(
  prefix: string,
  label: string,
  tools: ToolDefinition[],
  connectionId: string,
  sensitive: IsSensitive,
) {
  const areas = areasOf(tools, prefix);
  const find: ToolDefinition = {
    name: `${prefix}_find_tools`,
    description: `Find ${label} tools (${tools.length} in all${areas.length ? `, about: ${areas.join(", ")}` : ""}) by what you need to do. Returns the best matches with their exact names, what each needs (input) and whether it asks a person's approval. Then call one with \`${prefix}_use_tool\`.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you need, in a few words (e.g. 'create an ad', 'campaign report').",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: FIND_MAX,
          description: `How many matches (default ${FIND_DEFAULT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    scope: "",
    connectionId,
    connectorLabel: label,
    execute: async (input) => ({ content: findTools(tools, prefix, label, input, sensitive) }),
  };
  const use: ToolDefinition = {
    name: `${prefix}_use_tool`,
    description: `Run one ${label} tool by the exact name \`${prefix}_find_tools\` gave you, with its input in \`arguments\`. Approvals and permissions are the tool's own.`,
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: `The tool's name, e.g. ${tools[0]?.name ?? `${prefix}_…`}.` },
        arguments: { type: "object", description: "The tool's input, as its schema says." },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    scope: "",
    connectionId,
    connectorLabel: label,
    // Never runs itself: the gateway runs the real tool (`directoryRole`).
    execute: async () => ({ content: "Unknown tool", isError: true }),
  };
  roles.set(find, { kind: "find", tools, prefix, label });
  roles.set(use, { kind: "use", tools, prefix, label });
  return [find, use];
}

/**
 * The tools as the model sees them: every built-in tool and small connector
 * as is, each big connector (`DIRECTORY_MAX_TOOLS` / `DIRECTORY_MAX_CHARS`)
 * as its two directory tools. Order is kept (a big connector's pair sits where
 * its first tool was).
 *
 * Tools on demand (`loaded`, a run's tool groups, D65): only the core groups
 * and the loaded ones go as they are; the rest sit behind one directory of
 * their own, `find_tools` / `use_tool`, at the end of the list. Without
 * `loaded` every tool goes.
 */
export function presentTools(
  tools: ToolDefinition[],
  sensitive: IsSensitive = (t) => t.sensitive === true,
  loaded?: readonly string[] | null,
): ToolDefinition[] {
  if (loaded) {
    const keep = new Set(loaded);
    const now = new Set(tools.filter((t) => isCore(t) || keep.has(toolGroupKey(t))));
    const later = tools.filter((t) => !now.has(t));
    const shown = presentTools([...now], sensitive);
    if (later.length === 0) return shown;
    const taken = new Set(shown.map((t) => t.name));
    if (taken.has(ON_DEMAND_FIND) || taken.has(ON_DEMAND_USE)) return [...shown, ...later];
    return [...shown, ...onDemandTools(later, sensitive)];
  }
  const byConnection = new Map<string, ToolDefinition[]>();
  for (const t of tools) {
    if (!t.connectionId) continue;
    const group = byConnection.get(t.connectionId) ?? [];
    group.push(t);
    byConnection.set(t.connectionId, group);
  }
  const big = new Map<string, ToolDefinition[]>();
  const taken = new Set(tools.map((t) => t.name));
  for (const [id, group] of byConnection) {
    const chars = group.reduce((n, t) => n + sizeOf(t), 0);
    if (group.length <= DIRECTORY_MAX_TOOLS && chars <= DIRECTORY_MAX_CHARS) continue;
    const label = group[0]?.connectorLabel ?? "Connector";
    let prefix = prefixOf(group, label);
    // A name a real tool already has can't be taken by the directory.
    if (taken.has(`${prefix}_find_tools`) || taken.has(`${prefix}_use_tool`)) prefix = `${prefix}_dir`;
    big.set(id, directoryTools(prefix, label, group, id, sensitive));
  }
  if (big.size === 0) return tools;
  const out: ToolDefinition[] = [];
  const placed = new Set<string>();
  for (const t of tools) {
    const pair = t.connectionId ? big.get(t.connectionId) : undefined;
    if (!pair) out.push(t);
    else if (t.connectionId && !placed.has(t.connectionId)) {
      placed.add(t.connectionId);
      out.push(...pair);
    }
  }
  return out;
}

// ── Tools on demand (D65) ────────────────────────────────────────────────────

/** A tool's group: its scope's prefix (`drive:write` → `drive`), each custom connector on its own; "" = conversation. */
export function toolGroupKey(tool: Pick<ToolDefinition, "scope" | "connectionId">) {
  const prefix = tool.scope.split(":")[0] ?? "";
  return prefix.startsWith("custom") ? `custom:${tool.connectionId ?? prefix}` : prefix;
}

/**
 * Groups every run gets as they are: the conversation, memory and skills
 * (the prompt points at them), and reading the wiki (its index is in the
 * prompt). Everything else is loaded when the run needs it.
 */
export const CORE_GROUPS: ReadonlySet<string> = new Set(["", "context", "memory", "skills"]);
const CORE_TOOLS: ReadonlySet<string> = new Set(["read_wiki_page", "search_wiki"]);

export const isCore = (tool: Pick<ToolDefinition, "name" | "scope" | "connectionId">) =>
  CORE_GROUPS.has(toolGroupKey(tool)) || CORE_TOOLS.has(tool.name);

/** How a group is named for the model and the judge ("Browser", "GitHub", a connector's label). */
const GROUP_LABELS: Record<string, string> = {
  drive: "Files (Drive)",
  issues: "Issues",
  calendar: "Calendar",
  schedule: "Schedule, reminders and routines",
  forum: "Forum",
  wiki: "Organization wiki (writing)",
  sandbox: "Computer and code",
  browser: "Browser",
  github: "GitHub",
  sentry: "Sentry",
  linear: "Linear",
  gdrive: "Google Drive",
};

export interface ToolGroup {
  key: string;
  label: string;
  tools: ToolDefinition[];
}

/** The groups a run could load (core groups left out), in the order of their first tool. */
export function deferrableGroups(tools: ToolDefinition[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const t of tools) {
    if (isCore(t)) continue;
    const key = toolGroupKey(t);
    const group = groups.get(key) ?? {
      key,
      label: GROUP_LABELS[key] ?? t.connectorLabel ?? key.charAt(0).toUpperCase() + key.slice(1),
      tools: [],
    };
    group.tools.push(t);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export const ON_DEMAND_FIND = "find_tools";
export const ON_DEMAND_USE = "use_tool";

/**
 * The directory of a run's tools not loaded yet: `find_tools` searches them
 * (BM25, no model call) and `use_tool` runs one by its name, through the
 * gateway like any direct call. Its description names every group, so the
 * model knows what it can reach.
 */
function onDemandTools(tools: ToolDefinition[], sensitive: IsSensitive): ToolDefinition[] {
  const groups = deferrableGroups(tools);
  const areas = groups.map((g) => `${g.label} (${g.tools.length})`);
  const label = "other";
  const find: ToolDefinition = {
    name: ON_DEMAND_FIND,
    description: `More tools you have, loaded when you need them: ${areas.join(", ")}. Find them by what you need to do; returns the best matches with their exact names, what each needs (input) and whether it asks a person's approval. Then call one with \`${ON_DEMAND_USE}\`. Search before saying you can't do something.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you need, in a few words (e.g. 'open a web page', 'create an issue', 'sentry errors').",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: FIND_MAX,
          description: `How many matches (default ${FIND_DEFAULT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    scope: "",
    execute: async (input) => ({
      content: findTools(
        tools,
        "",
        label,
        input,
        sensitive,
        groups.map((g) => g.label),
        ON_DEMAND_USE,
      ),
    }),
  };
  const use: ToolDefinition = {
    name: ON_DEMAND_USE,
    description: `Run one of your tools by the exact name \`${ON_DEMAND_FIND}\` gave you, with its input in \`arguments\`. Approvals and permissions are the tool's own.`,
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "The tool's exact name." },
        arguments: { type: "object", description: "The tool's input, as its schema says." },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    scope: "",
    // Never runs itself: the gateway runs the real tool (`directoryRole`).
    execute: async () => ({ content: "Unknown tool", isError: true }),
  };
  roles.set(find, { kind: "find", tools, prefix: "", label });
  roles.set(use, { kind: "use", tools, prefix: "", label });
  return [find, use];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/** A singular-ish stem, so "ads" finds "ad" and "campaigns" finds "campaign". */
const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** What the search reads in a tool: its name (twice: it matters most), description and input's names and descriptions. */
function docOf(t: ToolDefinition, prefix: string) {
  const name = t.name.startsWith(`${prefix}_`) ? t.name.slice(prefix.length + 1) : t.name;
  const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  const input = Object.entries(props)
    .map(([k, v]) => `${k} ${v?.description ?? ""}`)
    .join(" ");
  return [...words(name), ...words(name), ...words(t.description), ...words(input)].map(stem);
}

/** BM25 ranking of the connector's tools for a query (best first, only tools that match). */
export function rankTools(tools: ToolDefinition[], prefix: string, query: string): ToolDefinition[] {
  const terms = [...new Set(words(query).map(stem))];
  if (terms.length === 0) return [];
  const docs = tools.map((t) => docOf(t, prefix));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const term of terms) {
      const tf = d.filter((w) => w === term).length;
      if (tf === 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
    }
    return { tool: tools[i] as ToolDefinition, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map((s) => s.tool);
}

/** A tool's input schema, short enough for a search result. */
export function compactSchema(schema: JsonSchema) {
  const text = JSON.stringify(schema);
  return text.length > SCHEMA_CHARS ? `${text.slice(0, SCHEMA_CHARS)}…` : text;
}

function findTools(
  tools: ToolDefinition[],
  prefix: string,
  label: string,
  input: Record<string, unknown>,
  sensitive: IsSensitive,
  areas: string[] = areasOf(tools, prefix),
  useName = `${prefix}_use_tool`,
) {
  const query = typeof input.query === "string" ? input.query : "";
  const limit = Math.min(Math.max(Number(input.limit) || FIND_DEFAULT, 1), FIND_MAX);
  const matches = rankTools(tools, prefix, query).slice(0, limit);
  if (matches.length === 0) {
    return `No ${label} tool matches "${query}". Try other words (${areas.slice(0, 12).join(", ")}).`;
  }
  const lines = matches.map(
    (t) =>
      `- ${t.name}${sensitive(t) ? " (asks a person's approval)" : ""}: ${t.description.slice(0, 300)}\n  input: ${compactSchema(t.inputSchema)}`,
  );
  return `${label} tools for "${query}" (call one with ${useName}):\n${lines.join("\n")}`;
}
