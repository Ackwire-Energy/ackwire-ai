# Evals

Manual, never in CI: they call real models and cost a little. Keys come from `.env`.

- `bun run eval:memory`: memory judgments (ADR 0028).
- `bun run eval:mentions`: an agent's @mention of another agent, hand-off (it gets a run) or only a reference (ADR 0034). `--judge llm` scores the fallback instead of Jev.
- `bun run eval:behavior`: agent behavior: investigate before answering, cite evidence, concrete next step, ask only the person's decisions, sensitive actions only with approval (ADR 0037). Needs `ANTHROPIC_API_KEY`.

## Behavior eval

```
bun run eval:behavior                                  # all cases
bun run eval:behavior --only dev-read-full-file,pm-feedback-theo
bun run eval:behavior --model claude-opus-5-5          # every agent on this model (or EVAL_AGENT_MODEL)
bun run eval:behavior --judge-model claude-sonnet-5-5  # default claude-haiku-5-5 (or EVAL_JUDGE_MODEL)
bun run eval:behavior --no-judge --max-turns 8         # deterministic checks only; tool-loop cap (default 12)
bun run eval:behavior --judge llm                      # grade with the LLM judge instead of Jev (default jev; `both` compares)
bun run eval:behavior --concurrency 3                  # cases at a time (default 5, or EVAL_CONCURRENCY)
bun run eval:behavior --tools-on-demand                # tools on demand as in production (ADR 0043; Jev picks the groups)
```

The totals line also says what the agent's calls carried (model calls, prompt tokens per call, cache read and write, output), so two runs (with and without `--tools-on-demand`, or before and after a prompt change) compare in tokens as well as in behavior.

Judges: with `TYPESAFE_API_KEY` the addressee classification uses Jev like production, and the grading too (a probability per criterion, pass at 0.5, no written reason; `--judge both` also asks the LLM and prints where they differ). Without the key both use the LLM (the output says so). Each case has its own in-memory database and fakes, so cases run in parallel; model calls refused for load (429, overloaded) are retried with backoff.

Each case runs on a fresh in-memory database through the real engine (`behavior-run.ts`): the agent's prompt is built by `context.ts` and `capabilities.ts`, tools go through the Tool Gateway (scopes, approvals), the tool loop is `executeRun`. Only connector tools are fake (`behavior-fakes.ts`: GitHub, Sentry, Himetrica, Railway, named and scoped like the real ones). Memory, issues, `ask_user` and `react` are the real built-ins.

Output: PASS/FAIL per case with each check (printed as each case ends), totals per criterion, wall time and cost (grading cost apart); the full report (tool calls with inputs and results, replies, the first system prompt) goes to `eval/out/behavior-*.json` (ignored by git). Exit code 1 when any case fails.

### A case (`behavior-cases.json`; private real cases in `behavior-cases.local.json`, ignored by git)

| Field | What |
| --- | --- |
| `agent` | `preset` (`dev`, `ops`, `qa`, `pm`: name, role and instructions from the pt-BR presets), or `name`/`role`/`instructions`; `model` |
| `org` | `name`, `context` |
| `conversation` | `where` (`channel` or `dm`), `channel`, `topic`, `thread` (prior messages after the first and the trigger go in its thread), `prior` (history: `author` is a person's name or `"agent"`; they start no runs), `trigger`, `routine: { name }` (the trigger is a routine's scheduled message), `consultation: { from, origin }` (the trigger is another agent's `ask_agent` question on behalf of the person who wrote `origin`) |
| `otherAgents` | other agents in the org and the channel (`name`, `handle`, `role`, `instructions`); runs the trigger starts for them are recorded, never executed |
| `routines` | routines already there (`agent`: a handle or `"self"`, `name`, `prompt`, `schedule`) |
| `schedule` | the scheduling tools (`list_routines`, `update_routine`…) and `ask_agent` |
| `addressees` | a message mentioning several agents is classified (who acts, who is only referenced) by the cheap model |
| `connectors` | fake connectors granted with all their scopes: `github`, `sentry`, `himetrica`, `railway` |
| `issues`, `seedIssues` | the built-in issue tools, and issues already there |
| `workspace` | `add_agent_to_channel` and `update_thread` (internal changes with undo) |
| `missions` | a `propose_mission` with the real description and findings schema (no computer: the proposal is only recorded) |
| `memory` | the agent's memory items (found with `search_context`) |
| `fixtures` | per tool name, canned results: the first entry whose `when` words all appear in the call's input (no `when` = default) |
| `expect` | deterministic: `investigate`, `mustCall` (`"a\|b"` = any), `mustNotExecute`, `approval`, `evidence` (any of), `noReply`, `ask` (`never`/`required`), `mustNotCall`, `notTriggered` (other agents' handles the trigger must not start), `receipts` (act with undo: receipt kinds the reply must carry, e.g. `issue.created`), `missionFindings` (`propose_mission` with read/data findings and at most one decision); judge: `behavior` (what a good answer does), `rubric` (extra criteria), `skipJudge` |

Checkers are unit-tested in `test/behavior-checks.test.ts`; `test/behavior-eval.test.ts` runs the harness with the fake provider (no network).
