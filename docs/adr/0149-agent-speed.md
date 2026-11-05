# 0149. Velocidade: a per-agent speed setting

- Status: Accepted (built)
- Date: 2026-11-05
- Extends: ADR 0041 (accounts and effort), ADR 0086 ("Configuração avançada"), ADR 0121 (long work)
- Code: db `packages/db/src/schema/agents.ts` (`agents.brain_speed`, migration `0224_agent_speed.sql`); `packages/providers/src/plans.ts`, `packages/engine/src/brains/select.ts`, `apps/server/runner/brain-codex.ts`, `brain-codex-app.ts`

## Context

People on a ChatGPT plan want some agents to answer faster. OpenAI's Fast mode serves the same model faster and spends the plan's limits at 2.5× the standard rate.

## Decision

- `agents.brain_speed` (`standard`, `fast`), off by default, next to the effort. Not on `right_hand_brains`: the right hand has no such setting. A new agent never inherits it (`setupOfAgent` leaves it out); "Usar em outros agentes" carries it.
- It applies when `speedFits` says so (`packages/providers/src/plans.ts`): Codex on a ChatGPT sign-in, with a model on `FAST_MODE_MODELS`. Anywhere else the control hides, nothing is sent and the value stays.
- It applies to replies in conversations only (`brainSpeedFor`). A routine, background or long work (`run.background`, `run.workId`), a run a routine started and a mission stay at standard speed: they would spend the plan 2.5× with nobody waiting. A conversation turn that is already running when it moves to the background ends at the speed it started with.
- The turn carries `speed` from protocol 46 (`SPEED_PROTOCOL`). `codex exec`: `-c service_tier="fast" -c features.fast_mode=true`. `codex app-server`: `serviceTier` on every `turn/start`, `null` otherwise, because a thread keeps its tier until told.
- A turn the account or model refused at that speed goes again once at standard speed from `runCodexTurn` (both routes), and the reply says so under it (`meta.speedFallback`). Codex itself drops the tier for a model that doesn't list it, without a word: nothing to do there.

## What was checked

With codex-cli 0.165.0 and 0.166.0 against a local fake provider, no account: `service_tier="fast"` goes out as `service_tier: "priority"`, an unlisted model goes out without it, and a 400 comes back in `turn.failed` (exec) and `error` (app-server) with the provider's words. No turn has run on a real plan, so what a real refusal says is unknown: `CODEX_FAST_REFUSED` looks for `service_tier` or `fast mode`.

## Later

Claude's fast mode, API keys and Ultrafast: a new value in `BRAIN_SPEEDS` and a new branch in `speedFits`.
