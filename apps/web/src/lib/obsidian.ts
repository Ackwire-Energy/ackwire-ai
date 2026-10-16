import type { ApiClient } from "@/api/client";
import type { WikiImportNote, WikiImportResult, WikiPageSummary } from "@/api/types";
import { readZip } from "./zip";

/*
 * An Obsidian vault in the browser: a .zip, a folder (picked or dropped) or
 * loose .md files. Reading says what would become of it in the wiki (the
 * review); importing sends the embedded attachments to the Drive and the
 * notes to `POST …/wiki/import` in batches. Prototype: docs/design/telas/Wiki.html.
 */

export interface VaultFile {
  /** `/`-separated, relative to where it was picked. */
  path: string;
  size: number;
  text(): Promise<string>;
  blob(): Promise<Blob>;
}

export interface VaultNote {
  path: string;
  title: string;
  folder: string;
  tags: string[];
  aliases: string[];
  links: string[];
  /** `![[…]]` targets as written. */
  embeds: string[];
  /** Without the frontmatter. */
  body: string;
  dataview: number;
  callouts: number;
}

export interface VaultReport {
  name: string;
  notes: VaultNote[];
  attachments: { path: string; size: number; file: VaultFile }[];
  canvases: string[];
  skipped: { config: number; trash: number; other: number };
  /** Top-level folders ("" = notes at the root) with their note counts. */
  folders: { name: string; count: number }[];
  links: number;
  tags: string[];
  dataview: number;
  callouts: number;
  /** Link targets that match no note, alias, attachment or existing page. */
  broken: string[];
  /** Notes named like a page that already exists. */
  conflicts: string[];
  /** Size of the attachments the notes embed (what goes to the Drive). */
  embeddedBytes: number;
  embeddedCount: number;
}

export const MAX_VAULT_BYTES = 500 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 300;
const BATCH = 200;

const ATTACH = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf|mp4|mov|webm|mp3|wav|m4a|ogg|xlsx?|csv|docx?|pptx?|zip|txt)$/i;
const isMd = (p: string) => /\.(md|markdown)$/i.test(p);
const base = (p: string) => p.split("/").pop() ?? p;
const lower = (s: string) => s.toLowerCase();
const decoder = new TextDecoder();

export class VaultError extends Error {
  constructor(readonly code: "empty" | "too_big" | "unreadable") {
    super(`vault: ${code}`);
  }
}

const fromFile = (f: File, path: string): VaultFile => ({
  path: path.replace(/\\/g, "/").replace(/^\/+/, ""),
  size: f.size,
  text: () => f.text(),
  blob: async () => f,
});

export async function filesFromZip(file: File): Promise<VaultFile[]> {
  if (file.size > MAX_VAULT_BYTES) throw new VaultError("too_big");
  const entries = await readZip(file).catch(() => {
    throw new VaultError("unreadable");
  });
  return entries
    .filter((e) => !e.name.startsWith("__MACOSX/") && base(e.name) !== ".DS_Store")
    .map((e) => ({
      path: e.name,
      size: e.size,
      text: async () => decoder.decode(await e.read()),
      blob: async () => new Blob([(await e.read()).slice()]),
    }));
}

/** From an `<input type=file>` (files or a folder) or a plain drop of files. */
export async function filesFromList(list: FileList | File[]): Promise<VaultFile[]> {
  const files = Array.from(list);
  const [only] = files;
  if (files.length === 1 && only && /\.zip$/i.test(only.name)) return filesFromZip(only);
  return files
    .filter((f) => f.name !== ".DS_Store")
    .map((f) => fromFile(f, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name));
}

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (ok: (f: File) => void, no: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: Entry[]) => void, no: (e: unknown) => void) => void };
};

/** A drop: a .zip, files, or whole folders (walked with the entries API). */
export async function filesFromDrop(dt: DataTransfer): Promise<VaultFile[]> {
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i.webkitGetAsEntry?.() ?? null) as unknown as Entry | null)
    .filter((e): e is Entry => e !== null);
  if (entries.length === 0 || entries.every((e) => e.isFile)) return filesFromList(dt.files);
  const out: VaultFile[] = [];
  const walk = async (e: Entry): Promise<void> => {
    if (e.isFile && e.file) {
      const f = await new Promise<File>((ok, no) => e.file?.(ok, no));
      if (f.name !== ".DS_Store") out.push(fromFile(f, e.fullPath));
      return;
    }
    const reader = e.createReader?.();
    if (!reader) return;
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, no) => reader.readEntries(ok, no));
      if (batch.length === 0) break;
      for (const c of batch) await walk(c);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

