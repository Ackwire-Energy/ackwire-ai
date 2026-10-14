import { type Database, eq, like, schema } from "@agenteschat/db";
import type { BlobStore } from "./blob";

const { blobs } = schema;
const ORG_KEY = /^orgs\/([0-9a-f-]{36})\//i;

/**
 * Platform storage in Postgres, for deployments without a bucket. Keys must
 * start with `orgs/{orgId}/` (every row carries its org). Can't sign URLs:
 * downloads are streamed by the server after its checks.
 */
export function createPostgresBlobStore(db: Database): BlobStore {
  const orgOf = (key: string) => {
    const orgId = ORG_KEY.exec(key)?.[1];
    if (!orgId) throw new Error(`blob key must start with orgs/{orgId}/: ${key}`);
    return orgId;
  };
  return {
    kind: "postgres",
    async put(key, body, { contentType }) {
      const row = {
        key,
        orgId: orgOf(key),
        contentType,
        size: body.byteLength,
        content: Buffer.from(body).toString("base64"),
      };
      await db
        .insert(blobs)
        .values(row)
        .onConflictDoUpdate({
          target: blobs.key,
          set: { contentType: row.contentType, size: row.size, content: row.content },
        });
    },
    async get(key) {
      const [row] = await db.select().from(blobs).where(eq(blobs.key, key));
      if (!row) return null;
      return { body: new Uint8Array(Buffer.from(row.content, "base64")), contentType: row.contentType };
    },
    async delete(key) {
      await db.delete(blobs).where(eq(blobs.key, key));
    },
    async list(prefix, limit = 1000) {
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = await db
        .select({ key: blobs.key })
        .from(blobs)
        .where(like(blobs.key, `${escaped}%`))
        .orderBy(blobs.key)
        .limit(limit);
      return rows.map((r) => r.key);
    },
    async signedUrl() {
      return null;
    },
  };
}
