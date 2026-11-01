import {
  IMPORT_MAX_BYTES,
  ImportError,
  type ImportFile,
  isSecretPath,
  normalizePath,
} from "@agenteschat/client/lib/import/shared";
import { readZip, ZipError } from "@agenteschat/client/lib/zip";

/**
 * The async step before `parseImport`: picked or dropped files (a folder keeps
 * its relative paths), or one archive (.zip, .tar.gz, .tgz, .tar) unpacked in
 * the browser. Only text files the formats use are read; a credential store,
 * a binary or a file over 4 MB comes back with empty text, so it can be
 * listed without being read.
 */

export const ARCHIVE_LIMITS = {
  /** The archive file. */
  bytes: 512 * 1024 * 1024,
  entries: 50_000,
  /** What it may unpack to, and how much larger than itself past `ratioFrom` bytes. */
  unpacked: 2 * 1024 * 1024 * 1024,
  ratio: 200,
  ratioFrom: 64 * 1024 * 1024,
  /** Text read in all: what one import may send (IMPORT_LIMITS.bodyBytes in packages/engine/src/imports.ts). */
  text: 32 * 1024 * 1024,
};

const ARCHIVE = /\.(zip|tar\.gz|tgz|tar)$/i;
const TEXT = /\.(md|markdown|json|json5|yaml|yml|txt)$/i;
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$|\.git\/|node_modules\/)/;
/** Folders a format itself has at its root: an archive with only one of them is not wrapped in a folder. */
const LAYOUT = new Set(["agents", "skills", "memory", "memories", "cron", "tasks", "projects", "teams", "profiles"]);

export type PickedFile = File | { path: string; file: Blob };

export async function readImportFiles(
  picked: readonly PickedFile[],
): Promise<{ files: ImportFile[]; root: string | null }> {
  const items = picked.map((p) =>
    "file" in p
      ? { path: normalizePath(p.path), blob: p.file }
      : { path: normalizePath(p.webkitRelativePath || p.name), blob: p },
  );
  const [only] = items;
  if (items.length === 1 && only && ARCHIVE.test(only.path)) return readArchive(only.blob, only.path);
  const wants = budget();
  const files: ImportFile[] = [];
  for (const { path, blob } of items) {
    if (!JUNK.test(path)) files.push({ name: path, text: wants(path, blob.size) ? await blob.text() : "" });
  }
  // A dropped folder: every path starts with its name.
  return unwrap(files, true);
}

async function readArchive(blob: Blob, path: string): Promise<{ files: ImportFile[]; root: string | null }> {
  if (blob.size > ARCHIVE_LIMITS.bytes) throw new ImportError("tooLarge");
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const zip = head[0] === 0x50 && head[1] === 0x4b;
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  if (/\.zip$/i.test(path) ? !zip : /\.(tar\.gz|tgz)$/i.test(path) && !gzip) throw new ImportError("corrupt");
  return unwrap(zip ? await fromZip(blob) : await fromTar(blob, gzip), false);
}

/** Which files to read: text a format uses, under the per-file and total caps, never a credential store. */
function budget() {
  let total = 0;
  return (path: string, size: number) => {
    if (isSecretPath(path) || !TEXT.test(path) || size > IMPORT_MAX_BYTES || total + size > ARCHIVE_LIMITS.text) {
      return false;
    }
    total += size;
    return true;
  };
}

function safePath(raw: string): string {
  const path = raw.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
    throw new ImportError("unsafe");
  }
  return normalizePath(path);
}

/** Paths relative to the single folder everything is in (its name is `root`). */
function unwrap(files: ImportFile[], folder: boolean): { files: ImportFile[]; root: string | null } {
  const tops = new Set(files.map((f) => (f.name.includes("/") ? f.name.split("/")[0] : "")));
  const [top] = tops;
  if (tops.size !== 1 || !top || (!folder && LAYOUT.has(top))) return { files, root: null };
  return { files: files.map((f) => ({ ...f, name: f.name.slice(top.length + 1) })), root: top };
}

const decoder = new TextDecoder();

async function fromZip(blob: Blob): Promise<ImportFile[]> {
  const entries = await readZip(blob).catch(() => {
    throw new ImportError("corrupt");
  });
  const declared = entries.reduce((sum, e) => sum + e.size, 0);
  if (
    entries.length > ARCHIVE_LIMITS.entries ||
    declared > ARCHIVE_LIMITS.unpacked ||
    (declared > ARCHIVE_LIMITS.ratioFrom && declared > blob.size * ARCHIVE_LIMITS.ratio)
  ) {
    throw new ImportError("tooLarge");
  }
  const wants = budget();
  const out: ImportFile[] = [];
  for (const entry of entries) {
    const path = safePath(entry.name);
    if (JUNK.test(path)) continue;
    let text = "";
    if (wants(path, entry.size)) {
      // An encrypted entry, or one packed in a way the reader doesn't know, is listed without being read.
      const data = await entry.read().catch((error: unknown) => {
        if (error instanceof ZipError && (error.code === "encrypted" || error.code === "method")) return null;
        throw new ImportError("corrupt");
      });
      // An entry larger than its declared size is a zip bomb or a broken archive.
      if (data && data.length > entry.size) throw new ImportError("tooLarge");
      text = data ? decoder.decode(data) : "";
    }
    out.push({ name: path, text });
  }
  return out;
}

