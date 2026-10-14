# agentes (domínio agentes.chat; antes "Colmeia")
Workspace estilo Slack/Teams onde pessoas e agentes de IA trabalham juntos.
Protótipo de referência: docs/prototipo/colmeia.html — só para fluxos e conteúdo. O visual dele (componentes genéricos estilo Slack) não é referência: o produto real usa design system próprio (botões, inputs, ícones, tudo original).

## Stack
Mesma base do Tierbird (D18/D20 em docs/planejamento.md): Bun + Hono + Drizzle, front Vite + React + TanStack, WebSocket nativo do Bun, Better Auth. Postgres é a única dependência no self-host (fila em outbox no Postgres); Redis e Turbopuffer só como módulos da Cloud.
Por enquanto: código fechado, só Cloud (D25 em docs/planejamento.md). Open source entra depois; pendências em "Pendências para o open source" no planejamento. Manter as interfaces/módulos (adaptadores trocáveis), mas sem gastar esforço em self-host agora.

## Conceitos
- Organização (multi-tenant): tudo tem org_id. Contexto da org entra no prompt de todos os agentes.
- Agente: papel, instruções, modelo, credencial, conectores/escopos, orçamento, humano responsável.
- Credenciais de provedor ficam no nível da org, cifradas; agente aponta para uma (ou para a chave da plataforma).
- Roteador: modelo barato e fixo decide quem responde (0 a 2 agentes). Nunca concede permissão.
- Conectores em 2 camadas: org conecta o MCP uma vez; cada agente recebe subconjunto de escopos.
- Ações sensíveis (merge, deploy, rollback) sempre viram pedido de aprovação humana no chat.
- Issues, fórum, Drive (relatório, organograma, tabela, diff) e rotinas via jobs agendados.

## Ambiente e testes
- Nunca rodar Docker, Colima ou Postgres local nesta máquina. Credenciais de Postgres e outros serviços vêm depois no `.env` (fornecidas pelo usuário).
- Testes unitários obrigatórios; rodam em PGlite em memória + fakes, sem `.env`, sem rede.

## Regras
- Nunca expor chaves no client. Todo acesso a modelo/MCP passa pelo backend.
- Cada chamada de modelo registra tokens e custo com agent_id e org_id.

Decisões de arquitetura e infra: docs/planejamento.md (manter atualizado).

## Backend (English): where things live

Product name in code and docs: **agentes.chat**. Package scope `@agenteschat/*`. Public repo `agentes-chat`, private Cloud repo `agentes-chat-cloud` (this repo as its `core/` submodule). Backend decisions: `docs/adr/`.

### Non-negotiables

- PostgreSQL is the only required dependency (no Redis/BullMQ in core). Jobs = Postgres outbox, in-process workers (ADR 0005).
- `apps/` and `packages/` never import `ee/` or any cloud package (`bun run check:boundaries`). Cloud extends through `AgentesModule` and adapters (ADR 0002).
- Every tenant-owned table has `org_id` (a test enforces it).
- Model calls go only through the Model Gateway (`packages/engine/src/gateway.ts`): budget checked before the call, usage + cost recorded with `org_id` and `agent_id`. Provider keys are encrypted per org (envelope encryption) and never returned to clients (ADR 0007).
- Env vars only in `packages/config/src/schema.ts`, then `bun run docs:env` (regenerates `.env.example`).
- Do NOT run Docker, Colima or a local Postgres. Tests run on in-memory PGlite and a fake model provider; no `.env` and no network needed. Real credentials go in `.env` (only `dev`/`start` read it).

### Commands

`bun test` · `bun run typecheck` · `bun run lint` · `bun run format` · `bun run check:boundaries` · `bun run db:generate <name>` · `bun run docs:env` · `bun run dev`

Run lint, typecheck, tests and boundaries before declaring work done.

### Map

- Boot: `apps/server/src/start.ts` (`startServer`: config → DB → migrations → adapters + module overrides → HTTP + WebSocket → workers). Self-host entry: `src/main.ts`.
- HTTP app: `apps/server/src/app.ts` (`createApp`, testable via `app.request`). Private web-app API: `src/routes/app/*` (`/api/app/*`, `createRoute` from `@hono/zod-openapi`, cookie session + CSRF in `routes/app/context.ts`). OpenAPI at `/api/openapi.json`.
- Auth: `apps/server/src/auth.ts` (Better Auth at `/api/auth/*`). Orgs, roles, invitations, sign-up policy: `packages/engine/src/organizations.ts`.
- WebSocket: `apps/server/src/realtime/ws.ts` (`/api/ws?orgId=`; subscribe per channel; events in `packages/engine/src/events.ts`).
- Workers: `apps/server/src/workers.ts`. Job handlers: `packages/engine/src/jobs.ts`; outbox: `outbox.ts`.
- Agent flow: `messages.ts` (post + mentions + outbox) → `dispatch.ts` (runs, hop limit) → `executor.ts` (context from `context.ts`, gateway, deltas, persist) with states in `runs.ts`.
- Credentials and crypto: `packages/engine/src/credentials.ts`, `crypto.ts`. Model catalog and prices: `packages/providers/src/catalog.ts`; Anthropic adapter `anthropic.ts`; fake for tests `fake.ts` (`@agenteschat/providers/testing`).
- Adapters (search, pub/sub, presence, rate limiter, key wrapper, platform credentials): `packages/adapters/src`. Module API: `packages/modules/src/index.ts`.
- DB schema: `packages/db/src/schema/*`; migrations `packages/db/migrations` (0000 is hand-edited for `messages` partitioning, ADR 0009). Import Drizzle operators from `@agenteschat/db`, never `drizzle-orm` directly.
- Tools and approvals: `packages/engine/src/tools/*` (Tool Gateway, scopes, JSON Schema), `approvals.ts`; runs are tool loops with an append-only transcript (`executor.ts`). Connectors (MCP): `src/connectors/*`. Router: `router.ts` (`RouterStrategy`).
- Search and memory: `search.ts` + `packages/adapters/src/search.ts` (hybrid Postgres); `src/context/*` (items, summaries, reflect, consolidate, feedback, proposals, outcomes, agent tools). DMs: `dms.ts`. Email: `email.ts` + `packages/adapters/src/email.ts` (MillionSend, via outbox).
- Hot path: message insert is one SQL statement that also starts mention/DM runs (`insertMessageWithRuns`); per-process caches in `cache.ts` (on in the server, off in tests); per-run query/stage profile (`profile.ts`, `@agenteschat/db` `queryTrace`). `bun run smoke` checks a real environment.
- Progress log for the user (Portuguese): `docs/backend-progress.md`.
- Test helpers: `packages/db/test/pglite.ts`, `packages/engine/test/fixtures.ts`, `apps/server/test/harness.ts`.
- Frontend (`apps/web`, `packages/ui`) is a separate workstream; the server serves the built SPA from `WEB_DIR`.
