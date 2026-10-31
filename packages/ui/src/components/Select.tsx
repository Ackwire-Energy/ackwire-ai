import { Select as RSelect } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { useFieldControl } from "./Field";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Consecutive options with the same group get a heading (e.g. the model provider). */
  group?: string;
  /** Something before the label in the list (a person's avatar, an icon). */
  leading?: ReactNode;
}

export interface SelectProps<V extends string = string> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: SelectOption<V>[];
  /** Taken from the surrounding `Field` when omitted. */
  id?: string;
  "aria-label"?: string;
  placeholder?: string;
  size?: "md" | "sm";
  disabled?: boolean;
  className?: string;
  /** Accessible name of the listbox; defaults to `aria-label`. */
  listLabel?: string;
  /** What the trigger shows for the chosen option (default: its label), e.g. a card with an avatar. */
  renderValue?: (option: SelectOption<V>) => ReactNode;
  /**
   * The trigger's edge a list wider than the trigger lines up with: `end` for a select that ends its row, so the
   * list keeps the row's edge.
   */
  align?: "start" | "end";
  /** The list closed and focus goes back to the trigger (`preventDefault()` keeps it where it is). */
  onCloseAutoFocus?: (event: Event) => void;
}

function renderItem<V extends string>(o: SelectOption<V>) {
  return (
    // The chosen option shows by its background (no check column, so every row lines up).
    <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="ac-menu__item">
      {o.leading && (
        <span className="ac-menu__leading" aria-hidden="true">
          {o.leading}
        </span>
      )}
      <span className="ac-menu__label">
        <RSelect.ItemText>{o.label}</RSelect.ItemText>
        {o.description && <span className="ac-menu__desc">{o.description}</span>}
      </span>
    </RSelect.Item>
  );
}

/** Runs of consecutive options by `group` (ungrouped ones keep their place). */
function groupOptions<V extends string>(options: SelectOption<V>[]) {
  const out: [string | undefined, SelectOption<V>[]][] = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && last[0] === o.group) last[1].push(o);
    else out.push([o.group, [o]]);
  }
  return out;
}

/**
 * One choice from a short list. Our own trigger and listbox (Radix Select for
 * keyboard, focus and screen readers), never the native `<select>`. For more
 * than ~12 options use a searchable list in a Dialog.
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  id,
  placeholder,
  size = "md",
  disabled,
  className,
  listLabel,
  renderValue,
  align = "start",
  onCloseAutoFocus,
  ...rest
}: SelectProps<V>) {
  const wiring = useFieldControl({ id });
  const chosen = renderValue ? options.find((o) => o.value === value) : undefined;
  return (
    <div className={cx("ac-select", size === "sm" && "ac-select--sm", className)}>
      <RSelect.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
        <RSelect.Trigger
          className="ac-select__trigger"
          id={wiring.id}
          aria-label={rest["aria-label"]}
          aria-describedby={wiring["aria-describedby"]}
          aria-invalid={wiring["aria-invalid"]}
        >
          <span className="ac-select__value">
            <RSelect.Value placeholder={placeholder}>
              {chosen && renderValue ? renderValue(chosen) : undefined}
            </RSelect.Value>
          </span>
          <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 8 4 4 4-4" />
          </svg>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content
            className="ac-menu ac-menu--select"
            position="popper"
            sideOffset={4}
            align={align}
            aria-label={listLabel ?? rest["aria-label"]}
            onCloseAutoFocus={onCloseAutoFocus}
          >
            <RSelect.Viewport>
              {groupOptions(options).map(([group, items]) =>
                group ? (
                  <RSelect.Group key={group}>
                    <RSelect.Label className="ac-menu__heading">{group}</RSelect.Label>
                    {items.map(renderItem)}
                  </RSelect.Group>
                ) : (
                  items.map(renderItem)
                ),
              )}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </div>
  );
}
