# 0039. A native Postgres connector: agents read with SQL, writes always ask

- Status: Accepted (read-only first: `pg_execute` and `database:write` come later, after real use)
- Date: 2026-10-19
- Extends: ADR 0015 (Tool Gateway and approvals), ADR 0016 (connectors), ADR 0007 (credentials), ADR 0037 (reads never ask)
- Out of scope: MySQL, SQL Server, BigQuery and other warehouses (the same shape later, one driver each); databases only reachable from a private network (see "Private networks")

## Context

People want agents that answer from their own data: "how many orders yesterday", "which customers churned this month", "why is this user stuck". Today the only path is a custom MCP connector pointing at a public HTTPS SQL server, and the Supabase preset (`execute_sql` with `read_only=true`, `packages/engine/src/connectors/presets.ts`). Most small companies have a plain Postgres (Railway, Neon, RDS, Render, a VPS) and no MCP server in front of it, so they can't connect at all.

What we already have:

- The Tool Gateway takes any number of `ToolSource`s (`createToolGateway({ sources })`, `packages/engine/src/tools/types.ts`). Sources only offer tools; the gateway alone decides (scopes from `agent_scopes`, re-read per call; sensitive calls become approvals with the exact parameters and an action hash).
- Per-org encrypted credentials (`sealSecret`, ADR 0007) and connector connections (`connector_connections`).
- The address guard used for MCP URLs (`isBlockedAddress`, `assertPublicHttpsUrl` in `net-guard.ts`).
- The `postgres` driver is already a dependency (`packages/db`), and tests run on PGlite.

So the plumbing is there. The work is making SQL safe to hand to a model.

## Decision

### A connector that is a `ToolSource`, not an MCP server

- New connector `postgres` in the catalog, category `dev`, auth `connection_string`. The org connects a database once; each agent gets a subset of its scopes (ADR 0016). An org can connect several databases; each is its own connection with its own name ("Production (read replica)", "Analytics").
- It runs in-process in the server: no MCP hop, no extra service. Its tools go through the same gateway path as every other tool (scopes, audit, outcomes, approvals).

### Every brain gets it the same way

