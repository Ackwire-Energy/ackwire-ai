import { Tabs as RTabs } from "radix-ui";
import type { ReactNode } from "react";

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  /** Shown after the label in tabular numbers. */
  count?: number;
}

/** Tabs (Radix: arrow keys between tabs, `tablist`/`tab`/`tabpanel`). */
export function Tabs<V extends string>({
  value,
  onValueChange,
  items,
  label,
  children,
}: {
  value: V;
  onValueChange: (value: V) => void;
  items: TabItem<V>[];
  label: string;
  children: ReactNode;
}) {
  return (
    <RTabs.Root value={value} onValueChange={(v) => onValueChange(v as V)} style={{ display: "contents" }}>
      <RTabs.List className="ac-tabs" aria-label={label}>
        {items.map((item) => (
          <RTabs.Trigger key={item.value} value={item.value} className="ac-tab">
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
