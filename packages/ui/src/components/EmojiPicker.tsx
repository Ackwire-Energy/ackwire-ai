import { Popover as RPopover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import {
  EMOJI_CATEGORIES,
  EMOJIS,
  type EmojiCategoryId,
  type EmojiEntry,
  emojiEntry,
  searchEmoji,
} from "../emoji-data";
import { Icon } from "../icons/Icon";

export interface EmojiPickerLabels {
  /** Accessible name of the picker ("Emojis"). */
  dialog: string;
  /** Search box label and placeholder ("Buscar emoji"). */
  search: string;
  /** "Nenhum emoji encontrado". */
  noResults: string;
  /** "Usados recentemente". */
  recent: string;
  /** "Resultados". */
  results: string;
  categories: Record<EmojiCategoryId, string>;
}

/** Emoji per row in the grid (arrow keys move by this much up and down). */
export const EMOJI_COLUMNS = 8;
const RECENT_KEY = "agentes:emoji-recent";
const RECENT_MAX = 16;

/** The last emoji picked here (this browser), newest first; empty when storage is off. */
export function readRecentEmoji(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string) {
  try {
    const next = [emoji, ...readRecentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage blocked: recents just aren't kept.
  }
}

interface Section {
  id: string;
  label: string;
  items: EmojiEntry[];
}

const chunk = <T,>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/**
 * The emoji panel: a search box, category tabs, and the emoji in grids
 * (one per category, "recently used" first). Arrow keys move in the grid,
 * Home/End jump to the row's ends, Enter picks; ArrowDown from the search
 * box enters the grid.
 */
export function EmojiPicker({
  labels,
  onPick,
  className,
}: {
  labels: EmojiPickerLabels;
  onPick: (emoji: string) => void;
  className?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [recent] = useState(readRecentEmoji);
  const [active, setActive] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const sections: Section[] = useMemo(() => {
    if (query.trim()) return [{ id: "results", label: labels.results, items: searchEmoji(query) }];
    const recentItems = recent.flatMap((e) => {
      const entry = emojiEntry(e);
      return entry ? [entry] : [];
    });
    return [
      ...(recentItems.length > 0 ? [{ id: "recent", label: labels.recent, items: recentItems }] : []),
      ...EMOJI_CATEGORIES.map((c) => ({
        id: c,
        label: labels.categories[c],
        items: EMOJIS.filter((e) => e.category === c),
      })),
    ];
  }, [query, recent, labels]);

  // Rows across every section, each cell with its flat index (for roving focus).
  const layout = useMemo(() => {
    let n = 0;
    const rows: { section: string; cells: { entry: EmojiEntry; index: number }[] }[] = [];
    for (const s of sections) {
      for (const row of chunk(s.items, EMOJI_COLUMNS)) {
        rows.push({ section: s.id, cells: row.map((entry) => ({ entry, index: n++ })) });
      }
    }
    return { rows, count: n };
  }, [sections]);
  const current = Math.min(active, Math.max(0, layout.count - 1));

  const focusCell = (index: number) => {
    setActive(index);
    grid.current?.querySelector<HTMLButtonElement>(`[data-index="${index}"]`)?.focus();
    grid.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  };

  const pick = (emoji: string) => {
    rememberEmoji(emoji);
    onPick(emoji);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = layout.rows.findIndex((row) => row.cells.some((c) => c.index === current));
    const row = layout.rows[r];
    if (!row) return;
    const col = row.cells.findIndex((c) => c.index === current);
    const at = (ri: number, ci: number) => {
      const target = layout.rows[ri];
      return target ? (target.cells[Math.min(ci, target.cells.length - 1)]?.index ?? null) : null;
    };
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(current + 1, layout.count - 1);
    else if (e.key === "ArrowLeft") next = Math.max(current - 1, 0);
    else if (e.key === "ArrowDown") next = at(r + 1, col);
    else if (e.key === "ArrowUp") {
      if (r === 0) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      next = at(r - 1, col);
    } else if (e.key === "Home") next = e.ctrlKey ? 0 : (row.cells[0]?.index ?? null);
    else if (e.key === "End") next = e.ctrlKey ? layout.count - 1 : (row.cells.at(-1)?.index ?? null);
    else return;
    e.preventDefault();
    if (next !== null) focusCell(next);
  };

  const jumpTo = (section: string) => {
    setQuery("");
    const first = layout.rows.find((row) => row.section === section)?.cells[0]?.index;
    requestAnimationFrame(() => {
      const heading = grid.current?.querySelector<HTMLElement>(`[data-section="${section}"]`);
      heading?.scrollIntoView?.({ block: "start" });
      if (first !== undefined) setActive(first);
    });
  };

  return (
    <div className={cx("ac-emoji", className)}>
      <div className="ac-emoji__search">
        <Icon name="search" size={16} />
        <input
          ref={search}
          type="search"
          aria-label={labels.search}
          placeholder={labels.search}
          value={query}
          // biome-ignore lint/a11y/noAutofocus: the picker opens to search
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && layout.count > 0) {
              e.preventDefault();
              focusCell(0);
            } else if (e.key === "Enter" && query.trim()) {
              e.preventDefault();
              const first = layout.rows[0]?.cells[0]?.entry;
              if (first) pick(first.emoji);
            }
          }}
        />
      </div>
      {!query.trim() && (
        <div className="ac-emoji__tabs">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className="ac-emoji__tab"
              aria-label={labels.categories[c]}
              title={labels.categories[c]}
              tabIndex={-1}
              onClick={() => jumpTo(c)}
            >
              <span aria-hidden="true">{EMOJIS.find((e) => e.category === c)?.emoji}</span>
            </button>
          ))}
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the emoji buttons of every grid */}
      <div className="ac-emoji__scroll" ref={grid} onKeyDown={onGridKey}>
        {layout.count === 0 && (
          <p className="ac-emoji__empty" role="status">
            {labels.noResults}
          </p>
        )}
        {sections.map((s) =>
          s.items.length === 0 ? null : (
            <div key={s.id} className="ac-emoji__section">
              <div className="ac-emoji__heading" id={`${id}-${s.id}`} data-section={s.id}>
                {s.label}
              </div>
              {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the ARIA grid pattern (arrow keys move between cells) */}
              <table role="grid" aria-labelledby={`${id}-${s.id}`} className="ac-emoji__grid">
                <tbody>
                  {layout.rows
                    .filter((row) => row.section === s.id)
                    .map((row) => (
                      <tr key={row.cells[0]?.index}>
                        {row.cells.map(({ entry, index }) => (
                          <td key={`${s.id}-${entry.emoji}`}>
                            <button
                              type="button"
                              className="ac-emoji__cell"
                              data-index={index}
                              tabIndex={index === current ? 0 : -1}
                              aria-label={entry.name}
                              title={entry.name}
                              onFocus={() => setActive(index)}
                              onClick={() => pick(entry.emoji)}
                            >
                              {entry.emoji}
                            </button>
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The picker in a glass popover from `trigger` (Radix: Esc closes, focus
 * returns to the trigger unless `onCloseAutoFocus` takes it elsewhere).
 * Closes after a pick.
 */
export function EmojiPickerPopover({
  trigger,
  labels,
  onPick,
  side = "top",
  align = "end",
  open: controlled,
  onOpenChange,
  onCloseAutoFocus,
}: {
  /** A focusable element with an accessible name ("Reagir"). */
  trigger: ReactNode;
  labels: EmojiPickerLabels;
  onPick: (emoji: string) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (o: boolean) => {
    setOwn(o);
    onOpenChange?.(o);
  };
  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          className="ac-menu ac-emoji-popover"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={16}
          role="dialog"
          aria-label={labels.dialog}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {open && (
            <EmojiPicker
              labels={labels}
              onPick={(emoji) => {
                onPick(emoji);
                setOpen(false);
              }}
            />
          )}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