export const hasFiles = (dt: DataTransfer | null) => Array.from(dt?.types ?? []).includes("Files");

// ── Parsing ──────────────────────────────────────────────────────────────────

function frontmatter(text: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { tags: [] as string[], aliases: [] as string[], body: text };
  const meta: Record<string, string[]> = {};
  let key: string | null = null;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = lower(kv[1] ?? "");
      const v = (kv[2] ?? "").trim();
      meta[key] = v.startsWith("[")
        ? v
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : v
          ? [v]
          : [];
      continue;
    }
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && key) meta[key]?.push((li[1] ?? "").trim());
  }
  const clean = (a: string[] | undefined) =>
    (a ?? []).map((s) => s.replace(/^["']|["']$/g, "").replace(/^#/, "")).filter(Boolean);
  return {
    tags: clean(meta.tags ?? meta.tag),
    aliases: clean(meta.aliases ?? meta.alias),
    body: text.slice(m[0].length),
  };
}

const LINKS = /(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;
const TAGS = /(?:^|\s)#([\p{L}\d_/-]*[\p{L}_/-][\p{L}\d_/-]*)/gu;

export function parseNote(path: string, text: string): VaultNote {
  const fm = frontmatter(text);
  const noCode = fm.body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const links: string[] = [];
  const embeds: string[] = [];
  for (const m of noCode.matchAll(LINKS)) (m[1] ? embeds : links).push((m[2] ?? "").trim());
  const inline = [...noCode.matchAll(TAGS)].map((m) => m[1] ?? "");
  const parts = path.split("/");
  const file = parts.pop() ?? path;
  return {
    path,
    title: file.replace(/\.(md|markdown)$/i, ""),
    folder: parts.join("/"),
    tags: [...new Set([...fm.tags, ...inline].map(lower))],
    aliases: fm.aliases,
    links,
    embeds,
    body: fm.body,
    dataview: (fm.body.match(/```dataview/g) ?? []).length,
    callouts: (fm.body.match(/^>\s*\[!/gm) ?? []).length,
  };
}

/** The vault's own folder ("Acme Vault/…") when every path starts with it. */
function vaultRoot(files: VaultFile[]) {
  const firsts = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  const [only] = [...firsts];
  return firsts.size === 1 && only ? only : "";
}

/** An embed points at an attachment (by file name), not at a note. */
const attachmentOf = (report: Pick<VaultReport, "attachments">, target: string) => {
  const want = lower(base(target));
  return report.attachments.find((a) => lower(base(a.path)) === want);
};

export async function readVault(
  files: VaultFile[],
  options: {
    existing?: Pick<WikiPageSummary, "title">[];
    name?: string;
    onProgress?: (done: number, total: number, path: string) => void;
  } = {},
): Promise<VaultReport> {
  const root = vaultRoot(files);
  const strip = (p: string) => (root ? p.slice(root.length + 1) : p);
  const notes: VaultNote[] = [];
  const attachments: VaultReport["attachments"] = [];
  const canvases: string[] = [];
  const skipped = { config: 0, trash: 0, other: 0 };
  const total = files.filter((f) => isMd(f.path)).length;
  let done = 0;
  for (const f of files) {
    const p = strip(f.path);
    if (/(^|\/)\.obsidian\//.test(p)) skipped.config++;
    else if (/(^|\/)\.trash\//.test(p)) skipped.trash++;
    else if (/(^|\/)\./.test(p)) skipped.other++;
    else if (isMd(p)) {
      notes.push(parseNote(p, await f.text()));
      done++;
      if (options.onProgress && (done % 8 === 0 || done === total)) {
        options.onProgress(done, total, p);
        await new Promise((r) => setTimeout(r, 0));
      }
    } else if (/\.canvas$/i.test(p)) canvases.push(p);
    else if (ATTACH.test(p)) attachments.push({ path: p, size: f.size, file: f });
    else skipped.other++;
  }
  if (notes.length === 0) throw new VaultError("empty");

  const known = new Set(
    [...notes.flatMap((n) => [n.title, ...n.aliases]), ...(options.existing ?? []).map((p) => p.title)].map(lower),
  );
  const broken = new Set<string>();
  for (const n of notes) {
    for (const l of n.links) if (!known.has(lower(base(l))) && !attachmentOf({ attachments }, l)) broken.add(l);
  }
  const existing = new Set((options.existing ?? []).map((p) => lower(p.title)));
  const folders = new Map<string, number>();
  for (const n of notes) {
    const top = n.folder.split("/")[0] ?? "";
    folders.set(top, (folders.get(top) ?? 0) + 1);
  }
  const embedded = new Set<string>();
  for (const n of notes)
    for (const e of n.embeds) {
      const a = attachmentOf({ attachments }, e);
      if (a) embedded.add(a.path);
    }
  const embeddedFiles = attachments.filter((a) => embedded.has(a.path));
  return {
    name: options.name || root || "Obsidian",
    notes,
    attachments,
    canvases,
    skipped,
    folders: [...folders]
      .sort((a, b) => Number(a[0] === "") - Number(b[0] === "") || b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    links: notes.reduce((s, n) => s + n.links.length, 0),
    tags: [...new Set(notes.flatMap((n) => n.tags))].sort(),
    dataview: notes.reduce((s, n) => s + n.dataview, 0),
    callouts: notes.reduce((s, n) => s + n.callouts, 0),
    broken: [...broken],
    conflicts: notes.filter((n) => existing.has(lower(n.title))).map((n) => n.title),
    embeddedBytes: embeddedFiles.reduce((s, a) => s + a.size, 0),
    embeddedCount: embeddedFiles.length,
  };
}

// ── Importing ────────────────────────────────────────────────────────────────

export interface VaultImportOptions {
  /** Top-level folders to bring ("" = the notes at the root). */
  folders: Set<string>;
  /** Put everything under this folder; empty merges with the wiki's folders. */
  into: string;
  onConflict: "keep_both" | "skip";
  onProgress?: (step: "files" | "pages", done: number, total: number) => void;
}

/**
 * Sends the embedded attachments to the Drive (each once, ≤ 50 MB), then
 * the notes in batches. Returns what the server made, plus how many
 * attachments went up.
 */
export async function importVault(
  api: ApiClient,
  orgId: string,
  report: VaultReport,
  options: VaultImportOptions,
): Promise<WikiImportResult & { uploaded: number }> {
  const notes = report.notes.filter((n) => options.folders.has(n.folder.split("/")[0] ?? ""));
  const wanted = new Map<string, VaultReport["attachments"][number]>();
  for (const n of notes)
    for (const e of n.embeds) {
      const a = attachmentOf(report, e);
      if (a && a.size <= MAX_ATTACHMENT_BYTES && wanted.size < MAX_ATTACHMENTS) wanted.set(a.path, a);
    }
  const ids = new Map<string, string>();
  let done = 0;
  for (const a of wanted.values()) {
    options.onProgress?.("files", done, wanted.size);
    try {
      const blob = await a.file.blob();
      const created = await api.artifacts.upload(orgId, new File([blob], base(a.path)), { title: base(a.path) });
      ids.set(a.path, created.id);
    } catch {
      // An attachment that fails stays as a card "not imported"; the page still comes.
    }
    done++;
  }
  const toInput = (n: VaultNote): WikiImportNote => {
    const attachments: Record<string, string> = {};
    for (const e of n.embeds) {
      const a = attachmentOf(report, e);
      const id = a && ids.get(a.path);
      if (id) attachments[e] = id;
    }
    return {
      title: n.title,
      folder: n.folder,
      body: n.body,
      tags: n.tags.slice(0, 20),
      aliases: n.aliases.slice(0, 50),
      ...(Object.keys(attachments).length ? { attachments } : {}),
    };
  };
  const result: WikiImportResult = { created: [], skipped: [], failed: [] };
  for (let i = 0; i < notes.length; i += BATCH) {
    options.onProgress?.("pages", i, notes.length);
    const batch = await api.wiki.import(orgId, {
      source: { type: "obsidian", name: report.name },
      notes: notes.slice(i, i + BATCH).map(toInput),
      folder: options.into.trim() || undefined,
      onConflict: options.onConflict,
    });
    result.created.push(...batch.created);
    result.skipped.push(...batch.skipped);
    result.failed.push(...batch.failed);
  }
  options.onProgress?.("pages", notes.length, notes.length);
  return { ...result, uploaded: ids.size };
}

/** The page to open after an import: the vault's home note, else the first. */
export const homeOf = (created: WikiPageSummary[]) =>
  created.find((p) => /^(início|inicio|home|index|readme|mapa|start)\b/i.test(p.title)) ?? created[0];

export const fmtBytes = (n: number, locale: string) =>
  n < 1024
    ? `${n} B`
    : n < 1_048_576
      ? `${Math.round(n / 1024)} KB`
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n / 1_048_576)} MB`;

/** An embed target that is a file (has an extension other than .md), not a note. */
export const isAttachmentName = (target: string) => /\.[a-z0-9]{2,5}$/i.test(target) && !isMd(target);
