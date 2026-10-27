# 0018. Several model providers; the workspace's default key per provider

- Status: Accepted
- Date: 2026-10-14
- Extends 0007 and 0012.

## Decision

**Providers.** `PROVIDERS` lists the model providers (Anthropic, OpenAI); each catalog model names its provider, prices, and flags (`cheap`, `recommended`, `reasoning`). Adapters implement the neutral `ModelProvider`. The OpenAI adapter uses the Responses API (official SDK): `instructions` from the system blocks; neutral `tool_use`/`tool_result` mapped to `function_call`/`function_call_output`; stateless (`store: false`) with encrypted reasoning items kept as `opaque` blocks and replayed in tool loops (blocks of another provider are dropped); `outputSchema` → strict JSON Schema; `effort` → `reasoning.effort` on reasoning models; usage split into uncached input, cached input and cache writes; partial usage on a broken stream; optional organization/project headers. The Anthropic workspace id and the OpenAI organization/project live on the credential.

**Resolution order** for every model call (agent runs, router fallback, summaries, reflection): the agent's own credential (its provider must match the model's) → the workspace's default key **for that provider** (`organization_settings.default_credential_ids[provider]`, then the legacy single `default_credential_id` if it is of that provider, then the org's newest key of that provider) → the platform key for that provider, only if configured. When nothing resolves, the call fails with a message the UI shows as is ("Configure uma chave da API da OpenAI nas configurações do workspace").

**Defaults.** Creating a key can make it its provider's default in the same call (`makeDefault`, used by onboarding); `POST …/credentials/{id}/make-default` switches it. A default key can't be revoked or deleted until another is the default (409). The org's own calls use the configured cheap model of the provider of its default key (`ROUTER_MODEL`/`SUMMARY_MODEL` for Anthropic, `OPENAI_CHEAP_MODEL` for OpenAI) unless the org overrides them. `GET …/organizations/{orgId}/models` marks each model `available` (the org has a key for its provider, or the platform does) and `recommended`.

**Platform-billed usage.** `usage_records.billed_to` is `org` or `platform`; internal services the server's own keys pay for (Jev, with the installation's TypeSafe key since ADR 0073) are recorded per org with `billed_to = platform` and kept out of the org's usage total.
