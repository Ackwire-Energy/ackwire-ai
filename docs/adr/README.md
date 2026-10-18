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
| [0017](0017-search-and-context.md) | Search (hybrid Postgres, visibility in SQL), context items, and a self-improving memory loop with outcomes, trust weighting and a human gate |
| [0018](0018-providers-and-default-keys.md) | Several model providers (OpenAI adapter on the Responses API); the workspace default key per provider; one resolution order |
| [0019](0019-file-storage-and-artifacts.md) | File storage per organization (S3/R2 or Postgres, own bucket after a passing test, migration, SSRF guard) and artifacts (versions, visibility, untrusted HTML) |
| [0020](0020-skills.md) | Skills in Markdown (SKILL.md): zip/GitHub/manual import with limits and SSRF guard, versions, load on demand (`load_skill`, `skills:read`), no code execution until the sandbox |
| [0021](0021-code-sandbox.md) | One computer per agent: Daytona (REST) behind `SandboxProvider`, persistent workspace, stop/archive never delete, no secrets or network by default, `sandbox:run` outside "all tools", usage and budget like model calls, skill scripts |
| [0022](0022-forum.md) | Forum: a job drives turns (one run per agent per round, people first), posts are messages of the topic's own channel, synthesis as a Drive document |
| [0023](0023-wiki.md) | Wiki: pages with full history and optimistic saves, `[[links]]` from pages, messages and issues (backlinks, graph, renames keep old links), search kind `wiki`, agents read by default and write only when a person asks |
| [0024](0024-git-proxy.md) | Git in agents' computers through our smart-HTTP proxy: per-computer HMAC credential, credential helper + `insteadOf`, policy in the proxy (`agentes/{handle}/*`, fast-forward only, no tags, repo list), GitHub App or connection token added server-side, audited |
| [0025](0025-connected-computers.md) | Connected computers: computer = lifecycle + channel, a runner over an outbound WebSocket (pairing code, machine token), `pushFile` uploads that never pass through the model, binary `file` kind in the Drive, `upload_file` |
| [0026](0026-budget-visibility.md) | Every agent has a budget (its own or the workspace default); members see percentages, only `view_usage` sees money (Settings → Usage) |
| [0027](0027-secrets-to-agent-computers.md) | Secrets to an agent's computer end to end: `request_secret` suspends the run, a card in the chat, the browser encrypts to a per-request key generated on the computer, the server relays ciphertext only; env/file targets, redaction on the computer, audited, never stored |
| [0028](0028-memory-judgments-with-jev.md) | Memory decisions with Jev: semantic consolidation (same/refines/updates/contradicts with calibrated policy and conflicts for people), facts with validity in time, person and agent profiles, outcome-weighted relevance, Jev-scored injection, capture on signal, memory evals; code keeps visibility and trust, every point falls back to today's behavior |
| [0029](0029-missions.md) | Missions as the control layer of long work in a thread: the executor on the computer (Claude Code, Codex) is the brain; thread from a context range, close and archive; living checklist plan and reviews instead of phases; participants and roles (seeing inherited, acting explicit); background tasks with wake-up and recovery; `agentes` MCP server; `.agentes/` files; no mission budget (proposed) |
| [0030](0030-runner-isolation.md) | Isolation on connected computers: an environment per agent (`GIT_CONFIG_GLOBAL`, agent authorship, credential helper), short-lived GitHub tokens with server-side branch policy so merges need approval, optional OS sandbox per agent (Seatbelt, bubblewrap), dedicated user or VM documented (proposed, after missions) |
| [0031](0031-computer-use.md) | Computer use: one provider-neutral action set mapped to Anthropic's computer/browser toolsets; an agent browser (profile per agent, works at every isolation level), a virtual desktop (Daytona or the owner's VM), and the owner's real desktop as a per-agent opt-in that excludes protected mode for that agent; screenshots in file storage with short retention, live view, Stop/Take over, caps (proposed) |
| [0032](0032-agent-engine-brains.md) | One agent engine with swappable brains (model, Claude Code, Codex): tools only in the Tool Gateway (the runner MCP is a bridge), shared approvals/context/streaming/usage, per-agent brain and model, warning without blocking for plan brains, fallback to the model brain, missions run on the same engine |
| [0033](0033-public-github-app.md) | Public GitHub App: installations bound to the org that installed them from the app (state + user authorization + `/user/installations` check), tokens only for bound, unsuspended installations, webhook for uninstall/suspend/repositories |
| [0034](0034-agents-consult-each-other.md) | Agents talk to each other: `ask_agent` (private DM between two agents, the asker waits, no cycles, 2 deep, 15 min), a clear router pick beats a low need-any-agent score, up to 4 agents per message, an agent's message may bring in one more agent (D5 revised) |
| [0035](0035-mobile-app.md) | Mobile app: Expo + React Native in `apps/mobile`, logic shared with the web (`@agenteschat/client`, `i18n`, `tokens`, the agent engine through Skia), app sessions via the Better Auth Expo plugin with `X-Agentes-Client` instead of `Origin`, push through the outbox, account deletion and Sign in with Apple |
| [0036](0036-desktop-app.md) | Desktop app: Tauri 2 in the menu bar (`apps/desktop`, React DOM on the shared packages), the runner compiled and run as the app's child process (no OS service in desktop mode), stdio control channel and `config.json` as the single source, one runner per organization, device-code sign-in started by the computer, pause (protocol 9), local activity log, updates signed with our key and served by our server from the private release; macOS first, unsigned for now |
| [0037](0037-agents-investigate-before-answering.md) | Agents investigate before answering: a "How you work" block (look first, cite, reads never need an ok, ask only for decisions), `ask_user` only after looking, computer brains told their own tools are allowed, routines dig instead of restating status, evidence-first role presets (migration 0069 updates unedited agents) |
| [0038](0038-agent-mailbox-access.md) | Agents use people's mailboxes: Composio (explicit actions only, no meta-tools) for Gmail/Outlook, our IMAP/SMTP connector (app password, read-only `EXAMINE`/`BODY.PEEK`, presets) for iCloud and the rest, per-call checks for folders/recipients/caps, send always asks by default, inbound mail into routines as untrusted data; built with `checkCall` (accepted) |
