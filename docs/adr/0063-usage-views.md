# 0063. Usage views: each plan account by computer, an agent's month, and its part of a limit

- Status: Accepted. Amended 2026-10-30: §5 (a plan's limits where the budget was); 2026-10-31: §5 (the compact bar's color)
- Date: 2026-10-24
- Extends: ADR 0026 (budget visibility), ADR 0059 (AI accounts belong to people; §7 usage limits)

## Context

ADR 0059 shows each plan account's limits where the account is chosen: the windows the CLIs report (`machine_accounts.usage`, and `machines.executors.ownUsage` for a computer's own sign-in), tightest first. Two questions stay open: how much of an account's limit each agent took, and, for an agent, where its month went (which account, which day, how much through the API). The limit belongs to the account, an agent can move between accounts during a month, and a computer's own sign-in can serve several of its pairer's agents. Plan tokens were recorded per run and agent, but not per account.

## Decision

### 1. Plan tokens say which account they spent

`usage_records.machine_id` and `usage_records.brain_account_id` (nullable, no foreign keys so the history outlives a removed account or computer): set on every plan row, `machine_id` with a null account meaning that computer's own sign-in. API rows keep both null; plan rows from before this have no machine and read as "before accounts were recorded". An account is keyed `machine:kind:account` (`…:computer` for the own sign-in).

### 2. An agent's part of a window is an estimate, and says so

Providers only give the whole account's percentage. An agent's part of a window = the window's percentage × the agent's share of what the account spent since the window started (`resetsAt` minus the window's length: 5 hours, a week, 30 days for a month). Each row weighs what it would cost through the API (catalog prices, so Opus weighs more than Haiku; summed tokens at the base prices, since a sum crosses no long-context threshold); a model without a price (Codex with no model chosen) weighs its tokens at the window's average priced rate, or one each when nothing in the window has a price. A model's own week (`seven_day_opus`, `seven_day_sonnet`) counts only that model. A provider's own window (`other`) has no known length, so it has no estimate. The screens draw an agent's part in full ink inside the account's bar and say in one line that it is an estimate.

### 3. Two views

- **Configurações › Uso**, for every member: the plan accounts grouped by computer (the accounts added there, and a computer's own sign-in that agents used this month or think with now), each with its windows, every agent's part and the month's tokens; then the API per agent against its budget. Admins also keep the API's spend by kind and the default budget.
- **Agent → "Uso"**: one sentence with the month by account, the month day by day colored by account, the account it thinks with now (its windows with this agent's part, and who shares it), and the month by account. The tab informs: changing the account stays in "Quem pensa".

`GET …/usage/plans` and `GET …/agents/{agentId}/usage` serve them. Opening either asks the viewer's own computers for fresh windows, as the accounts screens do (`POST …/ai-accounts/refresh`), and an account's change refreshes both views.

### 4. Who sees what (ADR 0026, ADR 0059)

Everyone in the workspace sees tokens, percentages, windows and an account's name and owner. An account's email only its owner. Money only with `view_usage`: what plan tokens would cost through the API ("≈ US$ … pela API"; the plan is already paid) and the API's real cost and budgets.

### 5. A plan's limits where the budget was

*Amended 2026-10-30.* An agent on a plan showed "0% of the October budget" on its page and in Members, a number that only counts what is paid through an API key. Wherever an agent's usage is a line (its page's facts and side card, Members' agents, its profile card, the phone's agent profile):

- **On a plan**, its account's limits: the account's name and its tightest windows, two at most, in short words ("Claude Team · semana 40% · 5h 12%"), one bar for the fullest, every window on hover and in Uso, and only near the limit (80%) when it renews ("Quase no limite · renova às 14:00", "No limite até 14:00"). A plan's limit is never called a budget.
- **The budget** shows for an agent on the API as before, and for an agent on a plan only once it spent through the API this month (its fallback, or the workspace's model before it moved to the plan), as a second short line after the plan's.
- **Unknown is nothing**: a window not reported yet, or a plan whose maker doesn't share its usage, shows no line rather than 0%. A plan that refused a request before any window was reported says only that it is at the limit (the account's name and "No limite", no bar).
- Settings › AI accounts draws each account and each computer's own sign-in with the same compact line.

The agent list (`GET …/agents`, and the agent an edit returns) carries it in `brain`: `account`, the account's name (a computer's own sign-in by its plan, "Claude Max", only where that sign-in can think for the agent, ADR 0059 §3), and `usage`, the windows the runner last reported (absent while unknown). Everyone sees both, as §4 allows; the computer's name stays admins' and the owner's. The apps refetch the list when a computer's accounts change (`machine.updated` with `accounts`, sent only when a window moved a point or more). No migration and no protocol change. One rule (`usageShown`, `packages/client/src/lib/plan-usage.ts`) and one line (`planLine`, `packages/ui/src/plan-state.ts`, drawn by `PlanMeter compact` on the web and its twin on the phone) serve every place.

*Amended 2026-10-31:* the compact line's one bar and the words under it take the color of the tightest window, or of the limit when the plan refused a request (ADR 0059 §7: amber from 80%, red from 90%), as the full meter's words do.

## Consequences

- Positive: one place answers who spent what, where, for plans and the API together, and an agent's page tells which account carried its month.
- Positive: no new storage for limits and no protocol change: the windows are the ones ADR 0059 already keeps.
- Negative: an agent's part is an estimate. The parts always add up to the window's percentage, so use of the account outside agents (its owner in their own terminal) is split among the agents as if it were theirs; and a window's part rounds to the hour it started.
- Negative: plan usage from before the new columns shows as one source per brain, without its account.

## Alternatives considered

- **A table of limits per account, written from the turns.** It repeats what ADR 0059 already stores with each account. Rejected.
- **Splitting by raw tokens.** Simpler, but it overstates cheap models against a plan. Weighted by API price, tokens as the fallback.
- **Inferring the account from the agent's current choice.** Wrong as soon as an agent moves accounts or several agents share a computer's own sign-in. Rejected.
- **The usage views' own request for a list's lines (§5)** (`GET …/usage/plans`). It reads the month's usage rows to answer what the account rows already hold. Rejected.
- **No budget at all for an agent on a plan (§5).** Its fallback and a month that began on the API spend real money. Rejected: the budget shows once it spent.
