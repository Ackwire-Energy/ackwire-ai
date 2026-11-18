/**
 * Reads a .zip in the browser, with no library: the central directory gives
 * the entries, and each one inflates on demand with the native
 * `DecompressionStream("deflate-raw")`. Handles zip64 offsets; refuses
 * encrypted entries and methods other than stored/deflate.
 */
export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** Its bytes; never more than `size` (`ZipError("too_large")`). */
  read(): Promise<Uint8Array>;
}

export class ZipError extends Error {
  constructor(readonly code: "not_zip" | "corrupt" | "encrypted" | "method" | "too_large") {
    super(`zip: ${code}`);
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const MAX32 = 0xffffffff;

/** Inflates `data`, stopping as soon as it passes `max` bytes (a zip bomb declares a small size). */
async function inflate(data: Blob, max: number): Promise<Uint8Array> {
  const reader = data.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ZipError("too_large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** IBM code page 850's upper half (Western Europe's Windows): a zip's names when its UTF-8 flag (bit 11) is clear. */
export const CP850_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A name as the zip wrote it: UTF-8 when flagged, or when it reads as UTF-8 (many tools don't flag it); else CP850. */
function entryName(bytes: Uint8Array, utf8: boolean): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    if (utf8) return new TextDecoder().decode(bytes);
    return Array.from(bytes, (b) => (b < 128 ? String.fromCharCode(b) : (CP850_HIGH[b - 128] as string))).join("");
  }
}

/**
 * The entries, read by slices of `file`: its end, its central directory, then each entry's bytes only when asked for.
 * Memory stays at what is read, whatever the archive's size.
 */
export async function readZip(file: Blob): Promise<ZipEntry[]> {
  const slice = async (from: number, to: number) => {
    const bytes = new Uint8Array(await file.slice(from, to).arrayBuffer());
    if (bytes.length !== to - from) throw new ZipError("corrupt");
    return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  };
  if (file.size < 22) throw new ZipError("not_zip");
  const end = await slice(Math.max(0, file.size - 65_557), file.size);
  let eocd = -1;
  for (let i = end.bytes.length - 22; i >= 0; i--) {
    if (end.view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_zip");
  let count = end.view.getUint16(eocd + 10, true);
  let length = end.view.getUint32(eocd + 12, true);
  let offset = end.view.getUint32(eocd + 16, true);
  if (
    (count === 0xffff || length === MAX32 || offset === MAX32) &&
    eocd >= 20 &&
    end.view.getUint32(eocd - 20, true) === ZIP64_LOCATOR
  ) {
    const record = Number(end.view.getBigUint64(eocd - 12, true));
    const { view } = await slice(record, record + 56);
    count = Number(view.getBigUint64(32, true));
    length = Number(view.getBigUint64(40, true));
    offset = Number(view.getBigUint64(48, true));
  }
  if (offset + length > file.size) throw new ZipError("corrupt");
  const { bytes: buf, view } = await slice(offset, offset + length);
  const out: ZipEntry[] = [];
  let next = 0;
  for (let n = 0; n < count; n++) {
    const p = next;
    if (p + 46 > buf.length || view.getUint32(p, true) !== CENTRAL) throw new ZipError("corrupt");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let compressed = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let local = view.getUint32(p + 42, true);
    const name = entryName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0).replace(/\\/g, "/");
    // zip64: the real sizes and offset sit in the extra field 0x0001, in this order, when maxed out.
    let at = p + 46 + nameLen;
    const extraEnd = at + extraLen;
    if (extraEnd + commentLen > buf.length) throw new ZipError("corrupt");
    const needsZip64 = size === MAX32 || compressed === MAX32 || local === MAX32;
    let hasZip64 = false;
    while (at + 4 <= extraEnd) {
      const id = view.getUint16(at, true);
      const len = view.getUint16(at + 2, true);
      if (id === 0x0001) {
        hasZip64 = true;
        let q = at + 4;
        const wide = () => {
          if (q + 8 > at + 4 + len || q + 8 > extraEnd || q + 8 > buf.length) throw new ZipError("corrupt");
          const value = Number(view.getBigUint64(q, true));
          if (!Number.isSafeInteger(value)) throw new ZipError("corrupt");
          q += 8;
          return value;
        };
        if (size === MAX32) {
          size = wide();
        }
        if (compressed === MAX32) {
          compressed = wide();
        }
        if (local === MAX32) local = wide();
      }
      at += 4 + len;
    }
    if (needsZip64 && !hasZip64) throw new ZipError("corrupt");
    next = extraEnd + commentLen;
    if (name.endsWith("/")) continue;
    const encrypted = (flags & 1) === 1;
    const start = local;
    const packed = compressed;
    out.push({
      name,
      size,
      async read() {
        if (encrypted) throw new ZipError("encrypted");
        const head = await slice(start, start + 30);
        if (head.view.getUint32(0, true) !== 0x04034b50) throw new ZipError("corrupt");
        const from = start + 30 + head.view.getUint16(26, true) + head.view.getUint16(28, true);
        if (from + packed > file.size) throw new ZipError("corrupt");
        if (method === 0) {
          if (packed > size) throw new ZipError("too_large");
          if (packed !== size) throw new ZipError("corrupt");
          return (await slice(from, from + packed)).bytes;
        }
        if (method === 8) {
          const inflated = await inflate(file.slice(from, from + packed), size);
          if (inflated.length !== size) throw new ZipError("corrupt");
          return inflated;
        }
        throw new ZipError("method");
      },
    });
  }
  return out;
}
