import { Button } from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { SearchBox } from "@/components/search/SearchBox";
import { useMatchMedia } from "@/hooks/useMatchMedia";
import { useModalSheet } from "@/hooks/useModalSheet";
import { useHeaderSearch } from "@/hooks/useWorkspaceSearch";

/**
 * The channel header's search (Discord's): a field whose mini menu offers the filters and recent searches, Enter
 * shows the results in the panel (`onOpen`). On a phone, an icon that opens the search over the whole screen.
 */
export function HeaderSearch({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const ws = useHeaderSearch();
  const phone = useMatchMedia(COMPACT_QUERY);
  const [sheet, setSheet] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!ws) return;
    ws.field.current = { focus: () => (phone ? setSheet(true) : input.current?.focus()) };
    return () => {
      ws.field.current = null;
    };
  });
  if (!ws) return null;
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
      placeholder={t("searchPage.header.placeholder", { org: org.name })}
      chips={ws.chips}
      onChipsChange={ws.setChips}
      text={ws.input}
      onTextChange={ws.setInput}
      onSubmit={submit}
      onClear={ws.clear}
      directory={ws.directory}
      words={ws.words}
      recent={ws.recent}
      onPickRecent={ws.pickRecent}
      onClearRecent={() => ws.saveRecent([])}
    />
  );
  const label = t("searchPage.label");
  return (
    <>
      <Button
        variant="ghost"
        iconOnly
        icon="search"
        aria-label={label}
        title={label}
        className="channel__icon channel__search-icon"
        onClick={() => setSheet(true)}
      />
      {!phone && box(false)}
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
