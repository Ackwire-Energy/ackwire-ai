import { createHash } from "node:crypto";
import type { BlobStore } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { NotFoundError, ValidationError } from "./errors";

const { users, organizationMembers } = schema;

export const AVATAR_LIMITS = { maxBytes: 2 * 1024 * 1024 };
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** The image type from its first bytes (never trust the declared type alone). */
export function sniffImage(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** JPEG without EXIF/XMP (APP1), Photoshop/IPTC (APP13) or comments; the image data is untouched. */
function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1] as number;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const length = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    const end = i + 2 + length;
    if (end > b.length) break;
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(b.subarray(i, end));
    i = end;
  }
  out.push(b.subarray(i));
  return concat(out);
}

/** PNG without text, EXIF or time chunks. */
function stripPng(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = view.getUint32(i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + length;
    if (end > b.length) break;
    if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return concat(out);
}

/** WebP without EXIF or XMP chunks (and their flags cleared). */
function stripWebp(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const size = view.getUint32(i + 4, true);
    const end = i + 8 + size + (size % 2);
    if (end > b.length + 1) break;
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = b.slice(i, Math.min(end, b.length));
      if (type === "VP8X" && chunk.length > 8) chunk[8] = (chunk[8] as number) & ~0x0c; // no EXIF / XMP flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The image without metadata (location, camera, names); pixels are kept as sent. */
export function stripImageMetadata(bytes: Uint8Array, type: "image/jpeg" | "image/png" | "image/webp") {
  return type === "image/jpeg" ? stripJpeg(bytes) : type === "image/png" ? stripPng(bytes) : stripWebp(bytes);
}

const AVATAR_PATH = /^\/api\/app\/avatars\/([^/]+)\/([0-9a-f]{16}\.(jpg|png|webp))$/;

/**
 * Sets a person's photo (`PUT …/me/avatar`): JPEG, PNG or WebP up to 2 MB,
 * checked by its bytes, stripped of metadata, stored in the platform bucket,
 * served by `GET /api/app/avatars/{userId}/{file}` (people sharing an org).
 * The app crops it (512×512) before sending.
 */
export async function setAvatar(
  deps: { db: Database; blobs: BlobStore },
  userId: string,
  input: { imageBase64: string; contentType: string },
): Promise<{ avatarUrl: string }> {
  const clean = input.imageBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new ValidationError("A imagem não está em base64.");
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  if (bytes.length === 0) throw new ValidationError("A imagem veio vazia.");
  if (bytes.length > AVATAR_LIMITS.maxBytes) throw new ValidationError("A foto pode ter até 2 MB.");
  const type = sniffImage(bytes);
  if (!type || !TYPES[input.contentType] || type !== input.contentType) {
    throw new ValidationError("Use uma imagem JPEG, PNG ou WebP.");
  }
  const body = stripImageMetadata(bytes, type);
  const file = `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.${TYPES[type]}`;
  await deps.blobs.put(`avatars/${userId}/${file}`, body, { contentType: type });
  const [before] = await deps.db.select({ image: users.image }).from(users).where(eq(users.id, userId));
  const avatarUrl = `/api/app/avatars/${encodeURIComponent(userId)}/${file}`;
  await deps.db.update(users).set({ image: avatarUrl, updatedAt: new Date() }).where(eq(users.id, userId));
  await removeStored(deps.blobs, userId, before?.image, file);
  return { avatarUrl };
}

/** Removes the photo (`DELETE …/me/avatar`): back to initials. */
export async function removeAvatar(deps: { db: Database; blobs: BlobStore }, userId: string) {
  const [before] = await deps.db.select({ image: users.image }).from(users).where(eq(users.id, userId));
  await deps.db.update(users).set({ image: null, updatedAt: new Date() }).where(eq(users.id, userId));
  await removeStored(deps.blobs, userId, before?.image, null);
}

async function removeStored(blobs: BlobStore, userId: string, image: string | null | undefined, keep: string | null) {
  const m = image ? AVATAR_PATH.exec(image) : null;
  if (!m || decodeURIComponent(m[1] ?? "") !== userId || m[2] === keep) return;
  await blobs.delete(`avatars/${userId}/${m[2]}`).catch(() => undefined);
}

/**
 * The stored photo for `GET /api/app/avatars/{userId}/{file}`: only for the
 * person or someone who shares an organization with them.
 */
export async function avatarFile(
  deps: { db: Database; blobs: BlobStore },
  viewerId: string,
  userId: string,
  file: string,
) {
  if (!/^[0-9a-f]{16}\.(jpg|png|webp)$/.test(file)) throw new NotFoundError("Not found");
  if (viewerId !== userId) {
    const [shared] = await deps.db
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, userId),
          sql`${organizationMembers.orgId} in (select org_id from organization_members where user_id = ${viewerId})`,
        ),
      )
      .limit(1);
    if (!shared) throw new NotFoundError("Not found");
  }
  const object = await deps.blobs.get(`avatars/${userId}/${file}`);
  if (!object) throw new NotFoundError("Not found");
  return object;
}