/** The bytes of a stream, taken or skipped in order, without keeping what is skipped. */
class Bytes {
  private queue: Uint8Array[] = [];
  private queued = 0;
  private total = 0;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly packed: number,
  ) {}

  private async pull(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done || !value) return false;
    this.total += value.length;
    if (
      this.total > ARCHIVE_LIMITS.unpacked ||
      (this.total > ARCHIVE_LIMITS.ratioFrom && this.total > this.packed * ARCHIVE_LIMITS.ratio)
    ) {
      throw new ImportError("tooLarge");
    }
    this.queue.push(value);
    this.queued += value.length;
    return true;
  }

  /** The next `n` bytes, or null when the stream ends first. */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.queued < n) if (!(await this.pull())) return null;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.queue[0] as Uint8Array;
      const part = chunk.subarray(0, n - at);
      out.set(part, at);
      at += part.length;
      if (part.length === chunk.length) this.queue.shift();
      else this.queue[0] = chunk.subarray(part.length);
    }
    this.queued -= n;
    return out;
  }

  async skip(n: number) {
    for (let left = n; left > 0; ) {
      if (this.queued === 0 && !(await this.pull())) throw new ImportError("corrupt");
      const chunk = this.queue[0] as Uint8Array;
      const part = Math.min(left, chunk.length);
      if (part === chunk.length) this.queue.shift();
      else this.queue[0] = chunk.subarray(part);
      this.queued -= part;
      left -= part;
    }
  }

  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

const field = (block: Uint8Array, at: number, length: number) =>
  decoder.decode(block.subarray(at, at + length)).replace(/\0[\s\S]*$/, "");

/** A numeric header field: octal text, or base-256 when its first byte has the high bit. */
function numeric(block: Uint8Array, at: number, length: number): number {
  if (((block[at] ?? 0) & 0x80) !== 0) {
    let n = 0;
    for (let i = at + 1; i < at + length; i++) n = n * 256 + (block[i] ?? 0);
    return n;
  }
  const text = field(block, at, length).trim();
  const n = text ? Number.parseInt(text, 8) : 0;
  if (Number.isNaN(n)) throw new ImportError("corrupt");
  return n;
}

/** A ustar archive (GNU long names and pax paths too), streamed: only the text files read are kept. */
async function fromTar(blob: Blob, gzip: boolean): Promise<ImportFile[]> {
  const stream = gzip ? blob.stream().pipeThrough(new DecompressionStream("gzip")) : blob.stream();
  const bytes = new Bytes(stream.getReader(), blob.size);
  const wants = budget();
  const out: ImportFile[] = [];
  let longName = "";
  try {
    for (let count = 0; ; count++) {
      const header = await bytes.take(512);
      if (!header && count === 0) throw new ImportError("corrupt");
      if (!header || header.every((b) => b === 0)) break;
      if (count >= ARCHIVE_LIMITS.entries) throw new ImportError("tooLarge");
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] as number);
      if (sum !== numeric(header, 148, 8)) throw new ImportError("corrupt");
      const size = numeric(header, 124, 12);
      const padded = Math.ceil(size / 512) * 512;
      const type = String.fromCharCode(header[156] as number);
      if (type === "L" || type === "x") {
        // The next entry's name: a GNU long name, or a pax header's `path` record.
        if (size > 1024 * 1024) throw new ImportError("corrupt");
        const data = decoder.decode((await bytes.take(padded))?.subarray(0, size));
        longName = type === "L" ? data.replace(/\0[\s\S]*$/, "") : (/(?:^|\n)\d+ path=([^\n]*)/.exec(data)?.[1] ?? "");
        continue;
      }
      const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : "";
      const name = longName || (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
      longName = "";
      const path = safePath(name);
      const regular = type === "0" || type === "\0" || type === "7";
      if (regular && !JUNK.test(path) && !path.endsWith("/") && wants(path, size)) {
        const data = await bytes.take(padded);
        if (!data) throw new ImportError("corrupt");
        out.push({ name: path, text: decoder.decode(data.subarray(0, size)) });
        continue;
      }
      await bytes.skip(padded);
      // A link is listed, never followed; directories and devices are not files.
      if ((regular || type === "1" || type === "2") && !JUNK.test(path) && !path.endsWith("/")) {
        out.push({ name: path, text: "" });
      }
    }
  } catch (error) {
    throw error instanceof ImportError ? error : new ImportError("corrupt");
  } finally {
    bytes.cancel();
  }
  return out;
}
