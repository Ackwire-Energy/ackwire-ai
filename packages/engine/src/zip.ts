import { inflateRawSync } from "node:zlib";
import { ValidationError } from "./errors";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/**
 * Reads a zip archive (stored or deflated entries; no zip64, no encryption)
 * within limits, checked before inflating so a zip bomb can't get through.
 * Entries `skip` names come back with no data: never inflated, and not counted toward `maxBytes`.
 */
export function readZip(
  buffer: Uint8Array,
  limits: { maxFiles: number; maxBytes: number },
  skip: (path: string) => boolean = () => false,
): ZipEntry[] {
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
  if (count > limits.maxFiles * 2) throw new ValidationError(`Too many files (max ${limits.maxFiles})`);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new ValidationError("Corrupt zip (central directory)");
    }
    const method = view.getUint16(offset + 10, true);
    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const path = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/")) continue; // a folder
    if (flags & 0x1) throw new ValidationError("Encrypted zips are not supported");
    if (entries.length + 1 > limits.maxFiles) throw new ValidationError(`Too many files (max ${limits.maxFiles})`);
    if (skip(path)) {
      entries.push({ path, data: new Uint8Array() });
      continue;
    }
    total += size;
    if (total > limits.maxBytes) throw new ValidationError(`The skill is too large (max ${limits.maxBytes} bytes)`);
    if (view.getUint32(local, true) !== 0x04034b50) throw new ValidationError("Corrupt zip (local header)");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buffer.subarray(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }));
    else throw new ValidationError(`Unsupported compression in ${path}`);
    if (data.byteLength !== size) throw new ValidationError(`Corrupt zip entry ${path}`);
    entries.push({ path, data });
  }
  return entries;
}
