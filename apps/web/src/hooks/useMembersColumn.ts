import { useCallback, useState } from "react";
import { COMPACT_QUERY, DESKTOP_QUERY, useMediaQuery } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * A channel's members, as the header's toggle shows them: a column on the right (open by default on a desktop,
 * closed on a tablet; the person's last choice in this workspace wins), or on a phone a sheet over the channel.
 */
export function useMembersColumn() {
  const { org, me } = useOrg();
  const compact = useMediaQuery(COMPACT_QUERY);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const key = `${STORAGE_KEYS.membersColumn}.${me.user.id}.${org.id}`;
  // The key in the state: another workspace or person reads its own choice.
  const [saved, setSaved] = useState(() => ({ key, value: storage.get(key) }));
  const value = saved.key === key ? saved.value : storage.get(key);
  const column = !compact && (value === null ? desktop : value === "1");
  const [sheet, setSheet] = useState(false);
  const toggle = useCallback(() => {
    if (compact) return setSheet((open) => !open);
    const next = column ? "0" : "1";
    storage.set(key, next);
    setSaved({ key, value: next });
  }, [compact, column, key]);
  const closeSheet = useCallback(() => setSheet(false), []);
  return { open: compact ? sheet : column, column, sheet: compact && sheet, toggle, closeSheet };
}
