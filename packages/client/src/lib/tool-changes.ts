import { type DiffLine, diffLines } from "@agenteschat/ui/diff";
import type { TFunction } from "i18next";
import type { ToolChange } from "../api/types";
import { inputFields } from "./custom-tools";

/*
 * What a connected server changed in an approved tool (ADR 0117), cut down to the changes: shared by the web's
 * Conectores and the phone's Ferramentas, so both say the same thing about the same change.
 */

/** Marks the unchanged lines left out between two changes (ADR 0117 review: only what changed, briefly framed). */
export const ELIDED = "…";

/**
 * A text in the units a person compares: its lines, each cut at sentence ends, so a long paragraph with one new
 * sentence shows that sentence and not the whole paragraph twice.
 */
export function textUnits(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.!?:;])\s+(?=\S)/))
    .map((unit) => unit.trimEnd())
    .filter((unit) => unit.trim().length > 0);
}

/** Only the changed lines, each with `context` unchanged lines around it; the rest becomes one `ELIDED` line. */
export function changedOnly(lines: DiffLine[], context = 1): DiffLine[] {
  const keep = lines.map((l) => l.kind !== "same");
  const near = lines.map((_, i) => {
    for (let d = -context; d <= context; d++) if (keep[i + d]) return true;
    return false;
  });
  const out: DiffLine[] = [];
  lines.forEach((line, i) => {
    if (near[i]) out.push(line);
    else if (out.at(-1)?.text !== ELIDED || out.at(-1)?.kind !== "same") out.push({ kind: "same", text: ELIDED });
  });
  return out;
}

const diffText = (before: string, after: string) => changedOnly(diffLines(textUnits(before), textUnits(after)));

/** A schema with its keys sorted, as lines: two versions differ here only when their content does. */
function schemaLines(value: unknown): string[] {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sorted(value ?? null), null, 2).split("\n");
}

const without = (value: unknown, ...drop: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !drop.includes(k)));
};

export interface FieldChange {
  name: string;
  status: "added" | "removed" | "changed";
  type: string;
  /** What changed in the field: its description by sentence, then anything else in its schema. */
  lines: DiffLine[];
  /** The schema lines are JSON (shown as code). */
  code: boolean;
}

export interface ToolChangeDiff {
  /** The description's changed sentences, or null when it didn't change. */
  description: DiffLine[] | null;
  fields: FieldChange[];
  /** The input changed outside its fields (which are required, other keys), as JSON lines; null when not. */
  schema: DiffLine[] | null;
}

/** What a server changed in an approved tool, cut down to the changes (ADR 0117). */
export function toolChangeDiff(change: Pick<ToolChange, "before" | "after">): ToolChangeDiff {
  const { before, after } = change;
  const description = before.description === after.description ? null : diffText(before.description, after.description);
  const oldFields = new Map(inputFields(before.inputSchema).map((f) => [f.name, f]));
  const newFields = new Map(inputFields(after.inputSchema).map((f) => [f.name, f]));
  const rawOf = (schema: Record<string, unknown>, name: string) =>
    (schema.properties as Record<string, unknown> | undefined)?.[name];
  const fields: FieldChange[] = [];
  for (const name of new Set([...oldFields.keys(), ...newFields.keys()])) {
    const was = oldFields.get(name);
    const now = newFields.get(name);
    const oldRest = schemaLines(without(rawOf(before.inputSchema, name), "description"));
    const newRest = schemaLines(without(rawOf(after.inputSchema, name), "description"));
    if (was && now && was.description === now.description && oldRest.join("\n") === newRest.join("\n")) continue;
    const status = !was ? "added" : !now ? "removed" : "changed";
    const text = diffText(was?.description ?? "", now?.description ?? "");
    const restChanged = status === "changed" && oldRest.join("\n") !== newRest.join("\n");
    const lines = [...text, ...(restChanged ? changedOnly(diffLines(oldRest, newRest)) : [])];
    fields.push({ name, status, type: (now ?? was)?.type ?? "", lines, code: restChanged && text.length === 0 });
  }
  const oldTop = schemaLines(without(before.inputSchema, "properties"));
  const newTop = schemaLines(without(after.inputSchema, "properties"));
  const schema = oldTop.join("\n") === newTop.join("\n") ? null : changedOnly(diffLines(oldTop, newTop));
  return { description, fields, schema };
}

/** "O texto mudou · 2 campos mudaram": what changed, in a few words (the list's line under each tool's name). */
export function toolChangeSummary(t: TFunction, diff: ToolChangeDiff): string {
  const parts: string[] = [];
  if (diff.description) parts.push(t("connectors.toolChanges.textChanged"));
  if (diff.fields.length > 0) parts.push(t("connectors.toolChanges.fieldsChanged", { count: diff.fields.length }));
  if (parts.length === 0) parts.push(t("connectors.toolChanges.inputChanged"));
  return parts.join(" · ");
}
