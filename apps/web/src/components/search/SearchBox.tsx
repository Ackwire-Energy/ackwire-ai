import {
  dedupe,
  parseSearch,
  SEARCH_HAS,
  SEARCH_OPS,
  type SearchChip,
  type SearchDirectory,
  type SearchOp,
  type SearchWords,
  searchChipKey,
  searchChipLabel,
  suggestActors,
  suggestPlaces,
  typingOperator,
} from "@agenteschat/client/lib/search-filters";
import { Icon, Token } from "@agenteschat/ui";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import "./search.css";

interface Option {
  key: string;
  label: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  group?: string;
  pick: () => void;
}

/** The ones the empty box offers first; the rest under "Mais filtros". */
const MAIN_OPS: SearchOp[] = ["from", "in", "has", "mentions"];
const DATE_OPS = new Set<SearchOp>(["before", "after", "during"]);

/**
 * The search box with filters (ADR 0123): chips inside the field, the options and recent searches while it is
 * empty, and a picker for the operator being typed (`from:` people and agents with their faces, `in:` channels and
 * DMs, `has:` kinds, dates). Space or Enter turns typed operators into chips; Backspace on an empty box removes
 * the last chip.
 */
export function SearchBox({
  chips,
  onChipsChange,
  text,
  onTextChange,
  onSubmit,
  directory,
  words,
  recent,
  onPickRecent,
  onClearRecent,
}: {
  chips: SearchChip[];
  onChipsChange: (chips: SearchChip[]) => void;
  text: string;
  onTextChange: (text: string) => void;
  /** Enter with nothing picked: the search is worth remembering. */
  onSubmit: () => void;
  directory: SearchDirectory;
  words: SearchWords;
  recent: string[];
  onPickRecent: (search: string) => void;
  onClearRecent: () => void;
}) {
  const { t, i18n } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  // -1: nothing highlighted yet (an operator being typed still highlights its first option).
  const [active, setActive] = useState(-1);

  const addChip = (chip: SearchChip, rest: string) => {
    onChipsChange(dedupe([...chips, chip]));
    onTextChange(rest);
    setActive(-1);
    input.current?.focus();
  };
  const typing = typingOperator(text, words);
  // What the box holds before the operator being typed.
  const before = typing ? text.slice(0, typing.start).trimEnd() : text;
  const withSpace = (s: string) => (s ? `${s} ` : "");
  const insertOp = (op: SearchOp) => {
    onTextChange(`${withSpace(text.trimEnd())}${words.ops[op]}:`);
    setActive(-1);
    input.current?.focus();
  };

  const options: Option[] = [];
  if (typing) {
    const op = typing.op;
    if (op === "from" || op === "mentions") {
      for (const a of suggestActors(typing.value, directory.actors)) {
        options.push({
          key: `${a.type}:${a.id}`,
          label: a.name,
          description: a.handle ? `@${a.handle}` : undefined,
          leading: <ActorAvatar actor={a} name={a.name} size="xs" />,
          pick: () => addChip({ op, actor: a }, withSpace(before)),
        });
      }
    } else if (op === "in") {
      for (const p of suggestPlaces(typing.value, directory.places)) {
        options.push({
          key: p.id,
          label: p.dm ? t("searchPage.dm", { name: p.name }) : `#${p.name}`,
          leading: <Icon name={p.dm ? "message" : "channel"} size={16} />,
          pick: () => addChip({ op, place: p }, withSpace(before)),
        });
      }
    } else if (op === "has") {
      for (const h of SEARCH_HAS) {
        options.push({
          key: h,
          label: t(`searchPage.hasLabel.${h}`),
          description: `${words.ops.has}:${words.has[h]}`,
          pick: () => addChip({ op, value: h }, withSpace(before)),
        });
      }
    } else if (op === "author") {
      for (const a of ["person", "agent"] as const) {
        options.push({
          key: a,
          label: t(`searchPage.authorLabel.${a}`),
          description: `${words.ops.author}:${words.author[a]}`,
          pick: () => addChip({ op, value: a }, withSpace(before)),
        });
      }
    } else if (op === "pinned") {
      options.push({
        key: "pinned",
        label: t("searchPage.pinnedChip"),
        leading: <Icon name="pin" size={16} />,
        pick: () => addChip({ op }, withSpace(before)),
      });
    }
  } else if (!text.trim()) {
    for (const op of SEARCH_OPS) {
      options.push({
        key: op,
        label: `${words.ops[op]}:`,
        description: t(`searchPage.option.${op}`),
        group: MAIN_OPS.includes(op) ? t("searchPage.options") : t("searchPage.moreFilters"),
        pick: () => insertOp(op),
      });
    }
    for (const r of recent) {
      options.push({
        key: `recent:${r}`,
        label: r,
        leading: <Icon name="clock" size={16} />,
        group: t("searchPage.recent"),
        pick: () => onPickRecent(r),
      });
    }
  }
  const shown = open && (options.length > 0 || typing !== null);
  const current = Math.min(typing ? Math.max(active, 0) : active, options.length - 1);

  const commit = (value: string) => {
    // Complete operators become chips once a space follows them.
    if (!/\s$/.test(value)) return onTextChange(value);
    const parsed = parseSearch(value, directory, words);
    if (parsed.chips.length === 0) return onTextChange(value);
    onChipsChange(dedupe([...chips, ...parsed.chips]));
    onTextChange(withSpace(parsed.text));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && shown && options.length) {
      e.preventDefault();
      setActive((current + 1) % options.length);
    } else if (e.key === "ArrowUp" && shown && options.length) {
      e.preventDefault();
      setActive(current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = shown && current >= 0 ? options[current] : undefined;
      if (option) return option.pick();
      const parsed = parseSearch(text, directory, words);
      if (parsed.chips.length) {
        onChipsChange(dedupe([...chips, ...parsed.chips]));
        onTextChange(parsed.text);
      }
      setOpen(false);
      onSubmit();
    } else if (e.key === "Escape" && shown) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Backspace" && !text && chips.length) {
      onChipsChange(chips.slice(0, -1));
    }
  };

  let lastGroup: string | undefined;
  return (
    <search
      className="search-box"
      // Closes when the focus leaves the box and its menu (the date field inside the menu keeps it open).
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the field's padding focuses its input. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keys. */}
      <div className="search-box__field" onClick={() => input.current?.focus()}>
        <Icon name="search" size={16} className="search-box__icon" />
        {chips.map((c) => {
          const label = searchChipLabel(t, i18n.language, c);
          return (
            <Token
              key={searchChipKey(c)}
              removeLabel={t("searchPage.removeFilter", { filter: label })}
              onRemove={() => onChipsChange(chips.filter((x) => searchChipKey(x) !== searchChipKey(c)))}
            >
              {label}
            </Token>
          );
        })}
        <input
          ref={input}
          className="search-box__input"
          type="search"
          role="combobox"
          aria-label={t("searchPage.label")}
          aria-expanded={Boolean(shown)}
          aria-controls={listId}
          aria-activedescendant={shown && current >= 0 ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          // biome-ignore lint/a11y/noAutofocus: the search page is for typing.
          autoFocus
          placeholder={chips.length ? "" : t("searchPage.placeholder")}
          value={text}
          onChange={(e) => {
            commit(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>
      {shown && (
        <div className="ac-menu search-box__menu" role="listbox" id={listId} aria-label={t("searchPage.options")}>
          {typing && DATE_OPS.has(typing.op) && (
            <label className="search-box__date">
              <span className="small muted">{t("searchPage.pickDate")}</span>
              <input
                type="date"
                onChange={(e) => {
                  if (e.target.value) addChip({ op: typing.op as "before", value: e.target.value }, withSpace(before));
                }}
              />
            </label>
          )}
          {typing && !DATE_OPS.has(typing.op) && options.length === 0 && (
            <p className="search-box__none small muted">
              {typing.op === "in" ? t("searchPage.noPlace") : t("searchPage.noMatch")}
            </p>
          )}
          {options.map((o, i) => {
            const heading = o.group && o.group !== lastGroup;
            lastGroup = o.group;
            return (
              <div key={o.key} role="presentation">
                {heading && (
                  <div className="ac-menu__heading search-box__heading" role="presentation">
                    <span>{o.group}</span>
                    {o.group === t("searchPage.recent") && (
                      <button
                        type="button"
                        className="search-box__clear"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={onClearRecent}
                      >
                        {t("searchPage.clearRecent")}
                      </button>
                    )}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === current}
                  data-active={i === current || undefined}
                  className="ac-menu__item ac-suggest__item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={o.pick}
                  onKeyDown={() => {}}
                >
                  {o.leading}
                  <span className="ac-menu__label">
                    <span>{o.label}</span>
                    {o.description && <span className="ac-menu__desc">{o.description}</span>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </search>
  );
}
