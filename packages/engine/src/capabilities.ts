import { isSensitive } from "./tools/gateway";
import type { ToolDefinition } from "./tools/types";

/** How tool groups are named in the prompt, by the scope's prefix (`drive:write` → `drive`). */
const GROUPS: Record<string, string> = {
  "": "Conversation",
  context: "Organization context and memory",
  memory: "Your notes (memory)",
  drive: "Files (Drive)",
  issues: "Issues",
  calendar: "Calendar",
  skills: "Skills",
  schedule: "Schedule and reminders",
  forum: "Forum",
  wiki: "Organization wiki",
  sandbox: "Code",
  github: "GitHub",
  sentry: "Sentry",
  linear: "Linear",
  gdrive: "Google Drive",
};

const groupOf = (tool: Pick<ToolDefinition, "scope">) => {
  const prefix = tool.scope.split(":")[0] ?? "";
  if (prefix in GROUPS) return GROUPS[prefix] as string;
  if (prefix.startsWith("custom")) return "Organization tools";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
};

const firstSentence = (s: string) => {
  const one = s.split(/(?<=\.)\s/)[0] ?? s;
  return one.length > 140 ? `${one.slice(0, 137)}…` : one;
};

/** Short, human summary of what a set of scopes allows ("Files (Drive), GitHub"), for other agents' context. */
export function summarizeScopes(scopes: string[]) {
  const groups = [...new Set(scopes.map((scope) => groupOf({ scope })))].filter((g) => g !== GROUPS[""]);
  return groups.length > 0 ? groups.join(", ") : "conversation only";
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
  const lines = ["# What you can do"];
  if (tools.length === 0) {
    lines.push(
      "You only write messages in this chat: you have no tools and you don't act outside this conversation (files, code, external systems).",
    );
  } else {
    lines.push("You can:");
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
        '- Requests for a PDF (or Word file): create a document with `create_artifact` (kind `document`); the file\'s card offers "Download PDF".',
      );
    }
    if (names.has("run_code")) {
      lines.push(
        "- Your computer's internet access is in the description of `run_code` (no internet, only some domains, or open internet). If a command fails because of the network (DNS, connection refused), say exactly what the tool says about it; don't blame permissions.",
      );
    }
    if (names.has("schedule_reminder")) {
      lines.push(
        "- You can schedule reminders and routines: `schedule_reminder` (once, in the time zone of whoever asked) and `create_routine` (recurring; with `channel` it posts straight to that channel, not to this conversation). To change a routine that already exists (instructions, time, where it answers), use `list_routines` and `update_routine`; never say it can't be changed. Confirm the time with the words the tool returns; if the time is ambiguous, ask first with `ask_user`.",
      );
    }
    if (names.has("share_artifact")) {
      lines.push(
        "- A request for a file you already made (here, in a DM or in another channel): find it with `list_artifacts` and bring it with `share_artifact` instead of creating it again.",
      );
    }
    const approval = tools.filter((t) => isSensitive(t)).map((t) => `\`${t.name}\``);
    if (approval.length > 0) {
      lines.push(`Need a person's approval (you ask, someone approves in the chat): ${approval.join(", ")}.`);
    }
  }
  if (pending.length > 0) {
    lines.push("Organization connectors you can't use yet:");
    for (const p of pending) lines.push(`- ${p.label}: ${p.reason}`);
    lines.push(
      "If someone asks for something from these connectors, say exactly what is missing and who can fix it. Never say the connector doesn't exist.",
    );
  }
  lines.push(
    "Beyond this, you can't. Never say you did or can do something that isn't on this list, and don't deny what is on it. If you can't do something, say so clearly and suggest who can: a person in the channel or another agent (mention them with @).",
  );
  return lines.join("\n");
}
