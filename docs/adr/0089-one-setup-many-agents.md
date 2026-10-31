# 0089. One setup on many agents, and the setup new agents start with

- Status: Accepted (built: the server, the shared client, the web and the phone app)
- Date: 2026-10-31
- Extends: ADR 0032 (who thinks), ADR 0059 (accounts belong to people), ADR 0085 (workspace roles), ADR 0086 (advanced settings)
- Code: `packages/engine/src/agent-setup.ts`, `packages/engine/src/agents.ts` (`setupOfAgent`, `rememberAgentSetup`), `packages/engine/src/brain-settings.ts` (`setAgentBrain` options), migration `0139_agent_setup`, `apps/server/src/routes/app/agents.ts` (`…/agent-setup`), `packages/client/src/lib/agent-setup.ts`, `apps/web/src/pages/agent/Work.tsx` (`SetupCopyDialog`), `apps/web/src/pages/NewAgentPage.tsx`, `apps/mobile/src/features/ai/AgentSetupScreen.tsx`, `apps/mobile/src/features/agents/NewAgentScreen.tsx`

## Context

"Quem pensa" is set one agent at a time: its brain, the account or the key, the model, the effort and the advanced settings. People with several agents asked for one way to give them all the same ("I usually use Opus at medium or high, I only found it one by one"; "it's a lot of work to set the model per agent"), and for new agents to start with what they chose last instead of "Automático" on the API. Every agent keeps its own rules: who may change it (an admin, or its owner), a plan thinks only for its owner's agents and only its owner picks it (ADR 0059 §3), a sign-in made for one agent thinks for one (§2), the API's model and key are admins' (`updateAgent`).

## Decision

1. **A setup is "Quem pensa" as a value**: the brain; on the API its model and key; on a computer the computer, the account there (or that computer's own sign-in), the model, the effort, the context window, answering through the API while away, and "Atende outras pessoas" for the agents moving onto the plan. It is what the dialog holds when the person chooses, saved or not.
2. **`POST …/agent-setup`** (`{ setup, agentIds, preview? }`, at most 200 agents) applies it to each agent by that agent's own rules, through `setAgentBrain` and `updateAgent`, each agent in its own savepoint of one transaction, and says per agent `applied`, `same` or `skipped` with a reason: `not_allowed` (neither an admin nor its owner), `admins_only` (its API model or key), `account_owner` (the plan is someone else's to give, or it thinks only for its owner's agents), `account_single` (a sign-in made for another agent), `other_computer`, `model_missing` (its own plan lacks the model), `failed`. Each change is audited as its own (`agent.brain` with `via: "setup"`, `agent.updated` for the API's model and key).
3. **An agent that can't take the account keeps its own.** An agent already on that brain with an account of its own (another person's plan, its own one-agent sign-in) keeps it and takes the model, effort and the rest, unless its plan lacks the model: a coding plan runs its own models and the aliases it maps, Claude's sign-in Claude's.
4. **The preview is the same run, rolled back.** With `preview` the transaction runs every agent's change as it would and throws before committing, so what the dialog shows is what "Usar" does, with no second set of rules to drift. "Usar" decides again.
5. **New agents start with the last setup.** Every "Quem pensa" a person saves (`setAgentBrain`, and the API's model or key in `updateAgent` while the agent thinks through the API), and every use on other agents, keeps its setup in `organization_settings.agent_setup`, without who it answers. `GET …/agent-setup` (whoever creates agents) says it as it stands now: a key that was removed is the default key, a computer or an account that went away is no setup. Criar agente starts on it where it can think for the new agent: the API's model (while some key runs it) and key always; a plan only for an agent of the person's own, on their account with room for one more agent or a computer they connected. The plan is saved on the agent right after, with its model, effort, context window and fallback. A new agent on a plan answers only its owner (ADR 0059 §5).
6. **In the apps.** On the web, "Quem pensa" gets a row under "Configuração avançada", "Usar em outros agentes" ("A mesma IA, o modelo e o esforço"), once the choice can be saved and thinks with something. It opens a dialog over it: the setup in words, "Todos" on top for every agent that can take it, then each agent with its line (what it thinks with now, the account it keeps, "Já pensa assim", or why not), those that can take it first. "Usar em N agentes" saves this agent's choice and then the others in one call, and the toast says how many changed. Criar agente's model step says "Começa com a última escolha: …" while the choice is still that one; picking another AI, or an owner it can't think for, leaves it. On the phone, "Pensa com" gets the same row, opening a screen with the same list and a button at its foot, for the agent's saved setup; Criar agente's Revisar has a "Quem pensa" row with the last setup or Automático.

## Consequences

- One click gives every agent of a person the same plan, model and effort; agents of other people keep their plans and take the model and effort, where an admin applies it.
- The last setup belongs to the workspace: whoever saves "Quem pensa" last sets it, and someone else's plan in it starts nobody else's agent on it (they start on Automático, as before).
- A preview holds a transaction for one pass over the agents picked; with 200 agents that is a few hundred reads.
- Moving an agent off a plan onto the API keeps it answering only its owner, as a single change does; the bulk path offers no "let them back in".

## Alternatives considered

- **A preview that checks a copy of the rules** without writing. Two sets of rules (plans, sign-ins, who may) would drift. Rejected for the rolled-back run.
- **Moving agents to the setup's computer** when they work on another one. Their files, browser and desktop live there; the single dialog moves one agent with a note, many at once would be a surprise. They say "Trabalha no …" instead.
- **A default per person** instead of the workspace's. Plans are personal, so a person's last choice would always fit their own new agents; the owners asked for the workspace's most recent choice, and someone else's plan simply isn't offered. Not now.
- **Copying "Atende outras pessoas" to new agents.** Letting other people use a plan is its owner's choice for each agent (ADR 0059 §5); a new agent starts answering only its owner.