- **Cloud agents** (the engine's tool loop) see the `pg_*` tools like any granted connector tool.
- **Computer brains** (Claude Code, Codex on a connected computer, ADR 0032) get them through the runner's `agentes` MCP bridge: `bridgeToolsFor` lists the run's gateway tools, connector tools included, and each call comes back to `invokeToolForRun`, i.e. the same gateway, grants, approvals and limits. The SQL still runs from our server, not from the machine; the credential never reaches the machine.
- What we do not control: a computer brain can also run `psql` or its own tools on that machine with whatever credentials the person keeps there. That path is governed by the machine's command policy and folders, not by this connector. The connect screen doesn't change that; it is the person's machine.

### Tools and scopes

| Tool | Scope | Level |
| --- | --- | --- |
| `pg_list_tables` (schemas, tables, views, row estimates) | `database:read` | read |
| `pg_describe_table` (columns, types, keys, indexes, comments) | `database:read` | read |
| `pg_query` (one `SELECT`/`WITH` statement, parameters allowed) | `database:read` | read, never asks (ADR 0037) |
| `pg_execute` (one `INSERT`/`UPDATE`/`DELETE`) | `database:write` | sensitive: always an approval showing the exact SQL, the parameters and the database |

- No DDL tool (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`). Changing a schema is a migration in the person's repository, not an agent call.
- Tool names carry the connection name when an agent has more than one database, so the model can tell them apart.

### Reads can only read

Layered, because no single check is enough:

1. **The database user (strongest).** The connect screen recommends, with the exact SQL to run, a dedicated role with only `SELECT` (and `pg_read_all_data` where available), ideally on a read replica. A connection whose role can write is marked "can change data" in the app; only such a connection can grant `database:write`.
2. **Read-only transaction.** Every read runs as `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, so even a writable role cannot change data through `pg_query`.
3. **One statement.** The statement is parsed (a real Postgres parser, not a regex) and must be a single `SELECT`/`WITH`/`EXPLAIN` (no `ANALYZE`). Rejected: multiple statements, `COPY`, `DO`, `CALL`, `SET`/`RESET` of session settings, `LISTEN`/`NOTIFY`, `pg_sleep` and the admin functions (`pg_read_file`, `pg_terminate_backend`, `lo_*`, `dblink*`).
4. **Limits per call.** `statement_timeout` 15 s (org setting up to 60 s), `idle_in_transaction_session_timeout`, `lock_timeout` 2 s. The server streams rows and stops at 500 rows or 64 KB of text, whichever comes first, and tells the model the result was cut (with the total when cheap). Values longer than 2 KB are truncated; `bytea` is never returned.

Writes (`pg_execute`) run in a normal transaction after approval, with the same timeouts, one statement, and `RETURNING` capped like reads. The approval card shows the SQL and the rows it would touch (`EXPLAIN` estimate). The gateway re-checks the grant and the action hash before executing, and it runs at most once.

### Connection and network

- The connection string (or host, port, database, user, password, `sslmode`) is sealed per org like provider keys (ADR 0007) and never returned to any client; the app shows only host, database and user.
- **TLS required** by default (`sslmode=require`; `verify-full` when the provider gives a CA). Turning TLS off is an explicit admin choice with a warning.
- **Address guard:** the host is resolved on every new connection and refused when it points to a private, loopback, link-local or metadata address (`isBlockedAddress`), so an agent can't be used to reach our own network. Re-resolving per connection closes DNS rebinding.
- **Pool:** at most 2 connections per org connection, opened on first use and closed after 5 minutes idle. `application_name = agentes.chat` so the database owner can see and kill our sessions.
- "Test connection" in the app runs `select version()` plus a check of what the role can do (to set the "can change data" mark).

### Per-call checks (`checkCall`)

This connector is the second user of the per-call hook (ADR 0038; after GitHub). Optional rules per agent:

- Allowed schemas or tables (the parser lists the relations a statement touches; anything outside is refused).
- Hidden columns (e.g. `users.password_hash`, `cpf`): refused in `SELECT` lists and `*` expansion is rewritten to exclude them.
- A daily cap of reads per agent.

### Data and the model

- Query results go to the model provider, like any tool result. The connect screen says so in plain words, next to the hidden-columns setting. This matters for LGPD: the org decides what personal data its agents may read.
- Results are untrusted content (they may contain text written by end users); they are marked as such in the transcript, like email bodies (ADR 0038).
- Every call is logged with the SQL, row count, duration and the agent, never the returned rows.

### Private networks

A database without a public address (Railway's internal Postgres, a company LAN, a VPC) is not reachable from our servers, and we will not open tunnels from the Cloud. The path for those is a connected computer inside that network (ADR 0025): the runner opens the connection locally and the same tools run there, with the same checks applied by our gateway. That variant is a follow-up; the connector API is designed so the executor can be the server or a machine.

## Consequences

- Most small companies can let agents answer from their data with one connect screen, without running an MCP server.
- Safety depends on layers we control (read-only transaction, parser, limits, address guard, approvals) plus one we recommend (a read-only role). The app makes the recommendation concrete and shows when a connection can write.
- A heavy `SELECT` can still load the person's database within the timeout. We recommend a replica and keep the timeout short.
- Adds a SQL parser dependency (e.g. `pgsql-ast-parser` or libpg-query's WASM build) to the engine; to be chosen when building, preferring the official parser.
- Tests: the source, parser rules, limits and approvals run on PGlite with a fake resolver for the address guard; no network.

## Open questions

- Decided 2026-10-19: read-only first. `pg_execute` and `database:write` stay designed here but ship later.
- Schema context: should the connector keep a cached summary of tables and comments that goes into the agent's context, so it doesn't call `pg_list_tables` every run?

## Built (2026-10-19, read-only)

- **Tables** (migration 0076): `db_connections` (address, user, sealed password bound to `db-connection|org|id`, `can_write` from the last test, `off_actions`, `suggested_hidden`), `db_agent_policies` (tables, hidden columns, daily cap, time limit) and `db_queries` (every call: statement, row count, duration, error; never the rows).
- **Driver** (`packages/adapters/src/database.ts`): `DatabaseDriver` → `DatabaseClient.readOnly(limits, fn)`; postgres.js in the server (2 sockets, 5 minutes idle, `application_name = agentes.chat`, TLS `require` without certificate check like libpq, the server name for SNI); `createFakeDatabaseDriver` over PGlite in tests. Adapters get `databases` (always on in the server).
- **Engine** (`packages/engine/src/databases/*`): `connections.ts` (test, create, reconnect, revoke, pool per connection version, `publicHostAddress` in `net-guard.ts` resolves and checks the host on every new pool and the driver connects to that address), `policies.ts`, `guard.ts`, `tools.ts`, `text.ts`.
- **Tool names**: `pg_<slug>_list_tables`, `pg_<slug>_describe_table`, `pg_<slug>_query`, the slug from the connection's label (`databaseSlugs`); `connectorLabel` is the label, so the chat's work steps say "Produção".
- **Parser**: `libpg-query` (Postgres 17's own parser as WASM, ~1.2 MB, no native build). The guard also walks the tree for any other `*Stmt`, `SELECT INTO`, `FOR UPDATE`, blocked functions (sleep, files, signals, advisory locks, large objects, dblink, `query_to_xml` and the other SQL-from-text XML functions, replication) and blocked catalogs (`pg_statistic`, `pg_stats*`, `pg_authid`, `pg_shadow`, user mappings). `SELECT`s run wrapped as `select * from (…) limit 501` with `search_path = public`, so unqualified names are `public.*` for the rules too.
- **Hidden columns**: refused when named (any table in the query that has hidden columns), through `*`/`t.*`, or as a whole-row value (`row_to_json(t)`, `to_jsonb(users)`). Default: on connect the test lists columns whose names look sensitive (password, hash, secret, token, api key, salt, otp, cpf, cnpj, ssn, passport, phone, card, cvv, iban, birth…) into `suggested_hidden`; an agent without saved rules gets them hidden, and the rules step starts from them.
- **Grants**: `database:read` with `connection_id`; never part of "all tools" (`*`), and replacing an agent's other grants keeps it (`notMailGrant` / `mailConnectionIds` now cover databases too). Levels in the app: Sem acesso · Ler.
- **API** (`apps/server/src/routes/app/databases.ts`): list, connect (`422 { error: auth | unreachable | blocked_host | tls | unknown }`), update (label, tools off, new address or password, tested), disconnect, tables, and per agent get/put.
- **Web**: the "Banco de dados" card (Desenvolvimento), the 4-step flow of email (conectar → o que faz → quem pode usar → regras), connected row, Reconectar, Desconectar, and a "Bancos de dados" card on the agent page.

Not done: the private-network path through a connected computer; `pg_execute`; a schema summary in the agent's context (open question above); views or user functions that read hidden columns or other tables are not caught by the rules (the read-only role and the transaction still hold; recommend a role without access to what agents must not read).
