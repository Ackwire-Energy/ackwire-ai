import type { TFunction } from "i18next";
import type { Approval } from "../api/types";
import { approvalAction, emailTitleWords } from "./approval-kind";
import { humanize } from "./custom-tools";
import { partsOf, toolName } from "./tool-review";

/**
 * An approval in the person's words, the same on the web and the phone: its title, what the agent wants
 * to do ("Ada quer ver stack trace do evento"), whether it only looks, and its values as label and value.
 */

type Tt = (key: string, options?: Record<string, unknown>) => string;

/** The app's own tools whose approval title it says in the person's language (`approval.titles.*`). */
const OWN_TITLES = new Set(["run_code", "upload_file", "run_skill_script", "post_message", "request_permission"]);

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
  return /^[A-Z][^A-Z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
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
  { max = Number.POSITIVE_INFINITY, long = false }: { max?: number; long?: boolean } = {},
): [string, string][] {
  // An email is said by its sentence and its letter; its fields aren't values.
  if (approval.email) return [];
  const skip = innerTool(approval) ? "name" : null;
  const out: [string, string][] = [];
  const walk = (obj: Record<string, unknown>, top: boolean) => {
    for (const [k, v] of Object.entries(obj)) {
      if (top && k === skip) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        const text = String(v).trim();
        if (text && (long || text.length <= 60)) out.push([humanize(k), text]);
      } else if (top && v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, false);
    }
  };
  walk(approval.params ?? {}, true);
  return out.slice(0, max);
}
