import type { DiffLine } from "../diff";

export { type DiffKind, type DiffLine, diffLines } from "../diff";

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
