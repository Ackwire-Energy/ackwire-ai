import type { ArtifactDetail, ArtifactKind } from "@agenteschat/client";
import { fileIcon, previewType } from "@agenteschat/client/lib/files";

/**
 * Files on a message: which ones show as pictures, the card's tile and
 * line ("MD", "Documento · 4 KB"), how a viewer shows each, and the name a shared copy gets.
 */

/** How the app shows a file: inline picture, the document screen (Markdown, text, PDF), or only its card. */
export type FileView = "image" | "markdown" | "text" | "pdf" | "other";

/** The word under the name ("Imagem", "PDF", "Documento"…): `mobile.files.type.<key>`. */
export type FileTypeKey =
  | "image"
  | "pdf"
  | "document"
  | "table"
  | "code"
  | "archive"
  | "diff"
  | "diagram"
  | "page"
  | "text"
  | "file";

export interface FileInfo {
  /** The name shown, with its extension ("Resumo da home.md", "home.png"). */
  name: string;
  view: FileView;
  type: FileTypeKey;
  /** The tile's label: the extension in capitals, at most 4 letters ("MD", "PDF", "CSV"). */
  ext: string;
  /** Bytes, when known. */
  size: number | null;
  /** The clean MIME type ("" when unknown). */
  mime: string;
}

/** Raster types the app draws (expo-image); SVG and the rest open as a card. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const TEXT_EXT = new Set(["txt", "log", "csv", "tsv", "json", "yml", "yaml", "toml", "xml", "ini", "env"]);

/** Non-file artifacts: the extension their download gets (as the server names them). */
const KIND_EXT: Record<Exclude<ArtifactKind, "file">, string> = {
  document: "md",
  table: "csv",
  diff: "patch",
  diagram: "mmd",
  html: "html",
};

const KIND_TYPE: Record<Exclude<ArtifactKind, "file">, FileTypeKey> = {
  document: "document",
  table: "table",
  diff: "diff",
  diagram: "diagram",
  html: "page",
};

/** "relatorio.final.PDF" → "pdf" ("" without one). */
export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m?.[1]?.toLowerCase() ?? "";
}

/** The tile's label: "MD", "PDF", "JPEG" (4 letters at most); "" → the caller shows an icon. */
export const extLabel = (ext: string) => ext.slice(0, 4).toUpperCase();

/** UTF-8 bytes of a text (the size of a document artifact, which has no stored size here). */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Adds `.ext` unless the name already ends with it. */
export function withExtension(name: string, ext: string): string {
  if (!ext) return name;
  return extensionOf(name) === ext.toLowerCase() ? name : `${name}.${ext}`;
}

/** What a viewer and a card need to know about an artifact. */
export function fileInfo(a: Pick<ArtifactDetail, "kind" | "title" | "content">): FileInfo {
  const c = a.content;
  if (c.kind === "file") {
    const name = c.name || a.title;
    const ext = extensionOf(name);
    const mime = previewType(c.contentType);
    let view: FileView = "other";
    if (IMAGE_TYPES.has(mime)) view = "image";
    else if (mime === "application/pdf" || ext === "pdf") view = "pdf";
    else if (MARKDOWN_EXT.has(ext) || mime === "text/markdown") view = "markdown";
    else if (TEXT_EXT.has(ext) || mime.startsWith("text/")) view = "text";
    return { name, view, type: fileType(name, mime, view), ext: extLabel(ext), size: c.size, mime };
  }
  const ext = KIND_EXT[c.kind];
  const name = withExtension(a.title, ext);
  const view: FileView = c.kind === "document" ? "markdown" : "other";
  const size = c.kind === "document" ? utf8Bytes(c.markdown) : null;
  return { name, view, type: KIND_TYPE[c.kind], ext: extLabel(ext), size, mime: "" };
}

function fileType(name: string, mime: string, view: FileView): FileTypeKey {
  if (view === "image") return "image";
  if (view === "pdf") return "pdf";
  if (view === "markdown") return "document";
  const icon = fileIcon(name, mime);
  if (icon === "image") return "image";
  if (icon === "table") return "table";
  if (icon === "code") return "code";
  if (icon === "archive") return "archive";
  if (icon === "page") return "page";
  if (icon === "document") return view === "text" ? "text" : "document";
  return view === "text" ? "text" : "file";
}

