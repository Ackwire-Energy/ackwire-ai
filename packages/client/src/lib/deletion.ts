import type { TFunction } from "i18next";
import type { AccountDeletionPlan, OrgDeletion, OrgSummary } from "../api/types";
import { formatShortDate, joinNames } from "./format";

/** Days a deleted workspace stays closed and restorable (the engine's `WORKSPACE_DELETION_DAYS`). */
export const DELETION_DAYS = 7;

/** When a workspace deleted at `now` goes for good. */
export const deletionDueFrom = (now = new Date()) => new Date(now.getTime() + DELETION_DAYS * 86_400_000).toISOString();

/** Whether this person may restore the workspace now: an owner, before its date (`dueAt` is null once it passed). */
export const restorable = (org: Pick<OrgSummary, "role" | "deletion">, now = Date.now()) =>
  org.role === "owner" && !!org.deletion?.dueAt && Date.parse(org.deletion.dueAt) > now;

/** The closing screen's line: who deleted it and when, then when it goes for good while that's still ahead. */
export function deletingText(t: TFunction, locale: string, deletion: OrgDeletion, now = Date.now()): string | null {
  if (!deletion.requestedAt) return null;
  const by = deletion.requestedBy?.name || t("deleting.someone");
  const date = formatShortDate(locale, deletion.requestedAt);
  const due = deletion.dueAt && Date.parse(deletion.dueAt) > now ? deletion.dueAt : null;
  return due
    ? t("deleting.text", { by, date, due: formatShortDate(locale, due) })
    : t("deleting.textLate", { by, date });
}

/** What proves it's the person before deleting: nothing (a sign-in lately), the password, or a new sign-in. */
export type ProofNeeded = "none" | "password" | "signIn";

/**
 * The proof deleting asks for, from the preflight (`password`, `freshUntil`), until the server refuses one: a
 * `reauth.*` code (`refused`) wins, since the session's sign-in got old meanwhile or the clocks disagree.
 */
export function proofNeeded(
  plan: Pick<AccountDeletionPlan, "password" | "freshUntil">,
  refused?: string,
  now = Date.now(),
): ProofNeeded {
  const fresh = !refused?.startsWith("reauth.") && !!plan.freshUntil && Date.parse(plan.freshUntil) > now;
  if (fresh) return "none";
  return plan.password ? "password" : "signIn";
}

/** One line of what deleting the account does, by what it is about (the apps pick an icon for each). */
export interface AccountDeletionLine {
  kind: "closes" | "leaves" | "computers" | "staysBehind" | "messages" | "serverOwner";
  text: string;
}

/**
 * What deleting the account does, in the person's words, from its preflight: the workspaces that close with it and
 * those they leave, per workspace the computers removed and what stays behind, that their messages stay, and, on a
 * self-hosted server they set up, that its settings lose their owner here.
 */
export function accountDeletionLines(
  t: TFunction,
  locale: string,
  plan: AccountDeletionPlan,
  { cloud, now = new Date() }: { cloud: boolean; now?: Date },
): AccountDeletionLine[] {
  const and = t("newAgent.and");
  const names = (items: { name: string }[]) =>
    joinNames(
      items.map((i) => i.name),
      and,
    );
  const orgName = (orgId: string) => plan.leaves.find((o) => o.id === orgId)?.name ?? "";
  const byOrg = <T extends { orgId: string }>(items: T[]) => {
    const groups = new Map<string, T[]>();
    for (const item of items) groups.set(item.orgId, [...(groups.get(item.orgId) ?? []), item]);
    return [...groups];
  };
  const lines: AccountDeletionLine[] = [];
  if (plan.closes.length > 0) {
    const date = formatShortDate(locale, deletionDueFrom(now));
    const text = t("deleteAccount.closes", { count: plan.closes.length, names: names(plan.closes), date });
    lines.push({ kind: "closes", text });
  }
  if (plan.leaves.length > 0)
    lines.push({ kind: "leaves", text: t("deleteAccount.leaves", { names: names(plan.leaves) }) });
  for (const [orgId, computers] of byOrg(plan.computers)) {
    const text = t("deleteAccount.computers", {
      count: computers.length,
      name: orgName(orgId),
      computers: names(computers),
    });
    lines.push({ kind: "computers", text });
  }
  for (const [orgId, items] of byOrg(plan.staysBehind))
    lines.push({
      kind: "staysBehind",
      text: t("deleteAccount.staysBehind", { name: orgName(orgId), items: names(items) }),
    });
  lines.push({ kind: "messages", text: t("deleteAccount.messages") });
  if (plan.serverOwner && !cloud) lines.push({ kind: "serverOwner", text: t("deleteAccount.serverOwner") });
  return lines;
}
