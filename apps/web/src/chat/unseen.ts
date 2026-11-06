import type { Message } from "@agenteschat/client";
import { mentionsReader } from "@agenteschat/client/lib/everyone";
import { joinNames } from "@agenteschat/client/lib/format";
import { isMediaAfterReply } from "@agenteschat/client/lib/media";
import type { TimelineItem } from "@agenteschat/client/lib/timeline";
import type { TFunction } from "i18next";

/**
 * Scrolled up while things arrive: a "Novas" divider before the first unseen message, and the round button at the
 * top right counts them (in red when one mentions me); its label says who spoke ("2 novas · Marina e Ada ·
 * Theo escrevendo"). A click goes to the end; a catch-up while away lands on the divider when it is far. The sticker
 * or GIF an agent adds after its reply (ADR 0091) is never news of its own: it neither counts nor opens the divider.
 */

/** From `fromKey` to the end: how many someone else wrote, their authors in order, whether one @mentions me. */
export function unseenOf(items: TimelineItem[], fromKey: string | null, meId: string, myHandle?: string) {
  const authors: Message["author"][] = [];
  let count = 0;
  let mentionsMe = false;
  if (!fromKey) return { count, authors, mentionsMe };
  const at = items.findIndex((i) => i.key === fromKey);
  if (at < 0) return { count, authors, mentionsMe };
  for (const item of items.slice(at)) {
    if (item.kind !== "message" || isMediaAfterReply(item.message.meta)) continue;
    const a = item.message.author;
    if (a.type === "person" && a.id === meId) continue;
    count++;
    if (!mentionsMe) mentionsMe = mentionsReader(item.message, myHandle);
    if (!authors.some((x) => x.type === a.type && x.id === a.id)) authors.push(a);
  }
  return { count, authors, mentionsMe };
}

/** The first row after `previousLastKey` (where the divider goes), or null when nothing is new. */
export function firstNewKey(items: TimelineItem[], previousLastKey: string | undefined) {
  if (previousLastKey === undefined) return null;
  const at = items.findIndex((i) => i.key === previousLastKey);
  const next = items.slice(at + 1).find((i) => i.kind === "message" && !isMediaAfterReply(i.message.meta));
  return at < 0 ? null : (next?.key ?? null);
}

/** "2 novas", "Marina e Ada" (or "Marina, Ada e mais 2"), "Theo escrevendo", "mencionaram você": what applies. */
export function pillParts(t: TFunction, count: number, names: string[], writing: string[], mentionsMe = false) {
  const said =
    names.length === 0
      ? ""
      : names.length <= 2
        ? joinNames(names, t)
        : t("channel.newPill.more", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  return [
    count > 0 ? t("channel.newPill.count", { count }) : "",
    said,
    ...writing.map((name) => t("channel.newPill.writing", { name })),
    mentionsMe ? t("channel.newPill.mentionsYou") : "",
  ].filter(Boolean);
}

/** The divider is far from the end (more than 1.2 screens): the pill goes to it, not to the bottom. */
export const dividerIsFar = (dividerTop: number, scrollHeight: number, clientHeight: number) =>
  scrollHeight - dividerTop > clientHeight * 1.2;
