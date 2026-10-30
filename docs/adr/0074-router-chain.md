# 0074. Who answers a message nobody mentioned: the chain

- Status: Accepted (built: the engine, the runner's `brain.route`, the shared client's receipts and status; the screens follow)
- Date: 2026-10-27
- Amends: ADR 0013 (failures and strategies), ADR 0034 §4 (agents' messages), ADR 0059 §5 (a personal plan answers its owner)
- Code: `packages/engine/src/router.ts` (`routeMessage`, `smallModelFor`, the rules), `packages/engine/src/router-jev.ts` (`routeChain`), `packages/engine/src/router-plan.ts` (`planSignInsOf`, `createPlanRouterStrategy`), `packages/engine/src/ai-status.ts` (`orgRouting`), `packages/providers/src/catalog.ts` (`router`, `leastThinking`, `routerModelOf`), `apps/server/runner/brain-route.ts`

## Context

A message that @mentions nobody went to one strategy: Jev when the installation had its key, else a model on the default key's provider, with the outbox retrying a failure. A self-hosted workspace whose agents think only with Claude or ChatGPT plans had neither, so the router failed with "no key": the message showed "No agent will answer" with no reason, and after a reload nothing at all. The fallback model also thought before it answered (Haiku 5.5 has thinking on by default), which made it slow, and a workspace whose default key was Kimi's routed every message with its large model.

## Decision

1. **The steps, in order:** Jev, a small model on any of the workspace's keys, the author's own plan, rules in code, and nobody with the reason. A step that isn't available is skipped without a call (no key, no small model, no sign-in). A step that fails (an error, a timeout, an answer that isn't JSON) is noted in the decision's `error` (`jev: TypeSafe answered 529`) and the next one runs, in the same job. Routing never goes back to the outbox: the rules always end it.
2. **A small model** is a provider's routing pick (`router: true` in the catalog): its fastest model with the least thinking, at about US$ 0.0006 a call or less, which is not always its `cheap` one. Claude Haiku 5.5, GPT-6 Luna, Gemini 3.5 Flash-Lite, DeepSeek Flash, GLM-5.3 Flash and MiniMax M3. Kimi has none (its cheapest model always thinks), and coding plans never route. The order: the workspace's own `router_model` when its provider has a key, then the default key's provider, then any other key (Claude, OpenAI, DeepSeek, Gemini, Z.ai, MiniMax), then the server's own Claude key. It is asked with `effort: "none"` (the least thinking the model allows, `leastThinking`: off where it can be turned off, `minimal` on Gemini 3.5 Flash-Lite, `low` elsewhere), 512 output tokens (2,048 for a model that can't stop thinking) and 8 s.
3. **A plan picks only for its owner's own messages,** personal or team seat alike, since plans are personal, and only on a self-hosted server: it is off on the Cloud, where Jev is ours. It runs through the runner's `brain.route` (protocol 24) with every CLI tool off, nothing of the folder or its owner loaded, no session kept, in a temporary folder, as the agent's own user, killed after 30 s. Only plan sign-ins count: a sign-in the person made and lent to one of their own agents, never a coding plan's key, or the computer's own Claude Code sign-in where the person paired that computer and it is signed in with a plan (`claude.ai`; Codex doesn't say, so its own sign-in doesn't count). Never on a computer that won't run the route: Windows for now, or one where that CLI is switched off. One route per sign-in at a time, and none while that sign-in has a process open (a turn, or the one kept after it): the runner answers `busy` and the author's next sign-in, else the rules, decide. A turn or a task that starts on that sign-in meanwhile stops the route first, and the rules decide that message. It is skipped where a reply or a lone agent already decides. `message.routing` says "Picking who answers" before the call. Its usage is recorded on the plan (kind `router`, its computer and account) at no cost.
4. **Rules, in code:** R1, a reply to an agent (a quote, or a reply under its message where no other agent spoke). R2, the channel's one agent when the author is the only person there. R3, the agent of the author's own previous exchange within 10 minutes (they addressed it, or it answered them), when the message names no other person of the workspace (a whole first name, any case and accent). Not "whoever spoke last": that agent may have been answering someone else.
5. **Every decision is stored with every candidate** (score 0 when nobody), the step that decided (`strategy`: `jev`, `llm:<model>`, `plan:<kind>`, `rule:<name>`, `none`) and the earlier steps' failures. `message.routed` carries `decidedBy`, the message list's receipts carry it and `mention_needed`, so a receipt survives a reload. `ai-status` says who picks for the workspace (`routing.by`) and for the person asking (`routing.mine`), and whether the workspace has an API key.
6. **An agent's own message** goes through Jev or a model only: never a plan, never a rule.
7. **The LLM judge** uses the same small model with the least thinking. No plan answers a judge question: they come from the system, not from one person.
8. **Only code writes the follow-up marker:** a decision's `reason` starts with `follow-up` when the policy keeps the person with the agent they talk to, and a step's own words come after its name (`jev: …`, `model: …`, `plan: …`). The reply policy reads only a leading marker, so no model can take an agent's right to stay quiet.

## Consequences

- On a self-hosted server a workspace with only plans routes its people's own messages and every reply, and no decision disappears on reload.
- The plan step spends the author's plan limits and waits out an agent's live process. Its worst case, with every step failing, is 40 s (2 + 8 + 30).
- The Cloud must have core's own Jev key before this ships there, or it routes by small models and rules only.
- Claude's API and OpenAI's are taken at their word on turning thinking off for Haiku 5.5 and GPT-6 Luna. A refusal is a provider error, and the chain moves on.

## Alternatives considered

- **A plan picking for everyone's messages.** Plans are personal, and Claude's terms keep their limits to ordinary, individual use.
- **The channel's only agent whatever the company.** With several people and one agent, every greeting would wake it.
- **Kimi's large model as the small one.** About US$ 0.009 and several seconds a message: no routing beats that.
- **Skipping the prompt cache on router calls.** It saves a quarter of the input of a call that costs a fiftieth of a cent.

## Addendum (2026-10-30): the rules read a person's messages in a row

A person's messages within 2.5 s of each other are decided once, on the last of them (ADR 0013, addendum of 2026-10-30), so the rules see them as one message too. R3 reads whom the person speaks to: it stays out when the message, or the same person's messages right before it, name a person of the workspace ("boa tarde walter", then "como esta hoje"). R1 holds for a quote reply to an agent followed by more messages of the same person.
