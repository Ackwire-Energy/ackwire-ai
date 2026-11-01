import type { TFunction } from "i18next";
import type { LiveConsult, LiveConsultStatus } from "../realtime/consults";
import type { LiveRun } from "../realtime/streams";
import { joinNames } from "./format";
import { agentGrammar } from "./grammar";
import { MAIL_BRANDS } from "./mail";

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
  | "sendingGif"
  | "sendingSticker"
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
  | "followingUp"
  | "cancelingFollowUp"
  | "listingReminders"
  | "listingRoutines"
  | "checkingComputer"
  | "writingWiki"
  | "readingWiki"
  | "linkingWiki"
  | "readingForum"
  | "creatingChannel"
  | "offeringConnectAi"
  | "proposingAgent"
  | "askingAgent"
  | "tellingAgent"
  | "findingTools"
  | "runningCommand"
  | "runningCommandAny"
  | "usingScreen"
  | "cloningRepo"
  | "openingPullRequest"
  | "handingOff"
  | "recordingFindings"
  | "deliveringMission"
  | "suggestingForumTopic"
  | "requestingAccess"
  | "requestingSecret"
  | "queryingDatabase"
  | "checkingUsage"
  | "usingTool";

/** The computer's own permission check before a command (`PERMISSION_TOOL` in `@agenteschat/adapters`). */
export const PERMISSION_TOOL = "permission_prompt";

export interface Activity {
  kind: ActivityKind;
  /** The app being consulted ("GitHub", "himetrica"), for `consulting`; the skill name for `openingSkill`. */
  app?: string;
  /**
   * The service the call works in, for its logo: a catalog connector's id (`github`, `drive`), a mailbox's maker
   * with a mark (`gmail`), `mail` for any other mailbox, or `postgres`.
   */
  service?: string;
  /** A server connected by address: its own icon (`/api/app/connector-icons/…`). */
  icon?: string;
}

/** Where a call works, as `agent.tool` and the saved `tool_call` step say it (the engine's `ToolDefinition`). */
export interface ToolService {
  service?: string | null;
  serviceIcon?: string | null;
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
  // A GIF or the agent's sticker (ADR 0091): the message itself shows it, the block says it was sent.
  send_gif: "sendingGif",
  send_sticker: "sendingSticker",
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
  computer_status: "checkingComputer",
  create_wiki_page: "writingWiki",
  update_wiki_page: "writingWiki",
  read_wiki_page: "readingWiki",
  search_wiki: "readingWiki",
  link_to_wiki: "linkingWiki",
  // Setting up the workspace.
  create_channel: "creatingChannel",
  offer_connect_ai: "offeringConnectAi",
  propose_agent: "proposingAgent",
  // Another agent of the team (the consultation card says who and what it answered).
  ask_agent: "askingAgent",
  tell_agent: "tellingAgent",
  // Ours, though their first word reads like an app's name.
  git_clone: "cloningRepo",
  open_pull_request: "openingPullRequest",
  hand_off: "handingOff",
  record_findings: "recordingFindings",
  complete_mission: "deliveringMission",
  suggest_forum_topic: "suggestingForumTopic",
  request_permission: "requestingAccess",
  request_folder_access: "requestingAccess",
  request_secret: "requestingSecret",
  use_tool: "findingTools",
  follow_up: "followingUp",
  get_my_usage: "checkingUsage",
  cancel_follow_up: "cancelingFollowUp",
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
  // The org's own mailboxes (`mail_<slug>_<verb>`, ADR 0038), labeled "Email" like their tools.
  mail: "Email",
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

/** One of the org's mailboxes' tools (`mail_<slug>_<verb>`, ADR 0038), also through the executor's MCP. */
const MAILBOX_TOOL = /^(?:mcp__agentes__)?mail_[a-z0-9]+_[a-z]+$/;

/**
 * The friendly activity of a tool call. `connector` is the app label when the
 * event carries it; otherwise it is guessed from the tool name's prefix.
 * `where`: the service the call names, for its logo. A mailbox goes by its maker's
 * name when the app draws its mark ("Consultou o Gmail"), else by "Email".
 */
export function toolActivity(
  tool: string | null | undefined,
  connector?: string | null,
  detail?: string | null,
  where?: ToolService | null,
): Activity {
  const a = activityOf(tool, connector, detail);
  const service = where?.service?.trim() || undefined;
  if (a.kind === "consulting" && MAILBOX_TOOL.test((tool ?? "").trim().toLowerCase())) {
    const brand = service ? MAIL_BRANDS[service] : undefined;
    return brand ? { kind: "consulting", app: brand.name, service } : { ...a, service: "mail" };
  }
  return { ...a, ...(service ? { service } : {}), ...(where?.serviceIcon ? { icon: where.serviceIcon } : {}) };
}

function activityOf(tool: string | null | undefined, connector?: string | null, detail?: string | null): Activity {
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
  // "Rodou: Rerun the tests": the command it checked, by the engine's label (`toolDetail`).
  if (name === PERMISSION_TOOL)
    return detail?.trim() ? { kind: "runningCommand", app: detail.trim() } : { kind: "runningCommandAny" };
  const builtin = BUILTIN[name];
  if (builtin) return { kind: builtin };
  // The tools on demand: looking one up (a big connector's own directory too) is ours, not an app.
  if (name === "find_tools" || name.endsWith("_find_tools")) return { kind: "findingTools" };
  // The agent's own browser (ADR 0040) and screen (ADR 0062): not apps called "browser" and "desktop".
  if (name.startsWith("browser_")) return { kind: "browsing" };
  if (name.startsWith("desktop_")) return { kind: "usingScreen" };
  const label = connector?.trim();
  if (label) {
    if (isDrive(label.toLowerCase().replace(/\s+/g, "_"))) return { kind: "readingDrive" };
    return { kind: "consulting", app: label };
  }
  // The org's databases (`pg_<slug>_query`, ADR 0039) when the event names no connection.
  if (name.startsWith("pg_")) return { kind: "queryingDatabase" };
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

/**
 * At work with no words of its own yet (nothing written, said or read): its row in the conversation is the waiting
 * row (face, dots, step line), with no name or time until words arrive.
 */
export const waitsForWords = (r: Pick<LiveRun, "status" | "text" | "work">) =>
  // Waiting on an approval keeps the waiting row: a header for that moment would jump in and out again.
  (BAR_STATUSES.has(r.status) || r.status === "waiting_approval") &&
  r.text.length === 0 &&
  !(r.work ?? []).some((w) => w.kind === "say" || w.kind === "steer");

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
      activity: writing ? { kind: "writing" } : toolActivity(r.tool, r.connector, r.toolDetail, r),
    });
  }
  for (const id of typingUserIds) {
    const name = personName(id);
    if (name) out.push({ id, type: "person", name, activity: { kind: "typing" } });
  }
  return out;
}

