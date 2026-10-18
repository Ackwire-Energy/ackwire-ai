# 0037. Agents investigate before answering

- Status: Accepted (round 1 built)
- Date: 2026-10-18
- Planning: D52
- Extends: ADR 0015 (approvals), ADR 0032 (agent engine), ADR 0034 (agents talk to each other)

## Context

Asked about a bug, agents answered with a plan and "can I take a look?" instead of looking. An audit of what the model reads found the prompt pushing it there:

1. Role presets (copied into `agents.instructions` when an agent is created): Dev "Before touching something big, describes the plan in the channel and waits for an ok"; PM "When context is missing, asks whoever requested before deciding"; QA "If it can't reproduce, asks in the channel…". Ops ran on Haiku.
2. The base prompt said only "Use your tools when they help", and the `ask_user` rule invited a question whenever "key information is missing", which the model read as "ask before looking".
3. "What you can do" ended with "Beyond this, you can't", which is wrong for computer brains (Claude Code, Codex): they also have their own read, search, shell and git tools.
4. Routine runs were framed as status posts: restate, or `NO_REPLY`.
5. The repositories block (`packages/engine/src/git/repos.ts`) says "When nobody names a repository, ask which repository…": owned by the git workstream, to be revised there in the same spirit.

## Decision

**Investigate first; reading never needs an ok; ask only for decisions.**

- A "How you work" block in every agent's prompt when it has tools (`HOW_YOU_WORK`, `context.ts`): look before answering about code, bugs, data or errors (repository, logs, errors, analytics, issues, memory) and cite what was read; come back with findings and a concrete next step ("I can open a PR that changes X in file Y"); ask only for decisions that are the person's (product choices, priorities) or before actions that change things for others; never ask permission to look or for what tools can find; never claim no access to what a tool just returned; chain tool calls in one turn.
- The `ask_user` rule asks only when the request is still ambiguous after looking, when the decision is the person's, or before a sensitive or irreversible action.
- Computer brains: `forComputerBrain` (`capabilities.ts`), applied per turn in `brainTurnOf` (`executor.ts`), swaps the limit line for one that counts the computer's own tools and adds "Your computer's tools": use them freely to read and investigate, no approval needed. The transcript keeps the model brain's text, since a run can fall back to it.
- Routine runs: check the real sources, compare with the last run (recent actions, memory), dig into anything unusual (why, since when, how big), end with a recommendation or what was done; `NO_REPLY` only after checking that nothing changed.
- Role presets (en and pt-BR) rewritten evidence-first: Dev investigates and proposes a PR with a test, opens big changes as a draft PR with the plan instead of waiting for an ok, never merges alone; PM looks things up first and asks only what's left; QA checks errors, recent changes and issues before asking for environment and version; Ops says since when, how big, likely cause and next step; Research (onboarding's Lia) cites sources and recommends. Ops defaults to Sonnet.
- Existing agents: migration 0069 rewrites `agents.instructions` that still equal an old preset text exactly (any locale, including Lia's old one-line description). Edited instructions are left alone. A migration over a boot job: it runs once, is ordered with the schema, and leaves no code behind.

Approvals are unchanged: sensitive actions (merge, deploy, rollback) still wait for a person.

## Behavior eval

Prompt changes are checked against a behavior eval built from the real failures above (`packages/engine/eval/behavior.ts`, `bun run eval:behavior`; manual, never in CI, needs `ANTHROPIC_API_KEY`). Each case (`behavior-cases.json`, plus an optional `behavior-cases.local.json` outside git) seeds an in-memory database with an organization, an agent from a role preset, a conversation (channel, thread, DM or routine run), memory and issues, and runs the real path: `postPersonMessage` → outbox → `executeRun` with the context.ts prompt, "What you can do", the Tool Gateway (scopes, approvals) and the tool loop. Only connectors are fake (GitHub, Sentry, analytics, Railway tools named and scoped like the catalog ones, with canned results); the model is real.

Scoring is deterministic checks (a reading tool before the answer, no asking permission to look, no "I haven't looked", no false "no access", required tools called, evidence cited, sensitive tools held for approval and never run, `NO_REPLY` only when expected) plus a cheap judge model with a rubric per case (looked first, grounded, concrete next step, asks only the person's decisions, case-specific points). The report (per case and per criterion, cost) goes to `packages/engine/eval/out/`. The checkers are unit-tested and the harness runs with the fake provider in `bun test` (no network).

## Later rounds

- **Act with undo:** for reversible actions that only touch the agent's own work (a branch, a draft PR, an issue it opened), act first and offer undo instead of asking.
- Measure it in production too: count `ask_user` calls and replies with no tool call before them on questions about code or errors (the behavior eval covers it before shipping).
- The repositories block in `git/repos.ts`: pick the repository from context (recent work, the issue, the only connected repository) before asking.

## Consequences

- Answers take more tool calls (cost and latency) but come back with evidence; budgets still apply through the Model Gateway.
- Computer brains get a slightly different system text than the model brain for the same run; the prompt-cache prefix for the model brain is unchanged.
