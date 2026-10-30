import { inflateRawSync } from "node:zlib";
import { ValidationError } from "./errors";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/** A file as the central directory lists it: where its bytes are and their declared size, nothing inflated. */
export interface ZipListing {
  path: string;
  size: number;
  /** A symbolic link (Unix mode in the external attributes): its bytes are a path, not content. */
  symlink: boolean;
  method: number;
  flags: number;
  compressed: number;
  local: number;
}

/** The central directory's files (folders left out); no zip64, so at most 65,535 entries. */
export function listZip(buffer: Uint8Array): ZipListing[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ValidationError("Not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files: ZipListing[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new ValidationError("Corrupt zip (central directory)");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const path = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    if (!path.endsWith("/")) {
      files.push({
        path,
        size: view.getUint32(offset + 24, true),
        symlink: ((view.getUint32(offset + 38, true) >>> 16) & 0o170000) === 0o120000,
        method: view.getUint16(offset + 10, true),
        flags: view.getUint16(offset + 8, true),
        compressed: view.getUint32(offset + 20, true),
        local: view.getUint32(offset + 42, true),
      });
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return files;
}

/** One file's bytes, inflated to exactly its declared size (so a zip bomb can't grow past what was checked). */
export function inflateZipEntry(buffer: Uint8Array, entry: ZipListing): Uint8Array {
  if (entry.flags & 0x1) throw new ValidationError("Encrypted zips are not supported");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (entry.local + 30 > buffer.length || view.getUint32(entry.local, true) !== 0x04034b50) {
    throw new ValidationError("Corrupt zip (local header)");
  }
  const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
  const raw = buffer.subarray(start, start + entry.compressed);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }));
  else throw new ValidationError(`Unsupported compression in ${entry.path}`);
  if (data.byteLength !== entry.size) throw new ValidationError(`Corrupt zip entry ${entry.path}`);
  return data;
}

/**
 * Reads a zip archive (stored or deflated entries; no zip64, no encryption)
 * within limits, checked before inflating so a zip bomb can't get through.
 */
export function readZip(buffer: Uint8Array, limits: { maxFiles: number; maxBytes: number }): ZipEntry[] {
  const files = listZip(buffer);
  if (files.length > limits.maxFiles) throw new ValidationError(`Too many files (max ${limits.maxFiles})`);
  if (files.reduce((n, f) => n + f.size, 0) > limits.maxBytes) {
    throw new ValidationError(`The skill is too large (max ${limits.maxBytes} bytes)`);
  }
  return files.map((f) => ({ path: f.path, data: inflateZipEntry(buffer, f) }));
}
