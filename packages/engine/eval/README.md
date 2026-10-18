# Evals

Manual, never in CI: they call real models and cost a little. Keys come from `.env`.

- `bun run eval:memory`: memory judgments (ADR 0028).
- `bun run eval:behavior`: agent behavior: investigate before answering, cite evidence, concrete next step, ask only the person's decisions, sensitive actions only with approval (ADR 0037). Needs `ANTHROPIC_API_KEY`.

## Behavior eval

```
bun run eval:behavior                                  # all cases
bun run eval:behavior --only dev-read-full-file,pm-feedback-theo
bun run eval:behavior --model claude-opus-5-5          # every agent on this model (or EVAL_AGENT_MODEL)
bun run eval:behavior --judge-model claude-sonnet-5-5  # default claude-haiku-5-5 (or EVAL_JUDGE_MODEL)
bun run eval:behavior --no-judge --max-turns 8         # deterministic checks only; tool-loop cap (default 12)
```

Each case runs on a fresh in-memory database through the real engine (`behavior-run.ts`): the agent's prompt is built by `context.ts` and `capabilities.ts`, tools go through the Tool Gateway (scopes, approvals), the tool loop is `executeRun`. Only connector tools are fake (`behavior-fakes.ts`: GitHub, Sentry, Himetrica, Railway, named and scoped like the real ones). Memory, issues, `ask_user` and `react` are the real built-ins.

Output: PASS/FAIL per case with each check, totals per criterion and cost; the full report (tool calls with inputs and results, replies, the first system prompt) goes to `eval/out/behavior-*.json` (ignored by git). Exit code 1 when any case fails.

### A case (`behavior-cases.json`; private real cases in `behavior-cases.local.json`, ignored by git)

| Field | What |
| --- | --- |
| `agent` | `preset` (`dev`, `ops`, `qa`, `pm`: name, role and instructions from the pt-BR presets), or `name`/`role`/`instructions`; `model` |
| `org` | `name`, `context` |
| `conversation` | `where` (`channel` or `dm`), `channel`, `topic`, `thread` (prior messages after the first and the trigger go in its thread), `prior` (history: `author` is a person's name or `"agent"`; they start no runs), `trigger`, `routine: { name }` (the trigger is a routine's scheduled message) |
| `connectors` | fake connectors granted with all their scopes: `github`, `sentry`, `himetrica`, `railway` |
| `issues`, `seedIssues` | the built-in issue tools, and issues already there |
| `memory` | the agent's memory items (found with `search_context`) |
| `fixtures` | per tool name, canned results: the first entry whose `when` words all appear in the call's input (no `when` = default) |
| `expect` | deterministic: `investigate`, `mustCall` (`"a\|b"` = any), `mustNotExecute`, `approval`, `evidence` (any of), `noReply`, `ask` (`never`/`required`); judge: `behavior` (what a good answer does), `rubric` (extra criteria), `skipJudge` |

Checkers are unit-tested in `test/behavior-checks.test.ts`; `test/behavior-eval.test.ts` runs the harness with the fake provider (no network).
