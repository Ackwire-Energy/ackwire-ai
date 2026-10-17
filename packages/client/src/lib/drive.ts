import type { Artifact, ArtifactKind } from "../api/types";
import { ARTIFACT_KINDS } from "./artifacts";
import { daysBetween } from "./format";

/** The Drive's arrangement (docs/design/telas/Drive.html). */
export type DriveView = "grid" | "list";
export type DriveWho = "all" | "agents" | "people";
export type DriveGroup = "date" | "channel" | "author" | "none";
export type DriveSort = "recent" | "name" | "kind";

export const DRIVE_GROUPS: DriveGroup[] = ["date", "channel", "author", "none"];
export const DRIVE_SORTS: DriveSort[] = ["recent", "name", "kind"];

export const isDriveView = (v: unknown): v is DriveView => v === "grid" || v === "list";

/** Made by an agent, by a person, or anyone. */
export const byWho = (a: Pick<Artifact, "createdBy">, who: DriveWho) =>
  who === "all" || a.createdBy.type === (who === "agents" ? "agent" : "person");

const newest = (a: Artifact, b: Artifact) => b.updatedAt.localeCompare(a.updatedAt);

export function sortArtifacts(list: Artifact[], sort: DriveSort, locale: string): Artifact[] {
  const kindOrder = (k: ArtifactKind) => ARTIFACT_KINDS.indexOf(k);
  return [...list].sort(
    sort === "name"
      ? (a, b) => a.title.localeCompare(b.title, locale, { sensitivity: "base" }) || newest(a, b)
      : sort === "kind"
        ? (a, b) => kindOrder(a.kind) - kindOrder(b.kind) || newest(a, b)
        : newest,
  );
}

/** "today", "week" (the last 7 days) or "earlier", by the last update. */
export function dateBucket(iso: string, now = new Date()): "today" | "week" | "earlier" {
  const days = daysBetween(iso, now);
  return days <= 0 ? "today" : days < 7 ? "week" : "earlier";
}

export interface DriveSection {
  /** "" without groups; a date bucket; a channel id ("" = no channel); "agent:id" / "person:id". */
  key: string;
  items: Artifact[];
}

/** Sections in a stable order: dates newest first, the rest as they first appear in the (sorted) list. */
export function groupArtifacts(list: Artifact[], group: DriveGroup, now = new Date()): DriveSection[] {
  if (group === "none") return list.length ? [{ key: "", items: list }] : [];
  const keyOf = (a: Artifact) =>
    group === "date"
      ? dateBucket(a.updatedAt, now)
      : group === "channel"
        ? (a.channelId ?? "")
        : `${a.createdBy.type}:${a.createdBy.id}`;
  const map = new Map<string, Artifact[]>();
  for (const a of list) {
    const k = keyOf(a);
    const items = map.get(k);
    if (items) items.push(a);
    else map.set(k, [a]);
  }
  const order = group === "date" ? ["today", "week", "earlier"] : [...map.keys()];
  return order.filter((k) => map.has(k)).map((key) => ({ key, items: map.get(key) ?? [] }));
}

/** Shift-click: everything between the last clicked item and this one (inclusive), in the shown order. */
export function rangeOf(ids: string[], anchor: string | null, target: string): string[] {
  const from = anchor ? ids.indexOf(anchor) : -1;
  const to = ids.indexOf(target);
  if (to < 0) return [];
  if (from < 0) return [target];
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Whole days left before the trash purges it (0 once it's due). */
export const daysLeft = (purgeAt: string, now = new Date()) =>
  Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now.getTime()) / 86_400_000));
