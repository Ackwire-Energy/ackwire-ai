import { Popover as RPopover } from "radix-ui";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import { Icon } from "../icons/Icon";
import { filterZones, type ZoneOption, type ZoneRegion, zoneOption, zoneOptions } from "../timezones";
import { useFieldControl } from "./Field";

export interface TimezoneSelectLabels {
  /** Accessible name of the search field ("Buscar fuso"). */
  search: string;
  searchPlaceholder: string;
  /** "Sugeridos", "América", "Europa"… */
  groups: Record<ZoneRegion, string>;
  noResults: string;
  /** Accessible name of the list ("Fusos horários"). */
  list: string;
}

export interface TimezoneSelectProps {
  value: string;
  onChange: (zone: string) => void;
  labels: TimezoneSelectLabels;
  /** Friendly names ("Horário de Brasília"); the city otherwise. */
  nameOf?: (zone: string) => string | undefined;
  /** Shown first: my zone, the org's, the people's, UTC. */
  suggested?: string[];
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

/**
 * Our time zone selector: the trigger says "Horário de Brasília · UTC−3";
 * the glass dropdown has a search (city, country, IANA id or offset like
 * "-3") over every zone, "Sugeridos" first and the rest by region, each row
 * with its friendly name, the IANA id and the live offset. Combobox
 * semantics, arrows / Home / End / Enter / Esc, `aria-activedescendant`.
 */
export function TimezoneSelect({
  value,
  onChange,
  labels,
  nameOf,
  suggested = [],
  id,
  disabled,
  className,
  ...rest
}: TimezoneSelectProps) {
  const wiring = useFieldControl({ id });
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const suggestedKey = suggested.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lists only change with the suggestions (names are stable)
  const all = useMemo(() => (open ? zoneOptions(suggested, nameOf) : null), [open, suggestedKey]);
  const current = useMemo(() => zoneOption(value || "UTC", nameOf), [value, nameOf]);
  const groups = useMemo(() => {
    if (!all) return [] as [ZoneRegion, ZoneOption[]][];
    const out: [ZoneRegion, ZoneOption[]][] = [];
    const top = filterZones(all.suggested, query);
    if (top.length) out.push(["suggested", top]);
    for (const o of filterZones(all.rest, query)) {
      const last = out[out.length - 1];
      if (last && last[0] === o.region) last[1].push(o);
      else out.push([o.region, [o]]);
    }
    return out;
  }, [all, query]);
  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);
  const optionId = (i: number) => `${listId}-o${i}`;

  // Opening starts on the current zone; typing goes back to the first match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const i = (all ? [...all.suggested, ...all.rest] : []).findIndex((o) => o.zone === value);
    setActive(Math.max(0, i));
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  const pick = (o: ZoneOption | undefined) => {
    if (!o) return;
    onChange(o.zone);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = flat.length - 1;
    if (e.key === "ArrowDown") setActive((a) => Math.min(last, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "PageDown") setActive((a) => Math.min(last, a + 10));
    else if (e.key === "PageUp") setActive((a) => Math.max(0, a - 10));
    else if (e.key === "Enter") pick(flat[active]);
    else return;
    e.preventDefault();
  };

  let index = -1;
  return (
    <div className={cx("ac-select ac-tz", className)}>
      <RPopover.Root open={open} onOpenChange={setOpen}>
        <RPopover.Trigger asChild disabled={disabled}>
          <button
            type="button"
            className="ac-select__trigger"
            id={wiring.id}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={rest["aria-label"]}
            aria-describedby={wiring["aria-describedby"]}
            aria-invalid={wiring["aria-invalid"]}
          >
            <span className="ac-select__value">
              {current.name} <span className="ac-tz__offset">· {current.offsetLabel}</span>
            </span>
            <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>
        </RPopover.Trigger>
        <RPopover.Portal>
          <RPopover.Content className="ac-menu ac-tz__menu" align="start" sideOffset={4}>
            <div className="ac-tz__searchrow">
              <Icon name="search" size={16} className="ac-tz__searchicon" />
              <input
                className="ac-tz__search"
                role="combobox"
                aria-label={labels.search}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={flat.length ? optionId(active) : undefined}
                placeholder={labels.searchPlaceholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
            </div>
            <div className="ac-tz__list" role="listbox" id={listId} aria-label={labels.list} ref={listRef}>
              {flat.length === 0 && <p className="ac-tz__empty">{labels.noResults}</p>}
              {groups.map(([region, list]) => (
                // biome-ignore lint/a11y/useSemanticElements: a listbox group
                <div key={region} role="group" aria-label={labels.groups[region]}>
                  <div className="ac-menu__heading" aria-hidden="true">
                    {labels.groups[region]}
                  </div>
                  {list.map((o) => {
                    index += 1;
                    const i = index;
                    return (
                      // biome-ignore lint/a11y/useFocusableInteractive: options are reached through aria-activedescendant
                      // biome-ignore lint/a11y/useKeyWithClickEvents: the search field handles the keys
                      <div
                        key={`${region}:${o.zone}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={o.zone === value}
                        data-active={i === active || undefined}
                        className="ac-tz__option"
                        onPointerMove={() => setActive(i)}
                        onClick={() => pick(o)}
                      >
                        <span className="ac-tz__check" aria-hidden="true">
                          {o.zone === value && (
                            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                              <path d="m5.5 10.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" />
                            </svg>
                          )}
                        </span>
                        <span className="ac-tz__name">{o.name}</span>
                        {o.name !== o.zone && <span className="ac-tz__id">{o.zone}</span>}
                        <span className="ac-tz__off tabular">{o.offsetLabel}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </RPopover.Content>
        </RPopover.Portal>
      </RPopover.Root>
    </div>
  );
}
