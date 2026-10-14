# 0002. One codebase, two editions, modules and adapters

- Status: Accepted
- Date: 2026-10-14
- Implements: planejamento D16, D17, D18a, D18c. Same model as Tierbird ADR 0003.

## Context

agentes.chat ships as open source (AGPL-3.0, self-hosted) and as agentes.chat Cloud (paid, ours). Two codebases would drift; cloud-only code (billing, platform key reselling, KMS, Redis, Turbopuffer) must never ship in the public repository.

## Decision

1. **One server.** `apps/server` is the complete product. `src/main.ts` starts the self-hosted edition; `startServer({ edition, modules })` in `src/start.ts` is shared.
2. **Cloud wraps the core.** The private repository `agentes-chat-cloud` contains this repository (`agentes-chat`) as the `core/` submodule and calls `startServer({ edition: "cloud", modules: [...] })`.
3. **`AgentesModule` is the only extension point** (`packages/modules`): `registerRoutes`, `onStart`, `onStop`, and `adapters()`, which returns overrides for:
   | Adapter | Core default | Cloud (expected) |
   | --- | --- | --- |
   | `SearchIndexResolver.forOrg(orgId)` | Postgres (stub today) | Turbopuffer per plan |
   | `PubSub` | Postgres LISTEN/NOTIFY (memory in tests) | Redis pub/sub |
   | `Presence` | in-memory | Redis with TTL |
   | `RateLimiter` | in-memory fixed window | Redis |
   | `KeyWrapper` | key derived from `AGENTES_SECRET` | KMS |
   | `PlatformCredentials` | none | platform provider key |
   | `modelProviders` | Anthropic | more providers |
   Modules are applied in order; each sees the adapters resolved so far; later modules win. Overrides are logged at boot.
4. **Boundary enforced.** `bun run check:boundaries` fails if anything under `apps/` or `packages/` imports or depends on `@agenteschat/cloud` or `@agenteschat/ee`.
5. **Licensing by directory:** `apps/`, `packages/` AGPL-3.0-only; `ee/` commercial (placeholder package today); cloud code lives only in the private repo.
6. **Multi-tenant from day one.** Every tenant-owned table has `org_id` (a test asserts it). Self-host is an install with one organization.
7. **Metering in the core.** Usage records are written by the core in both editions; only Cloud turns them into invoices and limits.

## Consequences

- The core knows no plans: e.g. the search backend per org is decided by whatever `SearchIndexResolver` is registered.
- The job queue is not an adapter: the outbox contract stays in Postgres in both editions (ADR 0005).
