import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

/** Dropdown menu (Radix DropdownMenu: arrow keys, typeahead, Esc, focus return). */
export function Menu({
  trigger,
  children,
  align = "start",
  side = "bottom",
  label,
}: {
  /** A focusable element (usually a `Button`). */
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  label?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ac-menu ac-menu--dropdown"
          align={align}
          side={side}
          sideOffset={4}
          aria-label={label}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  onSelect,
  icon,
  danger,
  disabled,
  children,
  description,
  hint,
}: {
  onSelect?: () => void;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
  description?: ReactNode;
  /** Quiet text on the right: the current value of what it opens ("Só o que é arriscado"). */
  hint?: ReactNode;
}) {
  return (
    <DropdownMenu.Item
      className={cx("ac-menu__item", danger && "ac-menu__item--danger")}
      onSelect={onSelect}
      disabled={disabled}
    >
      {icon && <Icon name={icon} />}
      <span className="ac-menu__label">
        {children}
        {description && <span className="ac-menu__desc">{description}</span>}
      </span>
      {hint && <span className="ac-menu__hint">{hint}</span>}
    </DropdownMenu.Item>
  );
}

export function MenuRadioGroup({
  label,
  value,
  onValueChange,
  options,
}: {
  label: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: ReactNode }[];
}) {
  return (
    <DropdownMenu.Group>
      <DropdownMenu.Label className="ac-menu__heading">{label}</DropdownMenu.Label>
      <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
        {options.map((o) => (
          <DropdownMenu.RadioItem key={o.value} value={o.value} className="ac-menu__item">
            <svg className="ac-menu__check" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5.5 10.5 3 3 6-7" />
            </svg>
            <span className="ac-menu__label">{o.label}</span>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Group>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="ac-menu__separator" />;
}
