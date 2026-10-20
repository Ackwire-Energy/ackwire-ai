import type { TFunction } from "i18next";
import type { LiveConsult, LiveConsultStatus } from "../realtime/consults";
import { type LiveRun, narrationOf } from "../realtime/streams";
import { joinNames } from "./format";
import { agentGrammar } from "./grammar";

/**
 * What the typing bar says someone is doing: "Theo está pensando…", "Theo
 * está consultando o GitHub…", "Marina está digitando…". Agents' verbs come
 * from the tool they are calling (`agent.tool`, see realtime/streams.ts).
 */
export type ActivityKind =
  | "thinking"
  | "typing"
  | "writing"
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
  | "reacting"
  | "openingSkill"
  | "consultingSkill"
  | "runningCode"
  | "browsing"
  | "pcFiles"
  | "exportingFile"
  | "importingFile"
  | "runningSkillScript"
  | "runningSkillScriptAny"
  | "fetchingFile"
  | "schedulingReminder"
  | "creatingRoutine"
  | "updatingRoutine"
  | "openingForumTopic"
  | "postingInForum"
  | "proposingMission"
  | "messagingMission"
  | "updatingPlan"
  | "reportingProgress"
  | "askingDecision"
  | "requestingReview"
  | "requestingApproval"
  | "startingTask"
  | "listingTasks"
  | "checkingTask"
  | "cancelingTask"
  | "uploadingArtifact"
  | "gettingContext"
  | "cancelingReminder"
  | "listingReminders"
  | "listingRoutines"
  | "startingComputer"
  | "stoppingComputer"
  | "checkingComputer"
  | "writingWiki"
  | "readingWiki"
  | "linkingWiki"
  | "readingForum"
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
  react: "reacting",
  // The agent's PC (sandbox).
  run_code: "runningCode",
  write_file: "pcFiles",
  read_file: "pcFiles",
  list_files: "pcFiles",
  export_file: "exportingFile",
  upload_file: "exportingFile",
  import_file: "importingFile",
  share_artifact: "fetchingFile",
  // Scheduling from the chat.
  schedule_reminder: "schedulingReminder",
  create_routine: "creatingRoutine",
  update_routine: "updatingRoutine",
  // The forum.
  open_forum_topic: "openingForumTopic",
  post_in_forum: "postingInForum",
  read_forum_topic: "readingForum",
  read_skill_file: "consultingSkill",
  // Missions (the agent's tools and the executor's MCP tools).
  propose_mission: "proposingMission",
  send_to_mission: "messagingMission",
  update_plan: "updatingPlan",
  report: "reportingProgress",
  ask_decision: "askingDecision",
  request_review: "requestingReview",
  request_approval: "requestingApproval",
  start_task: "startingTask",
  list_tasks: "listingTasks",
  task_status: "checkingTask",
  cancel_task: "cancelingTask",
  upload_artifact: "uploadingArtifact",
  get_context: "gettingContext",
  cancel_reminder: "cancelingReminder",
  list_reminders: "listingReminders",
  list_routines: "listingRoutines",
  computer_start: "startingComputer",
  computer_stop: "stoppingComputer",
  computer_status: "checkingComputer",
  create_wiki_page: "writingWiki",
  update_wiki_page: "writingWiki",
  read_wiki_page: "readingWiki",
  search_wiki: "readingWiki",
  link_to_wiki: "linkingWiki",
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
  let name = (tool ?? "").trim().toLowerCase();
  if (!name) return { kind: "thinking" };
  // An executor's MCP tool (`mcp__agentes__update_plan`): ours by its own name; another server's is that app.
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = "", rest = ""] = mcp;
    if (server !== "agentes" && !BUILTIN[rest]) return { kind: "consulting", app: CONNECTORS[server] ?? server };
    name = rest;
  }
  // "Theo está abrindo a skill Revisão de PR…", or "consultando uma skill" without the name.
  if (name === "run_skill_script") {
    return detail?.trim() ? { kind: "runningSkillScript", app: detail.trim() } : { kind: "runningSkillScriptAny" };
  }
  if (name === "load_skill")
    return detail?.trim() ? { kind: "openingSkill", app: detail.trim() } : { kind: "consultingSkill" };
  const builtin = BUILTIN[name];
  if (builtin) return { kind: builtin };
  // The agent's own browser (ADR 0040): not an app called "browser".
  if (name.startsWith("browser_")) return { kind: "browsing" };
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
/**
 * The run has its own row in the timeline: it wrote something, ended badly,
 * or read a message sent while it worked (`agent.run.read`: the row stays put
 * with "Leu seu recado" even though its text so far became narration).
 */
