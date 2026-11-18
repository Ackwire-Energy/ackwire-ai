import {
  chipFitsDm,
  DM_SEARCH_OPS,
  inDmOnly,
  parseSearch,
  searchChipKey,
} from "@agenteschat/client/lib/search-filters";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button } from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { SearchBox } from "@/components/search/SearchBox";
import { useMatchMedia } from "@/hooks/useMatchMedia";
import { DM_SIDE_NARROW_QUERY } from "@/hooks/useMembersColumn";
import { useModalSheet } from "@/hooks/useModalSheet";
import { useHeaderSearch } from "@/hooks/useWorkspaceSearch";

/**
 * The conversation header's search (Discord's): an icon that opens, in place, a field whose mini menu offers the
 * filters and recent searches; Enter shows the results in the panel (`onOpen`). The field closes back to its icon on
 * Escape or when the focus leaves it with nothing in it, and stays while it holds words or a filter, or while its
 * results show (`searching`). On a phone the icon opens the search over the whole screen. It starts in the channel it
 * sits in (an `in:` chip the person may remove). In a DM (`dm`) it stays in the DM: no chip to remove, no who or where
 * to filter by, recent searches only those that fit it.
 */
export function HeaderSearch({
  channelId,
  onOpen,
  searching = false,
  dm,
}: {
  channelId: string;
  onOpen: () => void;
  searching?: boolean;
  dm?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const ws = useHeaderSearch();
  const phone = useMatchMedia(COMPACT_QUERY);
  const narrow = useMatchMedia(DM_SIDE_NARROW_QUERY);
  const [sheet, setSheet] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const icon = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  /** Where the focus goes once the field or its icon is on the page. */
  const focusNext = useRef<"field" | "icon" | null>(null);
  useEffect(() => {
    if (!ws) return;
    ws.field.current = {
      focus: () => {
        if (phone) return setSheet(true);
        if (input.current) return input.current.focus();
        focusNext.current = "field";
        setOpen(true);
      },
    };
    return () => {
      ws.field.current = null;
    };
  });
  const place = ws?.placeOf(channelId);
  // On arriving in a channel, an empty search (or one only scoped to another place) is scoped here; a removed chip
  // stays removed while the person stays.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per channel, not on every edit of the search.
  useEffect(() => {
    if (!ws || !place || ws.input.trim()) return;
    const only = ws.chips.length === 1 ? ws.chips[0] : undefined;
    if (ws.chips.length === 0 || (only?.op === "in" && only.place.id !== place.id)) ws.setChips([{ op: "in", place }]);
  }, [place?.id]);
  // A DM's search always holds to it, whatever was searched before or picked from the recent ones; results brought
  // here by "Ir para" keep their own scope until they close, or the next hit would be gone.
  const carried = ws?.carry.current?.channelId === channelId;
  const held = dm && ws && place && !carried ? inDmOnly(ws.chips, place) : null;
  const heldKey = held?.map(searchChipKey).join(" ");
  useEffect(() => {
    if (ws && held && heldKey !== ws.chips.map(searchChipKey).join(" ")) ws.setChips(held);
  });
  const shownChips = (held ? held.slice(1) : ws?.chips) ?? [];
  // The `in:` chip it starts with is where it is, not something the person put in it.
  const holds =
    Boolean(ws?.input.trim()) || shownChips.some((c) => !(c.op === "in" && c.place.id === place?.id)) || searching;
  const field = open || holds;
  // Its results can close, or its words go, while the focus is elsewhere: no blur is left to close it then.
  useEffect(() => {
    if (holds) setOpen(true);
    else if (!input.current?.closest(".search-box")?.contains(document.activeElement)) setOpen(false);
  }, [holds]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the field or its icon replaces the other.
  useEffect(() => {
    const to = focusNext.current;
    if (!to) return;
    focusNext.current = null;
    (to === "field" ? input : icon).current?.focus();
  }, [field]);
  if (!ws) return null;
  const close = (refocus: boolean) => {
    if (holds) return;
    if (refocus) focusNext.current = "icon";
    setOpen(false);
  };
  const submit = () => {
    if (!ws.chips.length && !ws.input.trim()) return;
    ws.remember();
    setSheet(false);
    onOpen();
  };
  const box = (sheetBox: boolean) => (
    <SearchBox
      compact
      className="channel__search"
      inputRef={sheetBox ? undefined : input}
      autoFocus={sheetBox}
      // A personal workspace's name ("Personal") says nothing here: its own words, without it (ADR 0159).
      placeholder={
        dm
          ? t(narrow ? "searchPage.label" : "searchPage.searchHere")
          : t(modeKey(org, "searchPage.header.placeholder"), { org: org.name })
      }
      chips={held ? held.slice(1) : ws.chips}
      onChipsChange={held && place ? (chips) => ws.setChips(inDmOnly(chips, place)) : ws.setChips}
      ops={dm ? DM_SEARCH_OPS : undefined}
      text={ws.input}
      onTextChange={ws.setInput}
      onSubmit={submit}
      onClear={ws.clear}
      directory={ws.directory}
      words={ws.words}
      recent={
        dm && place
          ? ws.recent.filter((r) => parseSearch(r, ws.directory, ws.words).chips.every((c) => chipFitsDm(c, place.id)))
          : ws.recent
      }
      onPickRecent={ws.pickRecent}
      onClearRecent={() => ws.saveRecent([])}
      {...(sheetBox ? {} : { onEscape: () => close(true), onLeave: () => close(false) })}
    />
  );
  const label = t("searchPage.label");
  return (
    <>
      {(phone || !field) && (
        <Button
          ref={icon}
          variant="ghost"
          iconOnly
          icon="search"
          aria-label={label}
          className="channel__icon channel__search-icon"
          onClick={() => {
            if (phone) return setSheet(true);
            focusNext.current = "field";
            setOpen(true);
          }}
        />
      )}
      {!phone && field && box(false)}
      {phone && sheet && <SearchSheet label={label} onClose={() => setSheet(false)} box={box(true)} />}
    </>
  );
}

/** The phone's search over the whole screen: a dialog, Esc or Back closes it (a menu open in it closes first). */
function SearchSheet({ label, onClose, box }: { label: string; onClose: () => void; box: ReactNode }) {
  const { t } = useTranslation();
  const sheet = useRef<HTMLElement>(null);
  useModalSheet(sheet);
  return (
    <section
      ref={sheet}
      className="search-sheet"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
    >
      <header className="search-sheet__head">
        <Button variant="ghost" iconOnly icon="chevronLeft" aria-label={t("common.back")} onClick={onClose} />
        {box}
      </header>
    </section>
  );
}
