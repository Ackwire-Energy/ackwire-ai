import type { IconName } from "@agenteschat/ui";
import type { ArtifactContent, ArtifactKind, ArtifactRef } from "@/api/types";

export const ARTIFACT_KINDS: ArtifactKind[] = ["document", "table", "diff", "diagram", "html"];

export const KIND_ICON: Record<ArtifactKind, IconName> = {
  document: "document",
  table: "table",
  diff: "code",
  diagram: "diagram",
  html: "page",
};

export const isArtifactKind = (v: unknown): v is ArtifactKind => ARTIFACT_KINDS.includes(v as ArtifactKind);

/** `message.meta.artifacts` entries we can show. */
export function artifactRefs(meta: Record<string, unknown> | undefined): ArtifactRef[] {
  const list = meta?.artifacts;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r): r is ArtifactRef =>
      Boolean(r) && typeof r === "object" && typeof r.id === "string" && typeof r.version === "number",
  );
}

// ── Diffs ────────────────────────────────────────────────────────────────────

export type PatchLine =
  | { kind: "same" | "add" | "del"; text: string; old: number | null; new: number | null }
  | { kind: "hunk"; text: string; old: null; new: null };

/** Unified patch hunks → lines with old/new line numbers. */
export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("diff ") || raw.startsWith("index "))
      continue;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw, old: null, new: null });
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), old: null, new: newN++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), old: oldN++, new: null });
    else if (raw.startsWith(" ") || (raw === "" && out.length > 0)) {
      out.push({ kind: "same", text: raw.slice(1), old: oldN++, new: newN++ });
    }
  }
  // A trailing newline in the patch is not a context line.
  while (out.length && out[out.length - 1]?.kind === "same" && out[out.length - 1]?.text === "") out.pop();
  return out;
}

export function patchCounts(patch: string) {
  let added = 0;
  let removed = 0;
  for (const l of parsePatch(patch)) {
    if (l.kind === "add") added++;
    if (l.kind === "del") removed++;
  }
  return { added, removed };
}

export interface SideRow {
  hunk?: string;
  left: { n: number; text: string; kind: "same" | "del" } | null;
  right: { n: number; text: string; kind: "same" | "add" } | null;
}

/** Pairs removed and added lines of each change block for the side-by-side view. */
export function sideBySide(lines: PatchLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      rows.push({
        left: d ? { n: d.old ?? 0, text: d.text, kind: "del" } : null,
        right: a ? { n: a.new ?? 0, text: a.text, kind: "add" } : null,
      });
    }
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else {
      flush();
      if (l.kind === "hunk") rows.push({ hunk: l.text, left: null, right: null });
      else
        rows.push({
          left: { n: l.old ?? 0, text: l.text, kind: "same" },
          right: { n: l.new ?? 0, text: l.text, kind: "same" },
        });
    }
  }
  flush();
  return rows;
}

// ── Tables ───────────────────────────────────────────────────────────────────

export function toCsv(columns: string[], rows: string[][]) {
  const q = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map((c) => q(c ?? "")).join(",")).join("\n");
}

/** Number-aware sort ("1.234,5", "31", "2,6"), then text (locale). */
export function sortRows(rows: string[][], col: number, dir: "asc" | "desc", locale: string) {
  const num = (v: string) => {
    const s = v.trim().replace(/\s/g, "");
    if (!/^[-+]?[\d.,]+%?$/.test(s)) return null;
    const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
    const n = Number.parseFloat(normalized);
    return Number.isNaN(n) ? null : n;
  };
  const sorted = [...rows].sort((a, b) => {
    const x = a[col] ?? "";
    const y = b[col] ?? "";
    const nx = num(x);
    const ny = num(y);
    const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, locale, { sensitivity: "base" });
    return dir === "asc" ? c : -c;
  });
  return sorted;
}

// ── Files ────────────────────────────────────────────────────────────────────

export function fileName(title: string, content: ArtifactContent, table: "csv" = "csv") {
  const slug =
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "arquivo";
  const ext = { document: "md", table, diff: "patch", diagram: "mmd", html: "html" }[content.kind];
  return `${slug}.${ext}`;
}

/** First lines of a document, without Markdown marks or code (card preview). */
export function documentPreview(markdown: string, lines = 3) {
  const out: string[] = [];
  let fenced = false;
  for (const raw of markdown.split("\n")) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const l = raw
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\s*([-*+>]|\d+[.)])\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (l) out.push(l);
    if (out.length === lines) break;
  }
  return out;
}
