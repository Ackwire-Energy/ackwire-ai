import type { Message } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import type { TimelineItem } from "@agenteschat/client/lib/timeline";
import type { TFunction } from "i18next";

/**
 * Scrolled up while things arrive: a "Novas"
 * divider before the first unseen message, and the pill says who spoke ("↓ 2 novas · Marina e Ada ·
 * Theo escrevendo"). A click lands on the divider when it is far, else at the end.
 */

/** The messages from `fromKey` to the end that someone else wrote, and their authors in order. */
export function unseenOf(items: TimelineItem[], fromKey: string | null, meId: string) {
  const authors: Message["author"][] = [];
  let count = 0;
  if (!fromKey) return { count, authors };
  const at = items.findIndex((i) => i.key === fromKey);
  if (at < 0) return { count, authors };
  for (const item of items.slice(at)) {
    if (item.kind !== "message") continue;
    const a = item.message.author;
    if (a.type === "person" && a.id === meId) continue;
    count++;
    if (!authors.some((x) => x.type === a.type && x.id === a.id)) authors.push(a);
  }
  return { count, authors };
}

/** The first row after `previousLastKey` (where the divider goes), or null when nothing is new. */
export function firstNewKey(items: TimelineItem[], previousLastKey: string | undefined) {
  if (previousLastKey === undefined) return null;
  const at = items.findIndex((i) => i.key === previousLastKey);
  const next = items.slice(at + 1).find((i) => i.kind === "message");
  return at < 0 ? null : (next?.key ?? null);
}

/** "2 novas", "Marina e Ada" (or "Marina, Ada e mais 2"), "Theo escrevendo": the pieces that apply. */
export function pillParts(t: TFunction, count: number, names: string[], writing: string[]) {
  const said =
    names.length === 0
      ? ""
      : names.length <= 2
        ? joinNames(names, t("newAgent.and"))
        : t("channel.newPill.more", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  return [
    count > 0 ? t("channel.newPill.count", { count }) : "",
    said,
    ...writing.map((name) => t("channel.newPill.writing", { name })),
  ].filter(Boolean);
}

/** The divider is far from the end (more than 1.2 screens): the pill goes to it, not to the bottom. */
export const dividerIsFar = (dividerTop: number, scrollHeight: number, clientHeight: number) =>
  scrollHeight - dividerTop > clientHeight * 1.2;