/** How many small faces the bar stacks, however many are at work (the sentence says "e mais N"). */
export const BAR_FACES = 3;

/** The faces the bar stacks: agents first, and at least one person typing when someone is. */
export function barFaces(entries: ActivityEntry[]): ActivityEntry[] {
  const agents = entries.filter((e) => e.type === "agent");
  const people = entries.filter((e) => e.type === "person");
  const shown = agents.slice(0, people.length > 0 ? BAR_FACES - 1 : BAR_FACES);
  return [...shown, ...people.slice(0, BAR_FACES - shown.length)];
}

/** The question the bar tells and times: one agent's on its own (beside others, its reply tells it). */
export function barAsking(entries: ActivityEntry[]): EntryConsult | undefined {
  const agents = entries.filter((e) => e.type === "agent");
  const consult = agents.length === 1 ? agents[0]?.consult : undefined;
  return consult?.status === "asking" ? consult : undefined;
}

/** " · 4 s" shows from 2 s on: minutes and seconds past a minute. */
export function elapsedParts(ms: number): { m: number; s: number } | null {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs < 2) return null;
  return { m: Math.floor(secs / 60), s: secs % 60 };
}

/**
 * The turn the bar tells for one agent on its own, its phrase and its time alike: a turn it stopped, or one that
 * failed, can still be listed beside the one at work.
 */
const turnAtWork = (runs: LiveRun[], agentId: string) =>
  runs.find((r) => r.agentId === agentId && r.status !== "failed" && r.status !== "canceled");

/** How long one agent on its own has been at it ("16 s", "1 min 5 s"): none for several, or while it asks another. */
export function barElapsed(t: TFunction, entries: ActivityEntry[], runs: LiveRun[], now: number): string | null {
  const agents = entries.filter((e) => e.type === "agent");
  const only = agents.length === 1 ? agents[0] : undefined;
  if (!only || only.consult?.status === "asking") return null;
  const run = turnAtWork(runs, only.id);
  const took = run ? elapsedParts(now - (run.startedAt ?? now)) : null;
  if (!took) return null;
  return took.m > 0 ? t("run.elapsedMinutes", { m: took.m, s: took.s }) : t("run.elapsedSeconds", { n: took.s });
}

/** "trabalhando", "consultando o GitHub". */
export const activityVerb = (t: TFunction, a: Activity) => t(`chat.activity.${a.kind}`, { app: appLabel(a) });

