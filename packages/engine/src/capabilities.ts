import { isSensitive } from "./tools/gateway";
import type { ToolDefinition } from "./tools/types";

/** How tool groups are named in the prompt, by the scope's prefix (`drive:write` → `drive`). */
const GROUPS: Record<string, string> = {
  "": "Conversa",
  context: "Contexto e memória da organização",
  memory: "Suas notas (memória)",
  drive: "Arquivos (Drive)",
  issues: "Issues",
  calendar: "Calendário",
  sandbox: "Código",
  github: "GitHub",
  sentry: "Sentry",
  linear: "Linear",
  gdrive: "Google Drive",
};

const groupOf = (tool: Pick<ToolDefinition, "scope">) => {
  const prefix = tool.scope.split(":")[0] ?? "";
  if (prefix in GROUPS) return GROUPS[prefix] as string;
  if (prefix.startsWith("custom")) return "Ferramentas da organização";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
};

const firstSentence = (s: string) => {
  const one = s.split(/(?<=\.)\s/)[0] ?? s;
  return one.length > 140 ? `${one.slice(0, 137)}…` : one;
};

/** Short, human summary of what a set of scopes allows ("Arquivos (Drive), GitHub"), for other agents' context. */
export function summarizeScopes(scopes: string[]) {
  const groups = [...new Set(scopes.map((scope) => groupOf({ scope })))].filter((g) => g !== GROUPS[""]);
  return groups.length > 0 ? groups.join(", ") : "só conversa";
}

/**
 * The "what you can do" section of an agent's system prompt, built from the
 * tools it was actually granted for this run (so it can't drift from its
 * permissions): tools grouped by purpose, what needs a person's approval,
 * and how to behave about anything else.
 */
export function describeCapabilities(
  tools: Pick<ToolDefinition, "name" | "description" | "scope" | "sensitive">[],
  pending: { label: string; reason: string }[] = [],
) {
  const lines = ["# O que você pode fazer"];
  if (tools.length === 0) {
    lines.push(
      "Você só escreve mensagens neste chat: não tem ferramentas e não age fora desta conversa (arquivos, código, sistemas externos).",
    );
  } else {
    lines.push("Você pode:");
    const groups = new Map<string, string[]>();
    for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      const group = groupOf(t);
      const items = groups.get(group) ?? [];
      items.push(`\`${t.name}\` (${firstSentence(t.description)})`);
      groups.set(group, items);
    }
    for (const [group, items] of groups) lines.push(`- ${group}: ${items.join("; ")}`);
    const names = new Set(tools.map((t) => t.name));
    if (names.has("create_artifact")) {
      lines.push(
        '- Pedidos de PDF (ou Word): crie um documento com `create_artifact` (kind `document`); o card do arquivo oferece "Baixar PDF".',
      );
    }
    const approval = tools.filter((t) => isSensitive(t)).map((t) => `\`${t.name}\``);
    if (approval.length > 0) {
      lines.push(`Precisam da aprovação de uma pessoa (você pede, alguém aprova no chat): ${approval.join(", ")}.`);
    }
  }
  if (pending.length > 0) {
    lines.push("Conectores da organização que você ainda não pode usar:");
    for (const p of pending) lines.push(`- ${p.label}: ${p.reason}`);
    lines.push(
      "Se pedirem algo desses conectores, diga exatamente o que falta e quem pode resolver. Nunca diga que o conector não existe.",
    );
  }
  lines.push(
    "Fora disso, você não pode. Nunca diga que fez ou que consegue fazer algo que não está nesta lista, e não negue o que está nela. Se não puder fazer algo, diga isso com clareza e sugira quem pode: uma pessoa do canal ou outro agente (mencione com @).",
  );
  return lines.join("\n");
}
