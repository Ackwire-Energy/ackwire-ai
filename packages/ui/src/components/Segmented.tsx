import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { Button, type ButtonProps } from "./Button";
import { CountChip } from "./Chip";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** A small neutral count chip after the label (e.g. Missões 1); hidden when 0 or absent. */
  count?: number;
}

/**
 * A segmented control: one choice of a few, a raised pill slides (spring)
 * under the chosen one. Radio semantics (`radiogroup` / `radio`), arrows move.
 */
export function Segmented<V extends string>({
  value,
  onValueChange,
  options,
  label,
  size = "md",
  className,
}: {
  value: V;
  onValueChange: (value: V) => void;
  options: SegmentedOption<V>[];
  label: string;
  size?: "md" | "sm";
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  // Measured after every render (labels and counts change the width; same values keep the state),
  // and again when the chosen item resizes (fonts loading, a count arriving).
  useLayoutEffect(() => {
    const el = refs.current[index];
    if (!el) return;
    const measure = () =>
      setPill((p) =>
        p && p.x === el.offsetLeft && p.w === el.offsetWidth ? p : { x: el.offsetLeft, w: el.offsetWidth },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  const move = (step: number) => {
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onValueChange(next.value);
    refs.current[(index + step + options.length) % options.length]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("ac-seg", size === "sm" && "ac-seg--sm", className)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {pill && (
        <span
          className="ac-seg__pill"
          aria-hidden="true"
          style={{ "--x": `${pill.x}px`, "--w": `${pill.w}px` } as CSSProperties}
        />
      )}
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: a roving-focus radio group of buttons (arrow keys), styled as a segmented control
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="ac-seg__item"
          data-on={o.value === value || undefined}
          onClick={() => onValueChange(o.value)}
        >
          {o.label}
          {o.count ? <CountChip size={size === "sm" ? "sm" : undefined}>{o.count}</CountChip> : null}
        </button>
      ))}
    </div>
  );
}

/** A button with a second part that opens more options ("Criar issue" | ▾). */
export function SplitButton({
  children,
  onClick,
  menu,
  className,
  ...rest
}: Omit<ButtonProps, "variant" | "asChild"> & {
  /** The second part (e.g. a `Menu` whose trigger is a Button with `aria-label`). */
  menu: ReactNode;
}) {
  return (
    <div className={cx("ac-split", className)}>
      <Button onClick={onClick} {...rest}>
        {children}
      </Button>
      {menu}
    </div>
  );
}
