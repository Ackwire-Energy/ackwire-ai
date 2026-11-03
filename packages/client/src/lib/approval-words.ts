import type { TFunction } from "i18next";
import type { Approval, ApprovalRule } from "../api/types";
import { aheadPhase, approvalAction, emailTitleWords, sqlReadsTarget } from "./approval-kind";
import { humanize } from "./custom-tools";
import { lowerFirst } from "./format";
import { agentGrammar } from "./grammar";
import { partsOf, toolName } from "./tool-review";

/**
 * An approval in the person's words, the same on the web and the phone: its title, what the agent wants
 * to do ("Ada quer ver stack trace do evento"), whether it only looks, and its values as label and value.
 */

type Tt = (key: string, options?: Record<string, unknown>) => string;

/** The git tool whose grants "Aprovar sempre" keeps by target (`owner/repo:branch`, engine `git/branches.ts`). */
const BRANCH_PUSH = "request_branch_push";

/** The app's own tools whose approval title it says in the person's language (`approval.titles.*`). */
const OWN_TITLES = new Set([
  "run_code",
  "upload_file",
  "run_skill_script",
  "post_message",
  "request_permission",
  "delete_branches",
  BRANCH_PUSH,
]);

/**
 * The approval's title: in the person's language for the app's own tools, for email ("Salvar um
 * rascunho de resposta para…") and for a connector tool that runs another by name ("Ver stack trace do
 * evento", not "Sentry: Execute sentry tool"), else the server's (connector) title.
 */
export function approvalTitle(
  t: TFunction,
  approval: Pick<Approval, "tool" | "title" | "params" | "email"> & Partial<Pick<Approval, "connector">>,
): string {
  if (approval.email) {
    const words = emailTitleWords(approval.email);
    return (t as unknown as Tt)(words.key, words.values);
  }
  const inner = innerTool(approval);
  if (inner) return toolName(t, partsOf(inner), inner);
  if (!OWN_TITLES.has(approval.tool)) return approval.title;
  const p = approval.params ?? {};
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  return t(`approval.titles.${approval.tool}`, {
    language: s(p.language),
    path: s(p.path),
    skill: s(p.skill),
    channel: s(p.channel).replace(/^#/, ""),
    permission: permissionLabel(t, s(p.permission), approval.title),
    repo: s(p.repo),
    branch: s(p.branch),
    ...(Array.isArray(p.branches) ? { count: p.branches.length } : {}),
    defaultValue: approval.title,
  });
}

/** What `request_permission` asks to turn on: a built-in scope in the person's language, a connector by its name. */
function permissionLabel(t: TFunction, permission: string, title: string) {
  const fromServer = title.replace(/^Turn on: /, "");
  if (!permission || permission.startsWith("connector:")) return fromServer;
  return (t as unknown as Tt)(`scopes.${permission.replace(/[^a-zA-Z0-9]/g, "_")}.label`, { defaultValue: fromServer });
}

/** Verbs that only look (the backend classifies connector tools by the same words). */
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "describe",
  "query",
  "check",
  "estimate",
  "fetch",
  "find",
  "view",
  "show",
  "count",
  "preview",
  "lookup",
]);

/** A connector tool that runs another one by name (`{ name, arguments }`): that tool's name, when it reads as one. */
function innerTool(approval: Pick<Approval, "params"> & Partial<Pick<Approval, "connector">>): string | null {
  const name = approval.params?.name;
  if (!approval.connector || typeof name !== "string" || !/^[a-z][a-z0-9_]*$/i.test(name)) return null;
  return partsOf(name).verb ? name : null;
}

/**
 * What it will do, said after "Ada quer …", always in the person's language: the inner tool's readable name
 * ("ver stack trace do evento"), the app's own titles and an email's, the known actions ("fazer um deploy"), else the tool's
 * own name in words. The server's title (English, "Sentry: Execute sentry tool") stays out of the sentence.
 */
export function approvalDoing(
  t: TFunction,
  approval: Pick<Approval, "tool" | "title" | "params" | "connector" | "scope" | "email">,
  locale: string,
) {
  const inner = innerTool(approval);
  const action = approvalAction(approval);
  const text = inner
    ? toolName(t, partsOf(inner), inner)
    : approval.email || OWN_TITLES.has(approval.tool)
      ? approvalTitle(t, approval)
      : action !== "other"
        ? t(`notifications.wait.doing.${action}`)
        : toolName(t, partsOf(approval.tool), approval.tool);
  // "Ver …" → "ver …"; an acronym ("PR #42") stays.
  return lowerFirst(text, locale);
}

/** It only looks: asked under a read scope, or its tool's name starts with a reading verb. */
export function approvalReadsOnly(approval: Pick<Approval, "tool" | "scope" | "params" | "connector">) {
  if (approval.scope.endsWith(":read")) return true;
  const verb = partsOf(innerTool(approval) ?? approval.tool).verb;
  return verb !== null && READ_VERBS.has(verb);
}

