import { Select as RSelect } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { useFieldControl } from "./Field";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
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
  ...rest
}: SelectProps<V>) {
  const wiring = useFieldControl({ id });
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
            <RSelect.Value placeholder={placeholder} />
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
            aria-label={listLabel ?? rest["aria-label"]}
          >
            <RSelect.Viewport>
              {options.map((o) => (
                <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="ac-menu__item">
                  <svg className="ac-menu__check" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m5.5 10.5 3 3 6-7" />
                  </svg>
                  <span className="ac-menu__label">
                    <RSelect.ItemText>{o.label}</RSelect.ItemText>
                    {o.description && <span className="ac-menu__desc">{o.description}</span>}
                  </span>
                </RSelect.Item>
              ))}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </div>
  );
}