/**
 * How a message's pictures sit: one alone at its own shape, or rows of two (an odd last one alone in
 * its row, half width). Returns the indexes per row.
 */
export function imageRows(count: number): number[][] {
  if (count <= 0) return [];
  if (count === 1) return [[0]];
  const rows: number[][] = [];
  for (let i = 0; i < count; i += 2) rows.push(i + 1 < count ? [i, i + 1] : [i]);
  return rows;
}

/** A lone picture's height for `width`: its own aspect ratio, kept between tall (3:4… 9:16) and wide (2:1). */
export function singleImageHeight(width: number, size: { width: number; height: number } | null): number {
  if (!size || size.width <= 0 || size.height <= 0) return Math.round(width * 0.75);
  const ratio = Math.min(Math.max(size.width / size.height, 9 / 16), 2);
  return Math.round(width / ratio);
}

/**
 * A safe file name for a copy in the cache (and the name the share sheet shows): no folders, no
 * characters iOS or other apps refuse, not empty, not too long (the extension is kept).
 */
export function safeFileName(name: string, fallback = "file"): string {
  const cleaned = name
    .normalize("NFC")
    // Path separators and characters file systems refuse.
    .replace(/[/\\:*?"<>|]/g, "-")
    // Control characters.
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    // No leading dots (hidden files) or trailing dots/spaces.
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  const base = cleaned || fallback;
  const MAX = 120;
  if (base.length <= MAX) return base;
  const ext = extensionOf(base);
  if (!ext) return base.slice(0, MAX).trim();
  const stem = base.slice(0, base.length - ext.length - 1);
  return `${stem.slice(0, MAX - ext.length - 1).trim()}.${ext}`;
}

/** The web Drive opened at this file (there is no Drive screen in the app yet). */
export function driveWebUrl(apiUrl: string, orgId: string, id: string, version?: number): string {
  const base = apiUrl.replace(/\/+$/, "");
  const v = version ? `&v=${version}` : "";
  return `${base}/org/${encodeURIComponent(orgId)}/drive?artifact=${encodeURIComponent(id)}${v}`;
}

/** A download URL the server returned: signed (absolute, no session needed) or ours (relative, needs it). */
export function resolveDownloadUrl(apiUrl: string, url: string): { uri: string; needsSession: boolean } {
  if (/^https?:\/\//i.test(url)) return { uri: url, needsSession: url.startsWith(apiUrl.replace(/\/+$/, "")) };
  const base = apiUrl.replace(/\/+$/, "");
  return { uri: `${base}${url.startsWith("/") ? "" : "/"}${url}`, needsSession: true };
}

/**
 * Where a shared copy comes from: the text the app already has (documents, diagrams, pages, small
 * text files), or a download (uploaded files, and tables and code changes as CSV / .patch exports).
 */
export type ShareSource =
  | { from: "text"; text: string; name: string; mime: string }
  | { from: "download"; name: string; mime: string }
  | { from: "export"; format: "csv" | "patch"; name: string; mime: string };

export function shareSource(a: Pick<ArtifactDetail, "kind" | "title" | "content">): ShareSource {
  const info = fileInfo(a);
  const name = safeFileName(info.name);
  const c = a.content;
  switch (c.kind) {
    case "document":
      return { from: "text", text: c.markdown, name, mime: "text/markdown" };
    case "diagram":
      return { from: "text", text: c.mermaid, name, mime: "text/plain" };
    case "html":
      return { from: "text", text: c.html, name, mime: "text/html" };
    case "table":
      return { from: "export", format: "csv", name, mime: "text/csv" };
    case "diff":
      return { from: "export", format: "patch", name, mime: "text/x-patch" };
    case "file":
      return { from: "download", name, mime: info.mime };
  }
}

/** `id@version` pairs for the picture viewer's route (`?files=a@2,b@1`), and back. */
export function encodeFileList(files: { id: string; version?: number }[]): string {
  return files.map((f) => (f.version ? `${f.id}@${f.version}` : f.id)).join(",");
}

export function decodeFileList(raw: string | string[] | undefined): { id: string; version?: number }[] {
  const s = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return s.split(",").flatMap((part) => {
    const [id = "", v] = part.trim().split("@");
    if (!/^[\w-]{1,64}$/.test(id)) return [];
    const n = v ? Number(v) : Number.NaN;
    return [Number.isInteger(n) && n > 0 ? { id, version: n } : { id }];
  });
}