/**
 * Its values in words, label and value ("Issue id", "ACME-177"), one level into objects, without the inner
 * tool's name. Lists keep them short (`long: false`, at most `max`); the details show every one.
 */
export function approvalValues(
  approval: Pick<Approval, "params" | "connector" | "email">,
  {
    max = Number.POSITIVE_INFINITY,
    long = false,
    locale,
  }: {
    max?: number;
    long?: boolean;
    /** Numbers in the locale's format ("97.000"); grouped from five digits, so a year or an id stays as is. */
    locale?: string;
  } = {},
): [string, string][] {
  // Grouped from five digits by hand: Hermes reads `useGrouping` as a boolean, so "min2" would group a year.
  const formatNumber = locale
    ? (v: number) =>
        new Intl.NumberFormat(locale, { maximumFractionDigits: 4, useGrouping: Math.abs(v) >= 10000 }).format(v)
    : null;
  // An email is said by its sentence and its letter; its fields aren't values.
  if (approval.email) return [];
  const skip = innerTool(approval) ? "name" : null;
  const out: [string, string][] = [];
  const plain = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const walk = (obj: Record<string, unknown>, top: boolean) => {
    for (const [k, v] of Object.entries(obj)) {
      if (top && k === skip) continue;
      if (plain(v)) {
        const text = typeof v === "number" && formatNumber ? formatNumber(v) : String(v).trim();
        if (text && (long || text.length <= 60)) out.push([humanize(k), text]);
      } else if (Array.isArray(v) && v.length > 0 && v.every(plain)) {
        // A list of names (the branches to delete) is one value; on a card it is cut, never left out.
        const text = v.map(String).join(", ");
        out.push([humanize(k), long || text.length <= 60 ? text : `${text.slice(0, 59)}…`]);
      } else if (top && v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, false);
    }
  };
  walk(approval.params ?? {}, true);
  return out.slice(0, max);
}

/**
 * Its values on one line ("Role: seller · Month: 2026-10 · Revenue: 97.000"): what tells apart two requests
 * for the same tool, on the card while it waits and on the line once decided. The raw call stays in the details.
 */
export const approvalSummary = (approval: Pick<Approval, "params" | "connector" | "email">, locale: string, max = 4) =>
  approvalValues(approval, { max, locale })
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ");

/** Articles in an action's slug (`GITHUB_CREATE_AN_ISSUE_COMMENT`) that only make its words longer. */
const SLUG_ARTICLES = new Set(["a", "an", "the"]);

/**
 * An action a tool runs for the agent (Composio's slugs), in words: what it does, then its app ("Criar issue
 * comment (Github)"). The slug itself is for a title on hover.
 */
export function actionName(t: TFunction, slug: string) {
  const [app = "", ...rest] = slug.toLowerCase().split("_");
  const name = rest.filter((w) => !SLUG_ARTICLES.has(w)).join("_");
  return name ? `${toolName(t, partsOf(name), name)} (${humanize(app)})` : humanize(slug);
}

/** One of a routine's own actions (`Routine.ownActions`) in words: a Composio slug (upper case) by its app, else the tool's name. */
export const ownActionName = (t: TFunction, name: string) =>
  /^[A-Z0-9_]+$/.test(name) ? actionName(t, name) : toolName(t, partsOf(name), name);

/** A remembered push (`owner/repo:branch`) in words: "enviar para ana/fix em acme/app". */
function pushWords(t: TFunction, target: string) {
  const at = target.indexOf(":");
  return t("approval.always.pushTo", { repo: target.slice(0, at), branch: target.slice(at + 1) });
}

/** A command rule's tool (no connection, its action the command's kind); mirrors engine `approval-rules.ts` `COMMAND_RULE_TOOL`. */
export const COMMAND_RULE_TOOL = "command";

/** What "Aprovar sempre" covers on a card, in words: each action the tool runs, else the tool itself. */
export function approveAlwaysWords(t: TFunction, approval: Pick<Approval, "approveAlways">) {
  const kind = approval.approveAlways;
  if (!kind) return "";
  if (kind.tool === COMMAND_RULE_TOOL) return kind.actions.join(", ");
  if (kind.tool === BRANCH_PUSH) return kind.actions.map((target) => pushWords(t, target)).join(", ");
  const tool = toolName(t, partsOf(kind.tool), kind.tool);
  if (sqlReadsTarget(kind.actions[0]) !== null) return tool;
  return kind.actions.length > 0 ? kind.actions.map((slug) => actionName(t, slug)).join(", ") : tool;
}

/** "Aprovar sempre", or "Aprovar sempre leituras" where only the SQL reads of one project would be covered. */
export const approveAlwaysLabel = (t: TFunction, approval: Pick<Approval, "approveAlways">) =>
  t(sqlReadsTarget(approval.approveAlways?.actions[0]) === null ? "approval.always.button" : "approval.always.reads");

/**
 * The line under "Aprovar sempre", on the card's face: exactly what approving for good covers (with any values, one
 * branch, or only the reads of one project) and where to undo it.
 */
