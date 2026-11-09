import { type SQL, type schema, sql } from "@agenteschat/db";

/**
 * How long a streamed reply keeps the place where its first words showed (its `created_at`, ADR 0010): what people
 * sent while it wrote stays below it, as the apps drew it live. One that took longer is posted at the end, where the
 * conversation is by then. It also bounds how far back `landedAfterSql` looks. Mirrored in packages/client
 * (`PLACE_KEPT_MS`, lib/timeline.ts).
 */
export const PLACE_KEPT_MS = 10 * 60_000;

type Column = SQL | typeof schema.messages.createdAt | typeof schema.messages.id;

/**
 * SQL: message `m` landed after `at`, for whoever last looked then (a read, a pause): written after it, or posted since
 * in a place before it (`PLACE_KEPT_MS`). Message ids are UUIDv7 from the clock at their insert, so they sort by when
 * each was posted, whatever its place.
 */
export function landedAfterSql(m: { createdAt: Column; id: Column }, at: SQL | Date): SQL {
  const t = at instanceof Date ? sql`${at.toISOString()}::timestamptz` : at;
  // Never read (`-infinity`) has no epoch that fits a bigint: from 1970 every id is later anyway.
  const ms = sql`floor(extract(epoch from greatest(${t}, 'epoch'::timestamptz)) * 1000)::bigint`;
  const postedFrom = sql`(lpad(to_hex(${ms}), 12, '0') || '00000000000000000000')::uuid`;
  // The range first, so `(channel_id, created_at)` still finds the rows.
  return sql`(${m.createdAt} > ${t} - ${PLACE_KEPT_MS / 1000}::int * interval '1 second'
    and (${m.createdAt} > ${t} or ${m.id} > ${postedFrom}))`;
}

/**
 * SQL: message `m` was in the conversation when message `ref` was posted: placed before it, or posted before it in a
 * place after it (what people sent while `ref`'s reply was written, `PLACE_KEPT_MS`). What a run asked by `ref` reads.
 */
export function postedBySql(
  m: { createdAt: Column; id: Column },
  ref: { createdAt: SQL | Date; id: SQL | string },
): SQL {
  const t = ref.createdAt instanceof Date ? sql`${ref.createdAt.toISOString()}::timestamptz` : ref.createdAt;
  const id = typeof ref.id === "string" ? sql`${ref.id}::uuid` : ref.id;
  return sql`(${m.createdAt} <= ${t} + ${PLACE_KEPT_MS / 1000}::int * interval '1 second'
    and (${m.createdAt} <= ${t} or ${m.id} < ${id}))`;
}
