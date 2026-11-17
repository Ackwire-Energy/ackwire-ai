# 0174. Command Code: one key for many makers' models, Claude and the rest

- Status: Proposed
- Date: 2026-11-12
- Extends 0007, 0018 and 0087.
- Code: `packages/providers/src/commandcode.ts` (`createCommandCodeProvider`, `commandCodeModelOf`), `packages/providers/src/catalog.ts` (`commandcode` in `PROVIDERS`, its catalog rows), `packages/providers/src/index.ts`, `packages/providers/src/openrouter.ts` (`isOpenRouterModel`), `packages/providers/src/anthropic.ts` (a compatible endpoint's history breakpoints), `packages/engine/src/router.ts` (`SMALL_MODEL_ORDER`), `packages/client/src/lib/providers.ts`, `packages/ui/src/brand/marks.ts`, `packages/i18n`

## Context

Command Code sells a coding agent whose subscriptions are usage credits at each maker's API rates, and its Provider API (commandcode.ai/docs/provider-api, read 2026-11-12) takes the same key from any client: Claude, GPT, Gemini, DeepSeek, GLM, Kimi, Qwen and others. People who pay for it want their agents to think with it.

A workspace's own endpoint (ADR 0146) can't carry it. Command Code serves Claude only on Anthropic Messages (`/v1/messages`) and every other model only on Chat Completions (`/v1/chat/completions`); the wrong route answers 400. An endpoint speaks one API, so half the models always fail. And an endpoint's models are never Automático's, the router's or the summaries' picks, so a workspace whose only key is an endpoint's has an agent on Automático fail with `no_ai` (issue #183).

Its `/v1/models` lists each model's routes (`supported_endpoints`) and context window, but no prices. Its prices are a table in its docs (commandcode.ai/docs/resources/pricing-limits).

## Decision

1. **A catalog provider, `commandcode`,** with its own adapter (protocol `commandcode`). A model's id is `commandcode:<its own id>` (`commandcode:claude-sonnet-5-5`, `commandcode:zai-org/GLM-5.3`): Command Code's Claude and GPT ids are the makers' own, which the catalog already has under Anthropic and OpenAI at their own key's terms. The prefix also keeps an id with a slash from reading as OpenRouter's (`isOpenRouterModel`).
2. **One adapter, two routes, no new SDK.** `createCommandCodeProvider` sends a `claude-` model to Anthropic's adapter in its compatible mode, as DeepSeek, Kimi, Z.ai and MiniMax (base `https://api.commandcode.ai/provider`, `x-api-key`; it honors `tool_choice: any`, so structured output is a forced tool) and every other model to the Chat Completions adapter OpenRouter uses, in its compatible mode (ADR 0146 §4: base `…/provider/v1`, no attribution or routing fields, `stream_options.include_usage`). Its own id is sent; the full `commandcode:` id comes back, so the catalog prices the call. A cost field in the answer is ignored.
3. **A few models in the catalog, at Command Code's published rates,** not its whole list, since the list carries no prices and we never make a call we can't price. Open models first, as Command Code itself: Automático's tiers are DeepSeek V4.1 Flash (small, the system tasks' cheap model), GLM-5.3 (medium, recommended) and Claude Sonnet 5.5 (large); Claude Haiku 5.5 routes and judges (thinking off, a forced tool). Opus 5.5, GPT-6.1 Sol, GPT-6 Luna, Kimi K3.1 Pro and K2.7 Code (and HighSpeed), DeepSeek V4 Pro, V4.1 Flash Fast and Ultrafast, GLM-5.3 Flash and FlashX, MiniMax M3.1 Flash, MiMo V2.6 Pro (and UltraSpeed) and Flash, Muse Spark 1.3 (and Contributor), Spark Open and Ember, and Gemini 3.8 Flash are choosable. GLM-5.3 FlashX, MiniMax M3.1 Flash and the MiMo models don't follow a JSON schema (`structuredOutput: false`). A price below a thousandth of a dollar per million tokens rounds up. Where its table lists no cache write, the input's rate counts. Claude Haiku 5.5, GPT-6.1 Sol and GPT-6 Luna keep their makers' long-context prices above a long prompt, as the makers' own rows. DeepSeek V4 Flash Vision is left out: the Chat Completions path sends no images, so it would see none. DeepSeek's models through it cost full price from 01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays and half the rest of the time: their rows carry the peak prices, which budget reservations use, and the off-peak ones the cost of a call made outside those hours takes (`offPeak`).
4. **Its key** is a provider key like any other (ADR 0007), checked on save with the cheap model. Its keys are `user_` and letters, digits, `_` or `-`; the client checks that shape.
5. **Routing order:** a workspace with only a Command Code key routes with it; it comes after the makers' own keys and before OpenRouter (`SMALL_MODEL_ORDER`).

Checked against the live API before this was written: Claude Haiku with a forced tool on `/v1/messages`, a non-Claude model refused there (400), DeepSeek V4.1 Flash with tools and streamed usage, and a strict JSON schema on Chat Completions; then, through the adapter, text, a JSON schema and tools on DeepSeek V4.1 Flash, GLM-5.3, Claude Haiku 5.5 and Claude Sonnet 5.5.

## Consequences

- A Command Code key works with Automático, routing, the judge and summaries, like a maker's own key.
- Its model list and prices change; the catalog rows are a code change, as for the other catalog providers.
- Images don't reach Claude through the compatible mode, as for the other Anthropic-compatible providers.
- Anthropic's API behind Command Code refuses a 1-hour cache breakpoint after a 5-minute one, so on any compatible endpoint the history's breakpoints stay at 5 minutes, as the system's and the tools' (`anthropic.ts`).
- Command Code's Go plan has no API access: a Go key is refused when saved (403). Some models need a larger plan or on-demand usage (Claude Opus 5.5 from its Provider plan, GPT-6.1 Sol from Max): a call answers 403 `MODEL_NOT_IN_PLAN`, in Command Code's words, and the key's other models go on answering.
- The pickers list some models twice, under Claude's or OpenAI's name and under Command Code's, each in its provider's group.
- Its mark is the symbol from its brand page, one color, so it takes the theme's ink (ADR 0059 §9).

## Alternatives considered

- **A coding plan through Claude Code** (ADR 0059 §8). Claude Code speaks Anthropic Messages, where Command Code serves Claude alone: every other model would be missing. Command Code's own CLI as a computer brain, as OpenCode's (ADR 0132), would carry all of them; that is its own decision.
- **Its whole list, read at run time, as OpenRouter's (ADR 0087).** Without prices in the list each model would be unpriced, and its calls would cost 0 to the budget.
- **Two endpoints of a workspace (ADR 0146), one per API.** Two keys to manage for one account, still never Automático's or the router's picks.
- **Claude through Chat Completions too.** Command Code refuses Claude there.