export function approveAlwaysHint(t: TFunction, approval: Pick<Approval, "approveAlways">, agentName: string) {
  const target = sqlReadsTarget(approval.approveAlways?.actions[0]);
  const key =
    target !== null
      ? target
        ? "approval.always.noteReads"
        : "approval.always.noteReadsAll"
      : approval.approveAlways?.tool === BRANCH_PUSH
        ? "approval.always.noteTarget"
        : approval.approveAlways?.tool === COMMAND_RULE_TOOL
          ? "approval.always.noteCommand"
          : "approval.always.note";
  return t(key, { ...agentGrammar(agentName), actions: approveAlwaysWords(t, approval), target: target ?? "" });
}

/** Where a rule applies, for its list: the connection's name, or the agent's computer for a command. */
export const approvalRuleServer = (t: TFunction, rule: Pick<ApprovalRule, "server">) =>
  rule.server ?? t("approval.always.computer");

/** A rule the agent runs without asking, in words: a push by its branch, its action, else the tool as labelled. */
export function approvalRuleWords(
  t: TFunction,
  rule: Pick<ApprovalRule, "tool" | "action" | "toolLabel"> & { connectionId?: string | null },
) {
  const target = sqlReadsTarget(rule.action);
  if (target !== null) {
    const words = t("approval.always.readsRule", { tool: rule.toolLabel });
    return target ? `${words} · ${target}` : words;
  }
  if (rule.tool === BRANCH_PUSH && rule.action) return pushWords(t, rule.action);
  if (rule.tool === COMMAND_RULE_TOOL && !rule.connectionId) return rule.action;
  return rule.action ? actionName(t, rule.action) : rule.toolLabel;
}

/** How an action prepared ahead ended without running, in a line (its card, Aprovações, the phone's sheet). */
export function aheadEndLine(t: TFunction, a: Pick<Approval, "runAt" | "status" | "executedAt" | "decidedAt">) {
  const phase = aheadPhase(a);
  return phase === "lapsed" || phase === "unapproved" || phase === "canceled" ? t(`approval.ahead.${phase}`) : null;
}

/**
 * How a decided approval ended, as the line that takes its card's place says it, the same on the web and the
 * phone: "Aprovado por você", "Recusado por Ana", "Expirou", "Cancelado".
 */
export function decisionOutcome(
  t: TFunction,
  a: Pick<Approval, "status" | "decidedByUserId">,
  meId: string | null,
  nameOf: (userId: string) => string | undefined,
): string {
  if (a.status === "expired" || a.status === "canceled") return t(`approvals.status.${a.status}`);
  const approved = a.status === "approved";
  const by = a.decidedByUserId;
  if (by && by === meId) return t(approved ? "approval.outcomeApprovedByYou" : "approval.outcomeRefusedByYou");
  const name = by ? nameOf(by) : undefined;
  if (name) return t(approved ? "approval.outcomeApprovedBy" : "approval.outcomeRefusedBy", { name });
  return t(approved ? "approvals.status.approved" : "approvals.status.refused");
}

/** Who an approval waits for, by name: the people `request_approval` asked (ADR 0126), else the agent's owner. */
export const approvalWaitsFor = (approval: Pick<Approval, "approvers">, ownerName: string | undefined) =>
  approval.approvers?.label || ownerName;

/**
 * Who a shared card's requests wait for: one `request_approval` and an ordinary approval of the same agent can share
 * a card while different people decide them, so every distinct name of the waiting requests (all of them once none
 * waits).
 */
export function approvalGroupWaitsFor(items: Pick<Approval, "approvers" | "status">[], ownerName: string | undefined) {
  const waiting = items.filter((a) => a.status === "pending");
  const names = new Set((waiting.length > 0 ? waiting : items).map((a) => approvalWaitsFor(a, ownerName)));
  return [...names].filter(Boolean).join(", ") || undefined;
}

/**
 * The keys that let someone decide any approval of its kind, as the server's `decidingKeys` (engine `approvals.ts`):
 * `approve_actions`; turning on access for good (`request_permission`), the keys that give it on the agent's page.
 */
export function approvalDecidingKeys(a: Pick<Approval, "tool" | "params">): string[] {
  if (a.tool !== "request_permission") return ["approve_actions"];
  const permission = a.params?.permission;
  return typeof permission === "string" && permission.startsWith("browser-profile:")
    ? ["manage_agents", "manage_connectors"]
    : ["manage_agents"];
}

/**
 * The line saying the person whose request it is decides it too, as an approver by role (ADR 0126): while it waits
 * and once they decided it. Null for any other approval.
 */
export function requesterDecidesLine(t: TFunction, a: Pick<Approval, "approvers" | "status" | "decidedByUserId">) {
  const asked = a.approvers;
  if (!asked?.requesterDecides || !asked.requestedByUserId) return null;
  if (a.status !== "pending" && a.decidedByUserId !== asked.requestedByUserId) return null;
  return t("approval.requesterDecides");
}
