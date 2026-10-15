import type { TFunction } from "i18next";
import type { LiveRun } from "@/realtime/streams";
import { joinNames } from "./format";

/**
 * What the typing bar says someone is doing: "Theo está pensando…", "Theo
 * está consultando o GitHub…", "Marina está digitando…". Agents' verbs come
 * from the tool they are calling (`agent.tool`, see realtime/streams.ts).
 */
export type ActivityKind =
  | "thinking"
  | "typing"
  | "consulting"
  | "creatingIssue"
  | "updatingIssue"
  | "readingIssues"
  | "readingDrive"
  | "writingDrive"
  | "searchingMemory"
  | "updatingMemory"
  | "checkingCalendar"
  | "schedulingEvent"
  | "askingQuestion"
  | "openingSkill"
  | "consultingSkill"
  | "runningCode"
  | "pcFiles"
  | "exportingFile"
  | "importingFile"
  | "runningSkillScript"
  | "runningSkillScriptAny"
  | "fetchingFile"
  | "schedulingReminder"
  | "creatingRoutine"
  | "openingForumTopic"
  | "postingInForum"
  | "usingTool";

export interface Activity {
  kind: ActivityKind;
  /** The app being consulted ("GitHub", "himetrica"), for `consulting`; the skill name for `openingSkill`. */
  app?: string;
}

/** The engine's own tools (packages/engine/src/context, issues, artifacts, calendar). */
const BUILTIN: Record<string, ActivityKind> = {
  create_issue: "creatingIssue",
  update_issue: "updatingIssue",
  comment_issue: "updatingIssue",
  list_issues: "readingIssues",
  get_issue: "readingIssues",
  read_artifact: "readingDrive",
  list_artifacts: "readingDrive",
  create_artifact: "writingDrive",
  update_artifact: "writingDrive",
  search_context: "searchingMemory",
  expand: "searchingMemory",
  get_summary: "searchingMemory",
  remember: "updatingMemory",
  forget: "updatingMemory",
  update_memory: "updatingMemory",
  propose_instruction_change: "updatingMemory",
  list_events: "checkingCalendar",
  find_free_time: "checkingCalendar",
  propose_event: "schedulingEvent",
  ask_user: "askingQuestion",
  // The agent's PC (sandbox).
  run_code: "runningCode",
  write_file: "pcFiles",
  read_file: "pcFiles",
  list_files: "pcFiles",
  export_file: "exportingFile",
  import_file: "importingFile",
  share_artifact: "fetchingFile",
  // Scheduling from the chat.
  schedule_reminder: "schedulingReminder",
  create_routine: "creatingRoutine",
  // The forum.
  open_forum_topic: "openingForumTopic",
  post_in_forum: "postingInForum",
};

/** Catalog connectors (packages/engine/src/connectors/catalog.ts): tools are exposed as `<id>_<tool>`. */
const CONNECTORS: Record<string, string> = {
  github: "GitHub",
  sentry: "Sentry",
  linear: "Linear",
  drive: "Drive",
  gdrive: "Drive",
  slack: "Slack",
  notion: "Notion",
  jira: "Jira",
  stripe: "Stripe",
};

/** First words that are verbs, not a connector prefix ("send_email" is a tool, not the app "send"). */
const VERBS = new Set([
  "get",
  "list",
  "create",
  "update",
  "delete",
  "read",
  "write",
  "search",
  "find",
  "send",
  "add",
  "remove",
  "set",
  "run",
  "fetch",
  "ask",
  "propose",
  "comment",
  "query",
  "post",
  "make",
  "do",
]);

const isDrive = (id: string) => id === "drive" || id === "gdrive" || id === "google_drive";

/**
 * The friendly activity of a tool call. `connector` is the app label when the
 * event carries it; otherwise it is guessed from the tool name's prefix.
 */
export function toolActivity(
  tool: string | null | undefined,
  connector?: string | null,
  detail?: string | null,
): Activity {
  const name = (tool ?? "").trim().toLowerCase();
  if (!name) return { kind: "thinking" };
  // "Theo está abrindo a skill Revisão de PR…", or "consultando uma skill" without the name.
  if (name === "run_skill_script") {
    return detail?.trim() ? { kind: "runningSkillScript", app: detail.trim() } : { kind: "runningSkillScriptAny" };
  }
  if (name === "load_skill")
    return detail?.trim() ? { kind: "openingSkill", app: detail.trim() } : { kind: "consultingSkill" };
  const builtin = BUILTIN[name];
  if (builtin) return { kind: builtin };
  const label = connector?.trim();
  if (label) {
    if (isDrive(label.toLowerCase().replace(/\s+/g, "_"))) return { kind: "readingDrive" };
    return { kind: "consulting", app: label };
  }
  const prefix = name.split(/[_.:]/)[0] ?? "";
  if (isDrive(prefix)) return { kind: "readingDrive" };
  const known = CONNECTORS[prefix];
  if (known) return { kind: "consulting", app: known };
  if (prefix.length >= 2 && prefix !== name && !VERBS.has(prefix)) return { kind: "consulting", app: prefix };
  return { kind: "usingTool" };
}

/** An agent's run is in the timeline (its first words arrived, or it failed): not in the bar. */
export const isWriting = (r: LiveRun) => r.status === "failed" || r.text.length > 0;

export interface ActivityEntry {
  id: string;
  type: "agent" | "person";
  name: string;
  activity: Activity;
}

/** Who shows in the bar, in order: agents about to answer (not yet writing), then people typing. */
export function barEntries(
  runs: LiveRun[],
  typingUserIds: string[],
  agentName: (id: string) => string,
  personName: (id: string) => string | undefined,
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    if (isWriting(r) || r.status === "waiting_approval" || seen.has(r.agentId)) continue;
    seen.add(r.agentId);
    out.push({
      id: r.agentId,
      type: "agent",
      name: agentName(r.agentId),
      activity: toolActivity(r.tool, r.connector, r.toolDetail),
    });
  }
  for (const id of typingUserIds) {
    const name = personName(id);
    if (name) out.push({ id, type: "person", name, activity: { kind: "typing" } });
  }
  return out;
}

export interface ActivityGroup {
  names: string[];
  activity: Activity;
}

/** People doing the same thing share a phrase: "Ada e Atlas estão pensando". */
export function groupActivities(entries: ActivityEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const e of entries) {
    const same = groups.find((g) => g.activity.kind === e.activity.kind && g.activity.app === e.activity.app);
    if (same) same.names.push(e.name);
    else groups.push({ names: [e.name], activity: e.activity });
  }
  return groups;
}

/** "pensando", "consultando o GitHub". */
export const activityVerb = (t: TFunction, a: Activity) => t(`chat.activity.${a.kind}`, { app: a.app ?? "" });

/** The bar's sentence: "Theo está consultando o GitHub · Marina está digitando…"; "" when nobody. */
export function activityText(t: TFunction, entries: ActivityEntry[]) {
  const groups = groupActivities(entries);
  if (groups.length === 0) return "";
  const and = t("newAgent.and");
  const phrases = groups.map((g) =>
    t("chat.doing", { count: g.names.length, names: joinNames(g.names, and), doing: activityVerb(t, g.activity) }),
  );
  return `${phrases.join(" · ")}…`;
}
