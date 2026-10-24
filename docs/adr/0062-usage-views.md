# 0062. Usage views: each plan account by computer, an agent's month, and its part of a limit

- Status: Accepted
- Date: 2026-10-24
- Extends: ADR 0026 (budget visibility), ADR 0059 (AI accounts belong to people; §7 usage limits)

## Context

ADR 0059 shows each plan account's limits where the account is chosen: the windows the CLIs report (`machine_accounts.usage`, and `machines.executors.ownUsage` for a computer's own sign-in), tightest first. Two questions stay open: how much of an account's limit each agent took, and, for an agent, where its month went (which account, which day, how much through the API). The limit belongs to the account, an agent can move between accounts during a month, and a computer's own sign-in can serve several of its pairer's agents. Plan tokens were recorded per run and agent, but not per account.

## Decision

### 1. Plan tokens say which account they spent

`usage_records.machine_id` and `usage_records.brain_account_id` (nullable, no foreign keys so the history outlives a removed account or computer): set on every plan row, `machine_id` with a null account meaning that computer's own sign-in. API rows keep both null; plan rows from before this have no machine and read as "before accounts were recorded". An account is keyed `machine:kind:account` (`…:computer` for the own sign-in).

### 2. An agent's part of a window is an estimate, and says so

Providers only give the whole account's percentage. An agent's part of a window = the window's percentage × the agent's share of what the account spent since the window started (`resetsAt` minus the window's length: 5 hours, a week, 30 days for a month). Each row weighs what it would cost through the API (catalog prices, so Opus weighs more than Haiku); a model without a price weighs its tokens. A model's own week (`seven_day_opus`, `seven_day_sonnet`) counts only that model. A provider's own window (`other`) has no known length, so it has no estimate. The screens draw an agent's part in full ink inside the account's bar and say in one line that it is an estimate.

### 3. Two views

- **Configurações › Uso**, for every member: the plan accounts grouped by computer (the accounts added there, and a computer's own sign-in that agents used this month or think with now), each with its windows, every agent's part and the month's tokens; then the API per agent against its budget. Admins also keep the API's spend by kind and the default budget.
- **Agent → "Uso"**: one sentence with the month by account, the month day by day colored by account, the account it thinks with now (its windows with this agent's part, who shares it, and "Trocar conta" for whoever may change its brain), and the month by account.

`GET …/usage/plans` and `GET …/agents/{agentId}/usage` serve them. Opening either asks the viewer's own computers for fresh windows, as the accounts screens do (`POST …/ai-accounts/refresh`), and an account's change refreshes both views.

### 4. Who sees what (ADR 0026, ADR 0059)

Everyone in the workspace sees tokens, percentages, windows and an account's name and owner. An account's email only its owner. Money only with `view_usage`: what plan tokens would cost through the API ("≈ US$ … pela API"; the plan is already paid) and the API's real cost and budgets.

## Consequences

- Positive: one place answers who spent what, where, for plans and the API together, and an agent's page tells which account carried its month.
- Positive: no new storage for limits and no protocol change: the windows are the ones ADR 0059 already keeps.
- Negative: an agent's part is an estimate; the account's own use outside agents (its owner on the same plan) counts as nobody's, and a window's part rounds to the hour it started.
- Negative: plan usage from before the new columns shows as one source per brain, without its account.

## Alternatives considered

- **A table of limits per account, written from the turns.** It repeats what ADR 0059 already stores with each account. Rejected.
- **Splitting by raw tokens.** Simpler, but it overstates cheap models against a plan. Weighted by API price, tokens as the fallback.
- **Inferring the account from the agent's current choice.** Wrong as soon as an agent moves accounts or several agents share a computer's own sign-in. Rejected.
