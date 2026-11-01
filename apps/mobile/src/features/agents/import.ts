import type { ImportItemKind, ImportItemResult, ImportSkipReason, MigrationBundle } from "@agenteschat/client";
import {
  choosable,
  IMPORT_KINDS,
  type ImportCard,
  itemId,
  type RequestCard,
} from "@agenteschat/client/lib/import/flow";
import { ARCHIVE_PATH, IMPORT_MAX_BYTES, isSecretPath, TEXT_PATH } from "@agenteschat/client/lib/import/shared";

/**
 * Bringing agents from another app on the phone, the pure part: which picked files are read, the preview's rows
 * (agents one by one, the rest by kind), and where the person lands once they arrive. The reading, the plan and the
 * apply are the web's (`@agenteschat/client/lib/import`).
 */

/** The cards whose app answers the export request (pasted back), not a file. */
export const isRequestCard = (card: ImportCard | null): card is RequestCard =>
  card === "grok-bot" || card === "chatgpt-dots" || card === "other";

/** A file from the system picker. */
export interface PickedAsset {
  name: string;
  size?: number | null;
}

/**
 * Which picked files are read as text: the formats' text files under the per-file cap, never a key or login file.
 * The rest still go in, empty, so the preview lists them as left behind. The phone opens no archive: picking only
 * archives is `archive`.
 */
export function phonePicks<T extends PickedAsset>(assets: readonly T[]): { read: boolean[]; archive: boolean } {
  const read = assets.map((a) => TEXT_PATH.test(a.name) && !isSecretPath(a.name) && (a.size ?? 0) <= IMPORT_MAX_BYTES);
  const archive = assets.length > 0 && assets.every((a) => ARCHIVE_PATH.test(a.name));
  return { read, archive };
}

/** A row's status word: `onboarding.import.status.*`, or `join` for a channel that already exists here. */
export type RowStatus = "create" | "update" | "unchanged" | "skip" | "join";

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  /** The @ it gets here (another when the bundle's is taken). */
  handle: string;
  appearance: MigrationBundle["agents"][number]["appearance"];
  status: RowStatus;
  /** Why it doesn't come, or a note on a create (its model isn't here). */
  reason: ImportSkipReason | null;
  /** The person can check or uncheck it. */
  free: boolean;
  on: boolean;
}

/** The agents of the plan, new ones first, each with what happens to it. */
export function agentRows(
  bundle: MigrationBundle,
  items: readonly ImportItemResult[],
  pick: ReadonlySet<string>,
  blocked: ReadonlyMap<string, ImportSkipReason>,
): AgentRow[] {
  const byKey = new Map(bundle.agents.map((a) => [a.key, a]));
  return items
    .filter((i) => i.kind === "agent")
    .sort((a, b) => RANK[a.action] - RANK[b.action])
    .map((item) => {
      const agent = byKey.get(item.key);
      const id = itemId(item);
      const free = choosable(item) && !blocked.has(id);
      return {
        id,
        name: agent?.name ?? item.label,
        role: agent?.role ?? "",
        handle: item.renamedTo ?? agent?.handle ?? item.key,
        appearance: agent?.appearance ?? {},
        status: item.action,
        reason: item.reason ?? blocked.get(id) ?? null,
        free,
        on: item.action === "unchanged" || (free && pick.has(id)),
      };
    });
}

/** Skipped last, already-here before them; the plan's order otherwise (the web's preview). */
const RANK: Record<ImportItemResult["action"], number> = { create: 0, update: 0, unchanged: 1, skip: 2 };

export interface KindGroup {
  kind: Exclude<ImportItemKind, "agent">;
  /** Items that come: picked new or changed ones, and the ones already here. */
  coming: number;
  total: number;
  /** What one switch checks or unchecks. */
  free: string[];
  on: boolean;
}

/**
 * Everything else the agents bring (skills, channels, routines, memory), one switch per kind: on while anything of
 * it is picked. A kind with nothing to pick is still listed, its switch off and locked.
 */
export function kindGroups(
  items: readonly ImportItemResult[],
  pick: ReadonlySet<string>,
  blocked: ReadonlyMap<string, ImportSkipReason>,
): KindGroup[] {
  return IMPORT_KINDS.filter((k): k is KindGroup["kind"] => k !== "agent").flatMap((kind) => {
    const rows = items.filter((i) => i.kind === kind && i.action !== "skip");
    if (rows.length === 0) return [];
    const free = rows.filter((i) => choosable(i) && !blocked.has(itemId(i))).map(itemId);
    const picked = free.filter((id) => pick.has(id)).length;
    const here = rows.filter((i) => i.action === "unchanged").length;
    return [{ kind, coming: here + picked, total: rows.length, free, on: picked > 0 }];
  });
}

/** The agents an apply created or changed, by id here. */
export const arrivedAgents = (report: readonly ImportItemResult[]) =>
  report
    .filter((i) => i.kind === "agent" && (i.action === "create" || i.action === "update") && i.targetId)
    .map((i) => i.targetId as string);

/**
 * Where the person lands: one agent's page in place of the create screen, or back down to the agents tab for
 * several (or none).
 */
export const landingOf = (agentIds: readonly string[]): { href: string; how: "replace" | "dismissTo" } =>
  agentIds.length === 1 ? { href: `/agent/${agentIds[0]}`, how: "replace" } : { href: "/agents", how: "dismissTo" };

/** A request that never got an answer: fetch's "Network request failed" is a `TypeError` on the phone. */
export const phoneOffline = (e: unknown) => e instanceof TypeError;

/** What the apply brought against what was asked: everything arrived, or how much did. */
export function reportCounts(report: readonly ImportItemResult[], asked: number) {
  const done = report.filter((i) => i.action === "create" || i.action === "update").length;
  return { done, total: asked, partial: done < asked };
}
