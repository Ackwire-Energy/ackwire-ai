import type { AccessInput, AccessMatrix, AccessState, AgentAccess, ToolRef } from "@/api/types";

/**
 * The tool tree the UI edits, built from `GET …/agents/{id}/access` (or, for
 * an agent that doesn't exist yet, from the access matrix). Two levels:
 * groups (a built-in scope, or a connector) and their tools.
 *
 * Editing model: "all tools" plus explicit grants and denials by node id.
 * A denial wins, then an explicit grant, then inheritance (from "all tools"
 * or a granted group), else off. Same order as the backend's Tool Gateway.
 */
export interface AccessNode {
  /** `scope:|{scope}` (built-in), `connector:{connectionId}`, `tool:{connectionId|builtin}|{name}`. */
  id: string;
  kind: "group" | "connector" | "tool";
  label: string;
  description: string | null;
  state: AccessState;
  sensitive: boolean;
  /** Only reads (the "Só leitura" preset). */
  readOnly: boolean;
  /** Always on (the built-in "Perguntar"): not editable. */
  locked: boolean;
  /** What the backend calls it. */
  ref:
    | { kind: "scope"; connectionId: null; scope: string }
    | { kind: "connector"; connectionId: string }
    | { kind: "tool"; connectionId: string | null; name: string };
  children: AccessNode[];
}

export interface AccessModel {
  allTools: boolean;
  grants: Set<string>;
  denies: Set<string>;
}

export type Preset = "readonly" | "standard" | "all";

export const isOn = (s: AccessState) => s === "granted" || s === "inherited";

/** "github_merge_pull_request" → "github merge pull request" (the backend has no tool labels yet). */
export const toolLabel = (name: string) => name.replace(/[_-]+/g, " ").trim();
const READ = /(^|_)(list|get|read|search|find|fetch|query|view|show|describe)(_|$)/i;
export const looksReadOnly = (name: string, scope: string) => READ.test(name) || /(^|[:._])read$/i.test(scope);

const toolId = (connectionId: string | null, name: string) => `tool:${connectionId ?? "builtin"}|${name}`;

function toolNode(
  t: { name: string; connectionId: string | null; scope: string; sensitive: boolean; state?: AccessState },
  description: string | null,
): AccessNode {
  return {
    id: toolId(t.connectionId, t.name),
    kind: "tool",
    label: toolLabel(t.name),
    description,
    state: t.state ?? "off",
    sensitive: t.sensitive,
    readOnly: looksReadOnly(t.name, t.scope),
    locked: false,
    ref: { kind: "tool", connectionId: t.connectionId, name: t.name },
    children: [],
  };
}

export function treeFromAccess(access: AgentAccess): AccessNode[] {
  const builtins: AccessNode[] = access.builtins.map((s) => ({
    id: `scope:|${s.scope}`,
    kind: "group",
    label: s.label,
    description: null,
    state: s.state,
    sensitive: false,
    readOnly: false,
    locked: s.scope === "",
    ref: { kind: "scope", connectionId: null, scope: s.scope },
    children: s.tools.map((t) => toolNode(t, null)),
  }));
  const connectors: AccessNode[] = access.connectors.map((c) => ({
    id: `connector:${c.connectionId}`,
    kind: "connector",
    label: c.label,
    description: null,
    state: c.state,
    sensitive: false,
    readOnly: false,
    locked: false,
    ref: { kind: "connector", connectionId: c.connectionId },
    children: c.scopes.flatMap((s) => s.tools.map((t) => toolNode(t, s.label))),
  }));
  return [...builtins, ...connectors];
}

/**
 * For "Criar agente" (no agent yet): the tree from the matrix tools. Built-in
 * tools are grouped by scope, labelled with `scopeLabel`; connectors by connection.
 */
