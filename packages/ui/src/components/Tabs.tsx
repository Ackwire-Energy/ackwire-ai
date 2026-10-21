import { Tabs as RTabs } from "radix-ui";
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  /** Shown after the label in tabular numbers. */
  count?: number;
}

/**
 * Tabs (Radix: arrow keys between tabs, `tablist`/`tab`/`tabpanel`). `segmented`: the tabs look like the
 * Segmented control (a track, the raised pill slides under the chosen tab), e.g. under the agent's card
 * (telas/AgenteFundo.html, B).
 */
export function Tabs<V extends string>({
  value,
  onValueChange,
  items,
  label,
  variant = "line",
  children,
}: {
  value: V;
  onValueChange: (value: V) => void;
  items: TabItem<V>[];
  label: string;
  variant?: "line" | "segmented";
  children: ReactNode;
}) {
  const seg = variant === "segmented";
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const index = Math.max(
    0,
    items.findIndex((i) => i.value === value),
  );
  // As in Segmented: measured after every render, and again when the chosen tab resizes (a badge arriving).
  useLayoutEffect(() => {
    if (!seg) return;
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
  return (
    <RTabs.Root value={value} onValueChange={(v) => onValueChange(v as V)} style={{ display: "contents" }}>
      <RTabs.List className={seg ? "ac-seg ac-tabs--seg" : "ac-tabs"} aria-label={label}>
        {seg && pill && (
          <span
            className="ac-seg__pill"
            aria-hidden="true"
            style={{ "--x": `${pill.x}px`, "--w": `${pill.w}px` } as CSSProperties}
          />
        )}
        {items.map((item, i) => (
          <RTabs.Trigger
            key={item.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={item.value}
            className={seg ? "ac-seg__item" : "ac-tab"}
            data-on={(seg && item.value === value) || undefined}
          >
            {item.label}
            {item.count !== undefined && (
              <>
                {" "}
                <span className="ac-tab__count">{item.count}</span>
              </>
            )}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RTabs.Content value={value} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {children}
    </RTabs.Content>
  );
}
