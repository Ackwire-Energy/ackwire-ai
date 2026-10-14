# Architecture decision records

Short records of decisions that shape the backend. One file per decision, numbered, never deleted: when a decision changes, add a new ADR and mark the old one "Superseded by".

The product-level decision log (in Portuguese) is `docs/planejamento.md`; these ADRs record how those decisions were implemented. The structure mirrors Tierbird's core (`tierbird-cloud/core/docs/adr`).

| # | Decision |
| --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions |
| [0002](0002-editions-and-modules.md) | One codebase, two editions, `AgentesModule` and adapters |
| [0003](0003-testing-with-pglite.md) | Tests run on in-memory PGlite with pgvector |
| [0004](0004-configuration.md) | Configuration through one env var schema; one master secret |
| [0005](0005-postgres-outbox.md) | Postgres outbox and in-process workers, no Redis/BullMQ |
| [0006](0006-auth-and-tenancy.md) | Better Auth for people; our own organizations, roles and agents |
| [0007](0007-provider-credentials.md) | Provider credentials (envelope encryption) and the Model Gateway |
| [0008](0008-agent-runs.md) | Agent runs as a Postgres state machine; mentions and hop limit |
| [0009](0009-messages-partitioning.md) | `messages` partitioned by month |
| [0010](0010-realtime.md) | Real-time over native Bun WebSocket and a `PubSub` adapter |
| [0011](0011-technology-stack.md) | Technology stack |
| [0012](0012-budget-reservation-and-usage.md) | Budget reservation, usage kinds (`agent`/`router`/`embedding`/`summary`), partial usage on stream failure |
| [0013](0013-router.md) | Router: code picks candidates, a `RouterStrategy` scores, policy decides; decisions stored |
| [0014](0014-live-subscription-revocation.md) | Membership changes revoke live WebSocket subscriptions |
| [0015](0015-tool-gateway-and-approvals.md) | Tool Gateway, scopes and approvals bound to the action hash; runs as resumable tool loops |
| [0016](0016-connectors.md) | Connectors in two layers over MCP: org connections (sealed, OAuth with state + PKCE), our scope catalog, agent grants |
