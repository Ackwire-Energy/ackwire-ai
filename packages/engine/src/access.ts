import { and, asc, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
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
  type ScopeGrant,
  toolAccess,
  toolAllowScope,
  toolDenyScope,
} from "./tools/scopes";

const { agentScopes, connectorConnections, agents } = schema;

/** Built-in tools by scope (what the built-in sources offer). `ask_user` needs no scope. */
export const BUILTIN_TOOLS: Record<string, string[]> = {
  "": ["ask_user"],
  "context:read": ["search_context", "get_summary", "expand"],
  "memory:write": ["remember", "update_memory", "forget", "propose_instruction_change"],
  "drive:read": ["read_artifact", "list_artifacts", "share_artifact"],
  "drive:write": ["create_artifact", "update_artifact"],
  "issues:read": ["list_issues"],
  "issues:write": ["create_issue", "update_issue", "comment_issue"],
  "calendar:read": ["list_events", "find_free_time"],
  "calendar:write": ["propose_event"],
  "skills:read": ["load_skill", "read_skill_file"],
  "schedule:write": ["schedule_reminder", "create_routine", "list_reminders", "cancel_reminder"],
  "forum:write": ["open_forum_topic", "post_in_forum", "read_forum_topic"],
  "wiki:read": ["search_wiki", "read_wiki_page"],
  "wiki:write": ["create_wiki_page", "update_wiki_page", "link_to_wiki"],
  "sandbox:run": [
    "run_code",
    "write_file",
    "read_file",
    "list_files",
    "export_file",
    "import_file",
    "run_skill_script",
    "computer_start",
    "computer_stop",
    "computer_status",
  ],
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
  /** Human name, pt-BR when we have one. */
  label: string;
  description: string;
  connectionId: string | null;
  scope: string;
  sensitive: boolean;
  /** Only reads (built-in `:read` scopes, MCP `readOnlyHint` or classified as read, catalog read scopes). */
  readOnly: boolean;
  state: AccessState;
}

/** Labels and descriptions of the built-in tools (pt-BR). */
export const BUILTIN_TOOL_INFO: Record<string, { label: string; description: string }> = {
  ask_user: { label: "Perguntar à pessoa", description: "Faz uma pergunta curta e espera a resposta." },
  search_context: { label: "Buscar no contexto", description: "Busca mensagens, resumos, fatos e lições." },
  get_summary: { label: "Ler resumo", description: "Lê o resumo de um thread ou período." },
  expand: { label: "Abrir item", description: "Abre uma memória ou mensagem por inteiro." },
  remember: { label: "Lembrar", description: "Guarda uma nota quando alguém pede." },
  update_memory: { label: "Atualizar memória", description: "Corrige uma nota guardada." },
  forget: { label: "Esquecer", description: "Arquiva uma nota quando alguém pede." },
  propose_instruction_change: {
    label: "Propor mudança de instruções",
    description: "Sugere mudar as próprias instruções ou o contexto da org; uma pessoa decide.",
  },
  read_artifact: { label: "Ler arquivo", description: "Lê um arquivo do Drive." },
  list_artifacts: { label: "Listar arquivos", description: "Lista os arquivos do Drive que vê." },
  share_artifact: {
    label: "Compartilhar arquivo",
    description: "Traz para a conversa um arquivo que fez em outra (como uma DM), se quem pediu tem acesso.",
  },
  create_artifact: { label: "Criar arquivo", description: "Cria documento, tabela, diff, diagrama ou página." },
  update_artifact: { label: "Atualizar arquivo", description: "Salva uma nova versão de um arquivo." },
  list_issues: { label: "Ver issues", description: "Lista e abre issues." },
  create_issue: { label: "Criar issue", description: "Cria uma issue com critérios de aceite." },
  update_issue: { label: "Atualizar issue", description: "Muda status, prioridade ou liga um PR." },
  comment_issue: { label: "Comentar issue", description: "Comenta o andamento numa issue." },
  list_events: { label: "Ver agenda", description: "Lista eventos." },
  find_free_time: { label: "Achar horário livre", description: "Procura horários livres em comum." },
  propose_event: { label: "Propor evento", description: "Sugere um evento; quem pediu confirma." },
  load_skill: { label: "Carregar skill", description: "Carrega as instruções de uma skill." },
  read_skill_file: { label: "Ler arquivo de skill", description: "Lê um arquivo de referência de uma skill." },
  schedule_reminder: { label: "Criar lembrete", description: "Agenda um lembrete nesta conversa, para quem pediu." },
  create_routine: { label: "Criar rotina", description: "Cria uma rotina recorrente nesta conversa." },
  list_reminders: { label: "Ver lembretes", description: "Lista os lembretes pendentes de quem pediu." },
  cancel_reminder: { label: "Cancelar lembrete", description: "Cancela um lembrete de quem pediu." },
  open_forum_topic: { label: "Abrir tópico no fórum", description: "Leva um assunto para discussão entre agentes." },
  post_in_forum: { label: "Postar no fórum", description: "Posta num tópico fora da própria vez." },
  read_forum_topic: { label: "Ler tópico do fórum", description: "Lê o objetivo e as respostas de um tópico." },
  search_wiki: { label: "Buscar na wiki", description: "Procura páginas da wiki da organização." },
  read_wiki_page: { label: "Ler página da wiki", description: "Lê uma página da wiki inteira." },
  create_wiki_page: { label: "Criar página na wiki", description: "Cria uma página quando alguém pede." },
  update_wiki_page: {
    label: "Editar página da wiki",
    description: "Acrescenta ou reescreve um trecho quando alguém pede.",
  },
  link_to_wiki: { label: "Ligar páginas da wiki", description: "Liga uma página a outras quando alguém pede." },
  run_code: { label: "Rodar código", description: "Roda Python, Node ou bash no ambiente isolado da conversa." },
  write_file: { label: "Escrever no ambiente", description: "Grava um arquivo no ambiente de código." },
  read_file: { label: "Ler do ambiente", description: "Lê um arquivo do ambiente de código." },
  list_files: { label: "Listar o ambiente", description: "Lista os arquivos do ambiente de código." },
  export_file: { label: "Salvar no Drive", description: "Leva um arquivo do ambiente para o Drive." },
  import_file: { label: "Trazer do Drive", description: "Copia um arquivo do Drive para o ambiente." },
  run_skill_script: { label: "Rodar script de skill", description: "Roda um script de uma skill no ambiente." },
  computer_start: { label: "Ligar o computador", description: "Liga o computador do agente (cria na primeira vez)." },
  computer_stop: { label: "Desligar o computador", description: "Desliga o computador; os arquivos ficam." },
  computer_status: { label: "Ver o computador", description: "Diz se está ligado, o disco usado e o custo do mês." },
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
          label: scope.endsWith(":read") ? "Leitura" : "Escrita",
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
    label: scope === "" ? "Perguntar à pessoa" : (BUILTIN_SCOPES[scope]?.label ?? scope),
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
    await tx.delete(agentScopes).where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId)));
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
        reason: c.custom
          ? "conectado, aguardando um admin classificar as ferramentas"
          : "conectado, sem ferramentas disponíveis",
      });
    } else if (!tools.some((t) => offeredToolNames.has(t.name))) {
      out.push({
        label: c.label,
        reason: "conectado, mas as ferramentas não foram liberadas para você; peça a um admin em Editar permissões",
      });
    }
  }
  return out;
}
