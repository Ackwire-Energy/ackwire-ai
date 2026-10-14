# 0003. Tests run on in-memory PGlite with pgvector

- Status: Accepted
- Date: 2026-10-14
- Same as Tierbird ADR 0008.

## Decision

- Tests use PGlite (PostgreSQL in WebAssembly) in memory via `packages/db/test/pglite.ts` (`createTestDatabase`), with all migrations applied and the pgvector extension loaded (`@electric-sql/pglite-pgvector`).
- `bun test` needs nothing but Bun: no Docker, no local Postgres, no `.env`. `testConfig()` supplies a fixed test secret.
- Setting `TEST_DATABASE_URL` runs the same suite against a real PostgreSQL server (one throw-away database per test).
- No network and no model calls in tests: the model provider is an interface with a fake (`@agenteschat/providers/testing`). In-memory adapters stand in for pub/sub, presence and rate limiting; the Postgres LISTEN/NOTIFY pub/sub is tested on PGlite directly.
- Code depends on the driver-agnostic `Database` type.

## Consequences

- PGlite versions are pinned exactly (`@electric-sql/pglite` 0.5.8 with `pglite-pgvector` 0.0.9, whose peer dependency requires that exact version). Upgrade them together.
- Each test file creates fresh databases; the suite takes about a minute. Shared fixtures (`packages/engine/test/fixtures.ts`, `apps/server/test/harness.ts`) keep tests short.
- Raw SQL results differ by driver (array vs `{ rows }`); use `rowsOf()` from `@agenteschat/db`.