export function treeFromMatrix(matrix: AccessMatrix, scopeLabel: (scope: string) => string): AccessNode[] {
  const groups = new Map<string, AccessNode>();
  for (const t of matrix.tools) {
    const builtin = t.connectionId === null;
    const id = builtin ? `scope:|${t.scope}` : `connector:${t.connectionId}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        id,
        kind: builtin ? "group" : "connector",
        label: builtin ? scopeLabel(t.scope) : t.group,
        description: null,
        state: builtin && t.scope === "" ? "inherited" : "off",
        sensitive: false,
        readOnly: false,
        locked: builtin && t.scope === "",
        ref: builtin
          ? { kind: "scope", connectionId: null, scope: t.scope }
          : { kind: "connector", connectionId: t.connectionId as string },
        children: [],
      };
      groups.set(id, g);
    }
    g.children.push(toolNode(t, builtin ? null : scopeLabel(t.scope)));
  }
  return [...groups.values()];
}

/** Explicit grants and denials as the server reports them. A connector scope granted becomes its tools. */
export function modelFrom(access: AgentAccess): AccessModel {
  const grants = new Set<string>();
  const denies = new Set<string>();
  const tools = (list: { connectionId: string | null; name: string; state: AccessState }[]) => {
    for (const t of list) {
      if (t.state === "granted") grants.add(toolId(t.connectionId, t.name));
      if (t.state === "denied") denies.add(toolId(t.connectionId, t.name));
    }
  };
  for (const s of access.builtins) {
    if (s.state === "granted" && s.scope !== "") grants.add(`scope:|${s.scope}`);
    tools(s.tools);
  }
  for (const c of access.connectors) {
    if (c.state === "granted") grants.add(`connector:${c.connectionId}`);
    for (const s of c.scopes) {
      if (s.state === "granted") for (const t of s.tools) grants.add(toolId(t.connectionId, t.name));
      tools(s.tools);
    }
  }
  return { allTools: access.all, grants, denies };
}

/** The `PUT …/access` body. A denied group becomes denials of its tools (the backend denies per tool). */
export function toInput(model: AccessModel, tree: AccessNode[]): AccessInput {
  const input: AccessInput = { all: model.allTools, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
  const allow = new Map<string, ToolRef>();
  const deny = new Map<string, ToolRef>();
  for (const g of tree) {
    if (g.ref.kind === "connector") input.connectors[g.ref.connectionId] = model.grants.has(g.id);
    if (g.ref.kind === "scope" && !g.locked && model.grants.has(g.id)) {
      input.scopes.push({ connectionId: null, scope: g.ref.scope });
    }
    const groupDenied = model.denies.has(g.id);
    for (const t of g.children) {
      if (t.ref.kind !== "tool") continue;
      const ref = { connectionId: t.ref.connectionId, name: t.ref.name };
      if (groupDenied || model.denies.has(t.id)) deny.set(t.id, ref);
      else if (model.grants.has(t.id)) allow.set(t.id, ref);
    }
  }
  input.tools.allow = [...allow.values()];
  input.tools.deny = [...deny.values()];
  return input;
}

export function stateOf(node: AccessNode, model: AccessModel, covered: boolean): AccessState {
  if (node.locked) return "inherited";
  if (model.denies.has(node.id)) return "denied";
  if (model.grants.has(node.id)) return "granted";
  if (covered) return "inherited";
  return "off";
}

export interface ResolvedNode extends Omit<AccessNode, "children" | "state"> {
  state: AccessState;
  /** Groups: tri-state from their tools. Tools: on or off. */
  checked: boolean | "indeterminate";
  children: ResolvedNode[];
}

export function resolve(tree: AccessNode[], model: AccessModel): ResolvedNode[] {
  const go = (n: AccessNode, covered: boolean): ResolvedNode => {
    const state = stateOf(n, model, covered);
    const children = n.children.map((c) => go(c, isOn(state)));
    let checked: boolean | "indeterminate" = isOn(state);
    if (children.length) {
      const on = children.filter((c) => c.checked === true).length;
      checked = on === children.length ? true : on > 0 ? "indeterminate" : false;
    }
    return { ...n, state, checked, children };
  };
  return tree.map((n) => go(n, model.allTools));
}

const tools = (nodes: ResolvedNode[]): ResolvedNode[] =>
  nodes.flatMap((n) => (n.kind === "tool" ? [n] : tools(n.children)));

/** "23 de 41 ferramentas". */
export function countTools(resolved: ResolvedNode[]) {
  const all = tools(resolved);
  return { on: all.filter((t) => isOn(t.state)).length, total: all.length };
}

const without = (set: Set<string>, ids: string[]) => {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
};
const below = (n: AccessNode): string[] => n.children.flatMap((c) => [c.id, ...below(c)]);

/** Check or uncheck a node (a tool, or "Todas deste conector" / a group). `covered`: a parent grants it. */
export function toggle(model: AccessModel, node: AccessNode, on: boolean, covered: boolean): AccessModel {
  if (node.locked) return model;
  const ids = below(node);
  if (on) {
    const grants = without(model.grants, ids);
    if (!covered) grants.add(node.id);
    else grants.delete(node.id);
    return { ...model, grants, denies: without(model.denies, [node.id, ...ids]) };
  }
  const grants = without(model.grants, [node.id, ...ids]);
  const denies = without(model.denies, ids);
  // Still covered by a parent or "all tools": turning it off is a denial.
  if (covered) denies.add(node.id);
  else denies.delete(node.id);
  return { ...model, grants, denies };
}

/** "bloquear" / "desbloquear" one tool. */
export function setDenied(model: AccessModel, id: string, denied: boolean): AccessModel {
  const denies = new Set(model.denies);
  const grants = new Set(model.grants);
  if (denied) {
    denies.add(id);
    grants.delete(id);
  } else denies.delete(id);
  return { ...model, grants, denies };
}

export const setAllTools = (model: AccessModel, on: boolean): AccessModel => ({ ...model, allTools: on });

/** Presets of "Criar agente → Ferramentas". */
export function presetModel(tree: AccessNode[], preset: Preset): AccessModel {
  if (preset === "all") return { allTools: true, grants: new Set(), denies: new Set() };
  const grants = new Set<string>();
  for (const g of tree) {
    for (const t of g.children) {
      if (preset === "readonly" ? t.readOnly : !t.sensitive) grants.add(t.id);
    }
  }
  return { allTools: false, grants, denies: new Set() };
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Search across tools (label, name, description); a group stays when it or a tool matches. */
export function filterTree(nodes: ResolvedNode[], query: string): ResolvedNode[] {
  const q = fold(query.trim());
  if (!q) return nodes;
  const hit = (n: ResolvedNode) =>
    fold(`${n.label} ${n.ref.kind === "tool" ? n.ref.name : ""} ${n.description ?? ""}`).includes(q);
  return nodes.flatMap((n) => {
    if (n.kind === "tool") return hit(n) ? [n] : [];
    if (hit(n)) return [n];
    const children = filterTree(n.children, query);
    return children.length ? [{ ...n, children }] : [];
  });
}

/** Matrix cell click on a tool: off → allow, on → deny, denied → lift the denial. */
export function cycleTool(model: AccessModel, tree: AccessNode[], key: string): AccessModel {
  const id = `tool:${key}`;
  const parent = tree.find((g) => g.children.some((c) => c.id === id));
  const node = parent?.children.find((c) => c.id === id);
  if (!parent || !node) return model;
  const covered = model.allTools || isOn(stateOf(parent, model, model.allTools));
  const state = stateOf(node, model, covered);
  if (state === "denied") return setDenied(model, id, false);
  if (isOn(state)) return setDenied(model, id, true);
  return toggle(model, node, true, covered);
}
