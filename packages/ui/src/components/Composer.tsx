import { Popover as RPopover } from "radix-ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "../cx";
import { Button } from "./Button";
import { Kbd } from "./Kbd";

/** One "@" suggestion. `insert` is what goes after the "@" (the handle). */
export interface ComposerSuggestion {
  key: string;
  insert: string;
  label: string;
  /** "@ada · Agente · Dev". */
  description?: ReactNode;
  /** A small avatar. */
  leading?: ReactNode;
  /** "não está no canal". */
  note?: string;
  /** Consecutive items with the same group get a heading ("Neste canal", "No workspace"). */
  group?: string;
}

export interface ComposerMentions {
  /** Suggestions for what follows "@", already filtered and ordered. */
  search: (query: string) => ComposerSuggestion[];
  /** After an item was inserted (e.g. offer "Adicionar ao canal"). */
  onPick?: (item: ComposerSuggestion) => void;
  /** Accessible name of the list ("Pessoas e agentes"). */
  listLabel: string;
}

/** A "/" command: picking it runs `onPick` (or puts `insert` in the box). */
export interface ComposerCommand {
  key: string;
  /** "/relatório". */
  label: string;
  /** "Theo monta um documento". */
  description?: ReactNode;
  leading?: ReactNode;
  /** Text that replaces the box (e.g. "/relatório "). Defaults to `${label} `. */
  insert?: string;
  onPick?: () => void;
}

export interface ComposerCommands {
  list: ComposerCommand[];
  /** Accessible name of the menu ("Comandos"). */
  listLabel: string;
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text on Enter (Shift+Enter adds a line) or the send button. */
  onSend: (text: string) => void;
  /** Accessible name of the text box, e.g. "Mensagem para #eng". */
  label: string;
  placeholder?: string;
  sendLabel: string;
  attachLabel?: string;
  onAttach?: () => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Lets the parent focus the box or insert text (e.g. "Chamar um agente"). */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  /** "@" autocomplete (combobox pattern on the text box). */
  mentions?: ComposerMentions;
  /** "/" at the start of the box opens these commands (same combobox). */
  commands?: ComposerCommands;
  /** Context pills under the text (the target agent, the active skill). */
  pills?: ReactNode;
  /** Shown in the send button once there is text ("Enviar"); the key hint follows. */
  sendText?: string;
}

