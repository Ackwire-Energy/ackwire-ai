# agentes (domínio agentes.chat)
Workspace estilo Slack/Teams onde pessoas e agentes de IA trabalham juntos.
O produto usa design system próprio (`docs/design`): botões, inputs, ícones, tudo original.

## Stack
Bun + Hono + Drizzle, front Vite + React + TanStack, WebSocket nativo do Bun, Better Auth (ADR 0011). Postgres é a única dependência no self-host (fila em outbox no Postgres, ADR 0005); Redis e Turbopuffer só como módulos da Cloud.
Código aberto: AGPL-3.0-only em tudo o que é público, contribuições sob a mesma licença, sem `ee/` (ADR 0002). Self-host por docker-compose, 100% grátis (`SELF_HOSTING.md`); a Cloud é a mesma imagem com variáveis de ambiente. O self-host funciona só com Postgres: serviço externo é opcional, ligado por variável, atrás das interfaces/módulos (adaptadores trocáveis).

## Conceitos
- Organização (multi-tenant): tudo tem org_id. Contexto da org entra no prompt de todos os agentes.
- Agente: papel, instruções, modelo, credencial, conectores/escopos, orçamento, humano responsável.
- Credenciais de provedor ficam no nível da org, cifradas; agente aponta para uma (ou para a chave da plataforma).
- Roteador: modelo barato e fixo decide quem responde (0 a 2 agentes). Nunca concede permissão.
- Conectores em 2 camadas: org conecta o MCP uma vez; cada agente recebe subconjunto de escopos.
- Ações sensíveis (merge, deploy, rollback) sempre viram pedido de aprovação humana no chat.
- Issues, fórum, Drive (relatório, organograma, tabela, diff) e rotinas via jobs agendados.

## Ambiente e testes
- Os testes não precisam de Docker nem de Postgres local; credenciais reais só no `.env`.
- Testes unitários obrigatórios; rodam em PGlite em memória + fakes, sem `.env`, sem rede.
- Para corrigir uma falha, rode um arquivo de teste por vez (`bun test caminho/do/arquivo.test.ts`); a verificação completa roda no CI do GitHub.
- Desenvolvimento local usa um `DATABASE_URL` próprio, nunca o de produção.
- Migrations commitadas são imutáveis; qualquer mudança vai numa migration nova.

## Regras
- Nunca expor chaves no client. Todo acesso a modelo/MCP passa pelo backend.
- Cada chamada de modelo registra tokens e custo com agent_id e org_id.

Decisões de arquitetura: `docs/adr/` (manter atualizado).

## Backend (English): where things live

Product name in code and docs: **agentes.chat**. Package scope `@agenteschat/*`. Public repo `agentes-chat`; the Cloud runs this same image with env vars (ADR 0002). Backend decisions: `docs/adr/`.

### Non-negotiables

- PostgreSQL is the only required dependency (no Redis/BullMQ in core). Jobs = Postgres outbox, in-process workers (ADR 0005).
- `apps/` and `packages/` never import `ee/` or any cloud package (`bun run check:boundaries`). With no contributor license agreement, anything in the server process must be AGPL, so Cloud-only behavior is public code switched on by env vars (through `AgentesModule` and adapters) or a separate private service over the network, never a private in-process module (ADR 0002).
- Every tenant-owned table has `org_id` (a test enforces it).
- Model calls go only through the Model Gateway (`packages/engine/src/gateway.ts`): budget checked before the call, usage + cost recorded with `org_id` and `agent_id`. Provider keys are encrypted per org (envelope encryption) and never returned to clients (ADR 0007).
- Env vars only in `packages/config/src/schema.ts`, then `bun run docs:env` (regenerates `.env.example`).
- Every file outside `PRIVATE_PATHS` (`scripts/check-boundaries.ts`) is public, comments included: cite the ADR or state the reason, never a private planning id, prototype screen or internal name (`bun run check:boundaries` fails on them).
- Tests need no Docker or local Postgres: they run on in-memory PGlite and a fake model provider; no `.env` and no network needed. Real credentials go in `.env` (only `dev`/`start` read it).

### Commands

`bun test` · `bun run typecheck` · `bun run lint` · `bun run format` · `bun run check:boundaries` · `bun run check:licenses` · `bun run db:generate <name>` · `bun run docs:env` · `bun run dev`

Run lint, typecheck, tests and boundaries before declaring work done.

### Map

