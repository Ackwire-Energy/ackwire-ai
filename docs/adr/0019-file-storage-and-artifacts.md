# 0019. File storage per organization, and artifacts

- Status: Accepted
- Date: 2026-10-14

## Decision

**Blob stores.** Files go through a `BlobStore` (put, get, delete, list, signed GET URL). Implementations: S3-compatible buckets (a small SigV4 client over `fetch`, no SDK, so tests swap the transport for an in-process fake server), Postgres (fallback when the deployment has no bucket; can't sign, so downloads are streamed), and memory (tests). Platform storage is our bucket from `S3_*` (Cloudflare R2), one key prefix per org (`orgs/{orgId}/`); without `S3_*` it is Postgres. Objects are private.

**Deleted workspaces.** A workspace deleted with its last member's account leaves platform storage through the job `org.files.purge`, enqueued with the deletion and without `org_id` (the row would go with the workspace): its keys under `orgs/{orgId}/` and its logo under `org-logos/{orgId}/`, 1,000 of each per run, the job running again while a page comes back full. It never touches a workspace that still exists. A bucket the workspace brought stays its own.

**Per-org storage.** An org may bring its own S3-compatible bucket (R2, AWS S3, MinIO, Wasabi…): `storage_configs` keeps endpoint, region, bucket, prefix, path-style, the access key id, and the secret envelope-encrypted like provider keys (bound to org and row); only hints come back. Rows are immutable after the probe: new settings are a new row. Every blob read and write goes through `BlobStoreResolver.forOrg(orgId)` (where new objects go) and `forConfig(orgId, configId)` (where an existing object was written). Each artifact version records `storage_config_id` and its key, so switching storage never breaks old files; an admin-started job (`storage.migrate`) copies existing objects to the current storage and repoints them, saving progress after each object and resuming after a failure. Google Drive and OneDrive (OAuth into a folder) are planned behind the same interface (`storage_kind` already lists them).

**Verify before activating.** `POST …/storage/test` writes, reads, lists and deletes a probe object and reports each step with a clear reason (key refused, bucket missing, wrong region, no permission, unreachable). `PUT …/storage` switches on only settings whose fingerprint (settings + keys) passed a test in the last 30 minutes. Only admins (`configure`) manage storage; tests, switches and migrations are written to `audit_log`.

**SSRF.** An endpoint typed by a person must be https, without credentials, not a `localhost`/`.local`/`.internal` name, and neither the host nor any address it resolves to may be private, loopback, link-local (cloud metadata), CGNAT, multicast or reserved. The same guard (`assertPublicHttpsUrl`) is for custom MCP URLs. DNS can change between the check and the request (rebinding); the guard still stops typed-in internal targets, and the S3 client never follows redirects.

**Artifacts.** `artifacts` (kind, title, channel and thread of origin, current version, creator and last editor, `untrusted`) and `artifact_versions` (storage, key, size, SHA-256, note, author, run). Kinds: `document` (Markdown), `table` (columns + rows, CSV export), `diff` (files with unified patches, `.patch` export), `html` (a self-contained page), `diagram` (Mermaid). Sizes and shapes are validated. Visibility comes from the channel: org-wide when there is none; people see channels they belong to and public ones; agents see their run's channel, public channels they are in, and org-wide files. A file you can't see is "not found". People create in the Drive or in their channels and save new versions of documents and tables (a stale `baseVersion` is 409); the creator or an admin deletes. Agents use `create_artifact`, `update_artifact` (`drive:write`), `read_artifact`, `list_artifacts` (`drive:read`) through the Tool Gateway; the reply carries `meta.artifacts`, and the channel gets `artifact.created` / `artifact.updated`. Artifacts are indexed for search (kind `file`) through the outbox with the channel's visibility. Downloads are short-lived signed URLs (5 minutes) after the visibility check, or our streaming endpoint, always as attachments.

**HTML is untrusted.** A page an agent (or a person) writes can contain anything. It is stored as is and flagged `untrusted`. The app renders it only in a sandboxed iframe served from a separate origin, never inline on the app's origin; our own endpoint serves it as an attachment with `Content-Security-Policy: sandbox` and `nosniff`. Agents reading it get it labeled as data, never instructions.

## Consequences

- One code path for every store; the org's bucket is just another config row.
- Old files keep working after a switch without a migration; the migration is optional and safe to re-run.
- The Postgres fallback keeps development free of external services, but is meant for small files only.
- Self-host can also keep files on local disk (`FILES_DIR`).