export const isWriting = (r: LiveRun) =>
  r.status === "failed" ||
  r.status === "canceled" ||
  r.text.length > 0 ||
  (r.work ?? []).some((w) => w.kind === "steer");

export interface ActivityEntry {
  id: string;
  type: "agent" | "person";
  name: string;
  activity: Activity;
  /** The agent is asking another agent (or just heard back): its own phrase, never grouped. */
  consult?: EntryConsult;
}

export interface EntryConsult {
  /** The agent it asked. */
  to: string;
  toName: string;
  status: LiveConsultStatus;
  /** When the question went out (the clock). */
  since: number;
}

/**
 * Who shows in the bar, in order: agents asking another agent (`consults`),
 * agents about to answer (not yet writing), then people typing.
 */
/** Live statuses the working bar shows (the ones "Parar" can stop; a provisional row is about to be one). */
const BAR_STATUSES: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);

export function barEntries(
  runs: LiveRun[],
  typingUserIds: string[],
  agentName: (id: string) => string,
  personName: (id: string) => string | undefined,
  consults: LiveConsult[] = [],
  /** Agents already writing stay in ("Theo está escrevendo…"): the card above the box is always on. */
  withWriting = false,
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const c of consults) {
    if (seen.has(c.agentId)) continue;
    // Its words are on screen already: the reply's row says it.
    if (runs.some((r) => r.runId === c.runId && isWriting(r))) continue;
    seen.add(c.agentId);
    out.push({
      id: c.agentId,
      type: "agent",
      name: agentName(c.agentId),
      activity: { kind: "thinking" },
      consult: { to: c.consultedAgentId, toName: agentName(c.consultedAgentId), status: c.status, since: c.since },
    });
  }
  for (const r of runs) {
    // Only work in progress: a run waiting (an approval, an answer, its computer) or ended isn't "working".
    if (!BAR_STATUSES.has(r.status) || seen.has(r.agentId)) continue;
    const writing = isWriting(r);
    if (writing && !withWriting) continue;
    seen.add(r.agentId);
    out.push({
      id: r.agentId,
      type: "agent",
      name: agentName(r.agentId),
      activity: writing ? { kind: "writing" } : toolActivity(r.tool, r.connector, r.toolDetail),
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
  consult?: EntryConsult;
}

/** People doing the same thing share a phrase: "Ada e Atlas estão trabalhando". A consultation is its own. */
export function groupActivities(entries: ActivityEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const e of entries) {
    if (e.consult) {
      groups.push({ names: [e.name], activity: e.activity, consult: e.consult });
      continue;
    }
    const same = groups.find(
      (g) => !g.consult && g.activity.kind === e.activity.kind && g.activity.app === e.activity.app,
    );
    if (same) same.names.push(e.name);
    else groups.push({ names: [e.name], activity: e.activity });
  }
  return groups;
}

/** "trabalhando", "consultando o GitHub". */
export const activityVerb = (t: TFunction, a: Activity) => t(`chat.activity.${a.kind}`, { app: appLabel(a) });

/** The app as people read it: a connector's slug ("himetrica") starts with a capital ("Himetrica"). */
export const appLabel = (a: { kind: string; app?: string }) => {
  const app = a.app ?? "";
  return a.kind === "consulting" ? app.charAt(0).toUpperCase() + app.slice(1) : app;
};

/** Wraps a name in the sentence (the bar shows names in bold); plain text by default. */
export type MarkName = (name: string) => string;
const plain: MarkName = (name) => name;

/** "Theo", "Theo e Iris", "Theo, Iris e mais 2". */
export function listNames(t: TFunction, names: string[], mark: MarkName = plain) {
  if (names.length <= 2) return joinNames(names.map(mark), t("newAgent.and"));
  return t("chat.namesMore", {
    first: mark(names[0] ?? ""),
    second: mark(names[1] ?? ""),
    count: names.length - 2,
  });
}

/** One consultation's phrase: "Dev está perguntando ao Infra", "Infra respondeu. Dev está escrevendo". */
function consultPhrase(t: TFunction, from: string, c: EntryConsult, mark: MarkName) {
  const g = agentGrammar(t, c.toName);
  if (c.status === "asking") return t("chat.consult.asking", { from: mark(from), to: mark(c.toName), prep: g.to });
  if (c.status === "answered") return t("chat.consult.answered", { from: mark(from), to: mark(c.toName) });
  return t("chat.consult.writing", { from: mark(from) });
}

/**
 * The bar's sentence: "Theo, Iris e mais 2 estão trabalhando · Marina está
 * digitando…"; "" when nobody. `mark` wraps each name (for bold).
 */
export function activitySentence(t: TFunction, entries: ActivityEntry[], mark: MarkName = plain) {
  const groups = groupActivities(entries);
  if (groups.length === 0) return "";
  const phrases = groups.map((g) =>
    g.consult
      ? consultPhrase(t, g.names[0] ?? "", g.consult, mark)
      : t("chat.doing", {
          count: g.names.length,
          names: listNames(t, g.names, mark),
          doing: activityVerb(t, g.activity),
        }),
  );
  return `${phrases.join(" · ")}…`;
}

/** The bar's sentence as plain text (see `activitySentence`). */
export const activityText = (t: TFunction, entries: ActivityEntry[]) => activitySentence(t, entries);

/** How often the card's phrase turns (telas/CardTrabalhando.html, A). */
export const PHRASE_TURN_MS = 2600;
/** A step running this long gets an aside in turn ("Isso leva um minutinho…"). */
export const LONG_STEP_MS = 4000;
const THINKING_LINES = [
  "chat.phrase.thinking.l0",
  "chat.phrase.thinking.l1",
  "chat.phrase.thinking.l2",
  "chat.phrase.thinking.l3",
  "chat.phrase.thinking.l4",
] as const;
const LONG_LINES = [
  "chat.phrase.long.l0",
  "chat.phrase.long.l1",
  "chat.phrase.long.l2",
  "chat.phrase.long.l3",
] as const;

/**
 * The card's phrase at turn `tick`. One agent on its own: nothing done yet → who it is, then light lines
 * ("Juntando as peças…"); at work → what it does, an aside when the step is long, and what it
 * said last ("Theo: Achei a área de viagens…"), in turn. Anyone else (several, a question out, people
 * typing, writing): the plain sentence.
 */
export function barPhrase(
  t: TFunction,
  entries: ActivityEntry[],
  runs: LiveRun[],
  tick: number,
  now: number,
  mark: MarkName = plain,
): string {
  const sentence = activitySentence(t, entries, mark);
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only?.type !== "agent" || only.consult || only.activity.kind === "writing") return sentence;
  const run = runs.find((r) => r.agentId === only.id);
  if (!run) return sentence;
  const calls = (run.work ?? []).filter((w) => w.kind === "call");
  if (only.activity.kind === "thinking" && calls.length === 0) {
    // Who it is first, then two light lines, and again (the lines move on each round).
    const k = Math.floor(tick / 3) * 2;
    const line = (i: number) => `${t(THINKING_LINES[i % THINKING_LINES.length] ?? THINKING_LINES[0])}…`;
    return [sentence, line(k), line(k + 1)][tick % 3] ?? sentence;
  }
  const pool = [sentence];
  const step = calls.at(-1);
  if (step?.kind === "call" && step.running && step.since !== undefined && now - step.since >= LONG_STEP_MS)
    pool.push(`${t(LONG_LINES[Math.floor(tick / 2) % LONG_LINES.length] ?? LONG_LINES[0])}…`);
  const said = narrationOf(run).at(-1);
  if (said) pool.push(t("chat.phrase.said", { name: mark(only.name), text: said }));
  return pool[tick % pool.length] ?? sentence;
}