- Boot: `apps/server/src/start.ts` (`startServer`: config → DB → migrations → adapters + module overrides → HTTP + WebSocket → workers). Self-host entry: `src/main.ts`.
- HTTP app: `apps/server/src/app.ts` (`createApp`, testable via `app.request`). Private web-app API: `src/routes/app/*` (`/api/app/*`, `createRoute` from `@hono/zod-openapi`, cookie session + CSRF in `routes/app/context.ts`). OpenAPI at `/api/openapi.json`.
- Auth: `apps/server/src/auth.ts` (Better Auth at `/api/auth/*`). Orgs, roles, invitations, sign-up policy: `packages/engine/src/organizations.ts`.
- WebSocket: `apps/server/src/realtime/ws.ts` (`/api/ws?orgId=`; subscribe per channel; events in `packages/engine/src/events.ts`).
- Workers: `apps/server/src/workers.ts`. Job handlers: `packages/engine/src/jobs.ts`; outbox: `outbox.ts`.
- Agent flow: `messages.ts` (post + mentions + outbox) → `dispatch.ts` (runs, hop limit) → `executor.ts` (context from `context.ts`, gateway, deltas, persist) with states in `runs.ts`. Cancel and "stop and send" (turn interrupt) in `cancel.ts`, "Continuar" in `continue-run.ts`; read receipts for messages sent mid-run: `packages/client/src/realtime/steer.ts` (ADR 0029).
- Credentials and crypto: `packages/engine/src/credentials.ts`, `crypto.ts`. Model catalog and prices: `packages/providers/src/catalog.ts`; Anthropic adapter `anthropic.ts`; fake for tests `fake.ts` (`@agenteschat/providers/testing`).
- Adapters (search, pub/sub, presence, rate limiter, key wrapper, platform credentials): `packages/adapters/src`. Module API: `packages/modules/src/index.ts`.
- DB schema: `packages/db/src/schema/*`; migrations `packages/db/migrations` (0000 is hand-edited for `messages` partitioning, ADR 0009). Import Drizzle operators from `@agenteschat/db`, never `drizzle-orm` directly.
- Tools and approvals: `packages/engine/src/tools/*` (Tool Gateway, scopes, JSON Schema), `approvals.ts`; runs are tool loops with an append-only transcript (`executor.ts`). Connectors (MCP): `src/connectors/*`. Router: `router.ts` (`RouterStrategy`).
- Notifications: `packages/engine/src/notifications.ts` (inbox, grouping, counts, auto-resolve) and `notification-producers.ts` (hooks per flow; chat via the `notifications.message` job); routes `apps/server/src/routes/app/notifications.ts`; per-user realtime on `userTopic`.
- Phone app (ADR 0035): app sessions = no `Origin` + `X-Agentes-Client: mobile` + cookie (`requestOriginAllowed` in `routes/app/context.ts`, also the WS upgrade), Expo and Apple sign-in in `auth.ts`; push = `push_devices`, `packages/engine/src/push.ts` (`push.send` job, enqueued from `notify`) + `push-messages.ts` (pt-BR/en text), `PushSender` in `packages/adapters/src/push.ts`, routes `routes/app/push.ts`; account deletion `deleteAccount` (`organizations.ts`) at `DELETE /api/app/account`.
- Mac app main window (ADR 0036): the window loads the site itself, no app commands (`apps/desktop/src-tauri/src/main_window.rs`, `capabilities/main.json`); web side `apps/web/src/lib/desktop.ts`, `DesktopTitleBar.tsx`, `desktop.css`; Google/Apple sign-in through the browser = Better Auth plugin `apps/server/src/desktop-sign-in.ts` (`/api/auth/desktop/handoff` + `/redeem`, verifier/challenge) and route `desktop.sign-in.tsx`. "This Mac" bridge: `this_mac` (Rust checks + relays) → popover `apps/desktop/src/control/this-mac.ts`; web `ThisMac.tsx`.
- Databases (ADR 0039, read-only Postgres): driver `packages/adapters/src/database.ts`; `packages/engine/src/databases/*` (connections + pool, per-agent rules, `guard.ts` with libpg-query, `pg_<slug>_*` tools); routes `apps/server/src/routes/app/databases.ts`; web `DatabaseConnect.tsx`, `DatabaseRules.tsx`, agent page `DatabaseAccess.tsx`.
- Search and memory: `search.ts` + `packages/adapters/src/search.ts` (hybrid Postgres); `src/context/*` (items, summaries, reflect, consolidate, feedback, proposals, outcomes, agent tools). DMs: `dms.ts`. Email: `email.ts` + `packages/adapters/src/email.ts` (MillionSend, via outbox).
- Connected computers (ADR 0025): rows, pairing, targets `packages/engine/src/machines.ts`; socket hub (local + cross-replica `machine_rpc`) `machine-hub.ts`; provider `machine-provider.ts`; Bun socket `apps/server/src/realtime/machines.ts`; routes `apps/server/src/routes/machines.ts`; runner `apps/server/runner/`.
- Hot path: message insert is one SQL statement that also starts mention/DM runs (`insertMessageWithRuns`); per-process caches in `cache.ts` (on in the server, off in tests); per-run query/stage profile (`profile.ts`, `@agenteschat/db` `queryTrace`). `bun run smoke` checks a real environment.
- Test helpers: `packages/db/test/pglite.ts`, `packages/engine/test/fixtures.ts`, `apps/server/test/harness.ts`.
- Frontend: `apps/web` and `packages/ui`; the server serves the built SPA from `WEB_DIR`.
