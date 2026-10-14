export type DiffKind = "same" | "add" | "del";
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Line diff of two texts (longest common subsequence), for before/after
 * proposals. Equal lines are kept, removed lines come before added ones.
 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        before[i] === after[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push({ kind: "same", text: before[i] as string });
      i++;
      j++;
    } else if (
      i < n &&
      (j >= m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
    ) {
      out.push({ kind: "del", text: before[i] as string });
      i++;
    } else {
      out.push({ kind: "add", text: after[j] as string });
      j++;
    }
  }
  return out;
}

/** Neutral diff: added lines bold on sunken, removed lines struck and muted. Labels are for screen readers. */
export function Diff({
  lines,
  addedLabel,
  removedLabel,
  code,
  "aria-label": ariaLabel,
}: {
  lines: DiffLine[];
  addedLabel: string;
  removedLabel: string;
  /** Real code: monospace, whitespace kept. */
  code?: boolean;
  "aria-label"?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a figure-like group of lines
    <div className={code ? "ac-diff ac-diff--code" : "ac-diff"} role="group" aria-label={ariaLabel}>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat; order is the identity
        <div key={i} className={`ac-diff__line${l.kind === "same" ? "" : ` ac-diff__line--${l.kind}`}`}>
          <span className="ac-diff__mark" aria-hidden="true">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
          </span>
          <span className="ac-diff__text">
            {l.kind !== "same" && (
              <span className="ac-visually-hidden">{l.kind === "add" ? addedLabel : removedLabel}</span>
            )}
            {l.text}
          </span>
        </div>
      ))}
    </div>
  );
}
