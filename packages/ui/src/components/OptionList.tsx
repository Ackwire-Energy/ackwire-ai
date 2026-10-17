import { RadioGroup as RRadioGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "../cx";

export interface OptionListItem<V extends string> {
  value: V;
  title: ReactNode;
  /** Quiet words after the title ("Recomendado", "Em teste"). */
  tag?: ReactNode;
  /** One short line under the title. */
  description?: ReactNode;
  /** Before the text: an illustration (`AutonomyPixels`), an icon, an avatar. Without it, a radio dot. */
  leading?: ReactNode;
}

export interface OptionListProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: OptionListItem<V>[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Shown but not changeable (the choice is kept, the others fade). */
  disabled?: boolean;
  className?: string;
}

/**
 * A vertical list of choices as full-width rows of the same height, one left
 * edge, neutral selection (telas/MissaoConfig.html: Autonomia, Quem faz o
 * trabalho). Radix RadioGroup: `role="radio"` rows, one tab stop, arrow
 * keys move and select. A row leads with its illustration, or a radio dot.
 */
export function OptionList<V extends string>({
  value,
  onValueChange,
  options,
  disabled,
  className,
  ...rest
}: OptionListProps<V>) {
  return (
    <RRadioGroup.Root
      className={cx("ac-optlist", disabled && "ac-optlist--locked", className)}
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
      orientation="vertical"
      loop
      {...rest}
    >
      {options.map((o) => (
        <RRadioGroup.Item
          key={o.value}
          value={o.value}
          className={cx("ac-optrow", o.leading ? "ac-optrow--lead" : undefined)}
        >
          {o.leading ? (
            <span className="ac-optrow__lead">{o.leading}</span>
          ) : (
            <span className="ac-optrow__dot" aria-hidden="true" />
          )}
          <span className="ac-optrow__text">
            <span className="ac-optrow__title">
              {o.title}
              {o.tag && <span className="ac-optrow__tag">{o.tag}</span>}
            </span>
            {o.description && <span className="ac-optrow__desc">{o.description}</span>}
          </span>
        </RRadioGroup.Item>
      ))}
    </RRadioGroup.Root>
  );
}
