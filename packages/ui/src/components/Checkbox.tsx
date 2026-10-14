import { Checkbox as RCheckbox, RadioGroup as RRadioGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "../cx";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/** Our checkbox (Radix Checkbox: a `role="checkbox"` button, Space toggles). Pair it with a `<label htmlFor>`. */
export function Checkbox({ checked, onCheckedChange, className, ...rest }: CheckboxProps) {
  return (
    <RCheckbox.Root
      className={cx("ac-check", className)}
      checked={checked}
      onCheckedChange={(v) => onCheckedChange?.(v === true)}
      {...rest}
    >
      <RCheckbox.Indicator className="ac-check__mark" />
    </RCheckbox.Root>
  );
}

export interface CheckboxPillProps extends CheckboxProps {
  id: string;
  children: ReactNode;
}

/** A labelled checkbox shaped as a pill (e.g. "#eng", "GitHub: ler e abrir PRs"). */
export function CheckboxPill({ id, checked, onCheckedChange, disabled, children, className }: CheckboxPillProps) {
  return (
    <label htmlFor={id} className={cx("ac-pill", className)} data-checked={checked}>
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      <span>{children}</span>
    </label>
  );
}

export interface RadioGroupProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}

/** Radio group (Radix: arrow keys move and select, one tab stop). */
export function RadioGroup<V extends string>({ value, onValueChange, className, ...rest }: RadioGroupProps<V>) {
  return (
    <RRadioGroup.Root className={className} value={value} onValueChange={(v) => onValueChange(v as V)} {...rest} />
  );
}

export function Radio({
  value,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <RRadioGroup.Item
      value={value}
      id={id}
      disabled={disabled}
      className={cx("ac-radio", className)}
      aria-label={ariaLabel}
    >
      <RRadioGroup.Indicator className="ac-radio__dot" />
    </RRadioGroup.Item>
  );
}

/** A card with a radio, a title and a description (onboarding key choice). */
export function RadioCard({
  value,
  id,
  checked,
  title,
  description,
  disabled,
  aside,
}: {
  value: string;
  id: string;
  checked: boolean;
  title: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Trailing content, e.g. an "Em breve" chip. */
  aside?: ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className="ac-option"
      data-state={checked ? "checked" : "unchecked"}
      data-disabled={disabled ? "" : undefined}
    >
      <Radio value={value} id={id} disabled={disabled} />
      <span className="ac-option__text">
        <span className="ac-option__title">{title}</span>
        {description && <span className="ac-option__desc">{description}</span>}
      </span>
      {aside && <span className="ac-option__aside">{aside}</span>}
    </label>
  );
}