/** "@que" right before the caret (start of text or after a space or bracket). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|[\s(])@([\p{L}\p{N}_-]{0,32})$/u);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** The chat message box: attach on the left, send (primary, icon only) on the right, focus on the whole box. */
export function Composer({
  value,
  onChange,
  onSend,
  label,
  placeholder,
  sendLabel,
  attachLabel,
  onAttach,
  disabled,
  id,
  className,
  textareaRef,
  mentions,
  commands,
  pills,
  sendText,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  useImperativeHandle(textareaRef, () => ref.current as HTMLTextAreaElement, []);
  // The "@…" being typed, and the one the person closed with Esc.
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const caretAfter = useRef<number | null>(null);

  // Grow with the text, up to the CSS max-height; put the caret after an inserted mention.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (caretAfter.current !== null) {
      el.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  }, [value]);

  // "/" commands: only while the box is just "/word" (no space yet).
  const slash = commands ? /^\/(\S*)$/.exec(value) : null;
  const slashItems: ComposerSuggestion[] =
    slash && dismissed !== -1
      ? (commands?.list
          .filter((c) => c.label.toLowerCase().includes((slash[1] ?? "").toLowerCase()))
          .map((c) => ({
            key: c.key,
            insert: c.insert ?? `${c.label} `,
            label: c.label,
            description: c.description,
            leading: c.leading,
          })) ?? [])
      : [];
  const mentionItems = mentions && token && token.start !== dismissed ? mentions.search(token.query) : [];
  const items = slashItems.length > 0 ? slashItems : mentionItems;
  const isSlash = slashItems.length > 0;
  const open = items.length > 0;
  const current = Math.min(active, Math.max(0, items.length - 1));

  const track = (text: string, caret: number) => {
    if (!mentions) return;
    const next = mentionQuery(text, caret);
    if (next?.start !== token?.start || next?.query !== token?.query) {
      setToken(next);
      setActive(0);
    }
    if (dismissed !== null && next?.start !== dismissed) setDismissed(null);
  };

  const pick = (item: ComposerSuggestion) => {
    if (isSlash) {
      const command = commands?.list.find((c) => c.key === item.key);
      caretAfter.current = item.insert.length;
      onChange(item.insert);
      command?.onPick?.();
      return;
    }
    if (!token) return;
    const caret = token.start + 1 + token.query.length;
    const inserted = `@${item.insert} `;
    const next = value.slice(0, token.start) + inserted + value.slice(caret).replace(/^ /, "");
    caretAfter.current = token.start + inserted.length;
    setToken(null);
    onChange(next);
    mentions?.onPick?.(item);
  };

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    // Keep typing: focus stays in the box (also after clicking the send button).
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + items.length) % items.length);
        return;
      }
      const item = items[current];
      // Already typed in full ("oi @ada" + Enter): Enter sends; Tab still completes.
      const typedInFull = item && token && item.insert.toLowerCase() === token.query.toLowerCase();
      if (e.key === "Tab" || (e.key === "Enter" && !typedInFull)) {
        e.preventDefault();
        if (item) pick(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(isSlash ? -1 : (token?.start ?? null));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  const textarea = (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (dismissed === -1 && !e.target.value.startsWith("/")) setDismissed(null);
        onChange(e.target.value);
        track(e.target.value, e.target.selectionStart ?? e.target.value.length);
      }}
      onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
      onKeyDown={onKeyDown}
      {...(mentions || commands
        ? {
            role: "combobox",
            "aria-autocomplete": "list" as const,
            "aria-expanded": open,
            "aria-controls": open ? listId : undefined,
            "aria-activedescendant": open ? optionId(current) : undefined,
          }
        : {})}
    />
  );

  return (
    <RPopover.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && open) setDismissed(isSlash ? -1 : (token?.start ?? null));
      }}
    >
      <RPopover.Anchor asChild>
        <div ref={box} className={cx("ac-composer", className)} data-disabled={disabled || undefined}>
          {textarea}
          <div className="ac-composer__tools">
            {pills && <div className="ac-composer__pills">{pills}</div>}
            {attachLabel && (
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                icon="attach"
                aria-label={attachLabel}
                onClick={onAttach}
                disabled={!onAttach}
              />
            )}
            {/* Grows from a dim square into "Enviar ↵" once there is text. */}
            <button
              type="button"
              className="ac-composer__send"
              data-ready={value.trim() && !disabled ? "" : undefined}
              aria-label={sendLabel}
              onClick={send}
              disabled={disabled || !value.trim()}
            >
              {sendText && value.trim() && !disabled && (
                <span className="ac-composer__send-text" aria-hidden="true">
                  {sendText}
                  <Kbd>↵</Kbd>
                </span>
              )}
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      </RPopover.Anchor>
      {(mentions || commands) && (
        <RPopover.Portal>
          <RPopover.Content
            className={cx("ac-menu ac-suggest", isSlash && "ac-suggest--commands")}
            side="top"
            align="start"
            sideOffset={6}
            // Focus stays in the text box (combobox).
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              if (e.target instanceof Node && box.current?.contains(e.target)) e.preventDefault();
            }}
          >
            <div
              role="listbox"
              id={listId}
              aria-label={isSlash ? (commands?.listLabel ?? "") : (mentions?.listLabel ?? "")}
            >
              {items.map((item, i) => {
                const heading = item.group && item.group !== items[i - 1]?.group;
                return (
                  <div key={item.key} role="presentation">
                    {heading && (
                      <div className="ac-menu__heading" role="presentation">
                        {item.group}
                      </div>
                    )}
                    <div
                      id={optionId(i)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === current}
                      data-active={i === current || undefined}
                      className="ac-menu__item ac-suggest__item"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        pick(item);
                      }}
                      onClick={() => pick(item)}
                      onKeyDown={() => {}}
                    >
                      {item.leading}
                      <span className="ac-menu__label">
                        <span>{item.label}</span>
                        {item.description && <span className="ac-menu__desc">{item.description}</span>}
                      </span>
                      {item.note && <span className="ac-suggest__note">{item.note}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </RPopover.Content>
        </RPopover.Portal>
      )}
    </RPopover.Root>
  );
}
