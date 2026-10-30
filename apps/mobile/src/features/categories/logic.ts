import type { Channel } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";

type Role = Parameters<typeof can>[0];

/** Admins arrange the categories (ADR 0080). */
export const arrangesCategories = (role: Role | undefined) => can(role, "configure");

/** Who may put a channel in a category: its creator or an admin, as for renaming it. */
export const movesChannel = (channel: Pick<Channel, "createdByUserId">, meId: string | null, role: Role | undefined) =>
  (meId !== null && channel.createdByUserId === meId) || can(role, "manage_members");

/** The pushed screens. */
export const categoryHrefs = {
  /** "Categoria" of a channel: pick where it sits. */
  pick: (channelId: string) => `/channel-category?channelId=${encodeURIComponent(channelId)}` as const,
  /** "Nova categoria", taking that channel along when there is one. */
  create: (channelId?: string) =>
    (channelId ? `/channel-category-new?channelId=${encodeURIComponent(channelId)}` : "/channel-category-new") as
      | `/channel-category-new?channelId=${string}`
      | "/channel-category-new",
  /** "Categorias": the order, and each one to rename or delete. */
  manage: "/channel-categories" as const,
  /** One category. */
  edit: (categoryId: string) => `/channel-category-edit?id=${encodeURIComponent(categoryId)}` as const,
};

/** Moves `id` one step up (-1) or down (+1) in `ids`: the id it then sits before (null: the end). */
export function stepBefore(ids: readonly string[], id: string, step: -1 | 1): string | null | undefined {
  const i = ids.indexOf(id);
  const to = i + step;
  if (i < 0 || to < 0 || to >= ids.length) return undefined;
  const rest = ids.filter((x) => x !== id);
  return rest[to] ?? null;
}