/**
 * The app as people read it: a connector's slug ("himetrica") starts with a capital ("Himetrica"); a name with
 * capitals of its own stays as it is written ("iCloud").
 */
export const appLabel = (a: { kind: string; app?: string }) => {
  const app = a.app ?? "";
  return a.kind === "consulting" && app === app.toLowerCase() ? app.charAt(0).toUpperCase() + app.slice(1) : app;
};

/** Wraps a name in the sentence (the bar shows names in bold); plain text by default. */
export type MarkName = (name: string) => string;
const plain: MarkName = (name) => name;

/** "Theo", "Theo e Iris", "Theo e mais 2". */
export function listNames(t: TFunction, names: string[], mark: MarkName = plain) {
  if (names.length <= 2) return joinNames(names.map(mark), t("newAgent.and"));
  return t("chat.namesMore", { first: mark(names[0] ?? ""), count: names.length - 1 });
}

/** One consultation's phrase: "Dev está perguntando ao Infra", "Infra respondeu. Dev está escrevendo". */
function consultPhrase(t: TFunction, from: string, c: EntryConsult, mark: MarkName) {
  const g = agentGrammar(t, c.toName);
  if (c.status === "asking") return t("chat.consult.asking", { from: mark(from), to: mark(c.toName), prep: g.to });
  if (c.status === "answered") return t("chat.consult.answered", { from: mark(from), to: mark(c.toName) });
  return t("chat.consult.writing", { from: mark(from) });
}

/** "Theo e Iris estão trabalhando", "Marina está digitando". */
const doingPhrase = (t: TFunction, names: string[], activity: Activity, mark: MarkName) =>
  t("chat.doing", { count: names.length, names: listNames(t, names, mark), doing: activityVerb(t, activity) });

/** The agents' part: one says what it does (or whom it asks); several just work, their blocks say the rest. */
function agentsPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName) {
  const agents = entries.filter((e) => e.type === "agent");
  const only = agents.length === 1 ? agents[0] : undefined;
  if (only?.consult) return consultPhrase(t, only.name, only.consult, mark);
  if (agents.length === 0) return "";
  const names = agents.map((e) => e.name);
  return doingPhrase(t, names, only?.activity ?? { kind: "thinking" }, mark);
}

const typingNames = (entries: ActivityEntry[]) => entries.flatMap((e) => (e.type === "person" ? [e.name] : []));

const PHRASES_SEP = " · ";

/** "Marina está digitando"; "" when nobody types. */
function typingPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName) {
  const people = typingNames(entries);
  return people.length > 0 ? doingPhrase(t, people, { kind: "typing" }, mark) : "";
}

/**
 * The bar's sentence, one short line however many are at work: "Theo e mais 2 estão trabalhando · Marina
 * está digitando…"; "" when nobody. `mark` wraps each name (for bold).
 */
export function activitySentence(t: TFunction, entries: ActivityEntry[], mark: MarkName = plain) {
  const phrases = [agentsPhrase(t, entries, mark), typingPhrase(t, entries, mark)].filter(Boolean);
  return phrases.length > 0 ? `${phrases.join(PHRASES_SEP)}…` : "";
}

/** The bar's sentence as plain text (see `activitySentence`). */
export const activityText = (t: TFunction, entries: ActivityEntry[]) => activitySentence(t, entries);

/**
 * The card's phrase. One agent on its own says only its name (the bar adds its time): what it does is its waiting
 * row's step line in the conversation (`waitStep`), never said twice. Anyone else (several, a question out, people
 * typing): the plain sentence.
 */
export function barPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName = plain): string {
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only?.type === "agent" && !only.consult) return mark(only.name);
  return activitySentence(t, entries, mark);
}

/**
 * `barPhrase` in pieces, in the order they give way when the bar is short: the agents' words (then the " · "
 * after them, so it never leads the line), the names of who is typing, and never what they do (" está
 * digitando…"). Joined, they read as `barPhrase`; all but the first are "" when nobody types.
 */
export function barWords(
  t: TFunction,
  entries: ActivityEntry[],
  mark: MarkName = plain,
): [agents: string, sep: string, typers: string, typing: string] {
  const typing = typingPhrase(t, entries, mark);
  if (!typing) return [barPhrase(t, entries, mark), "", "", ""];
  const agents = agentsPhrase(t, entries, mark);
  // The names lead the phrase in pt-BR and en; a language that puts them later keeps the phrase whole.
  const names = listNames(t, typingNames(entries), mark);
  const at = typing.startsWith(names) ? names.length : 0;
  return [agents, agents ? PHRASES_SEP : "", typing.slice(0, at), `${typing.slice(at)}…`];
}
