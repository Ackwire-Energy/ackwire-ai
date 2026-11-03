# 0134. The team's right hand

- Status: Accepted (built: engine, server, the shared client, the web and the phone app)
- Date: 2026-11-03
- Supersedes: ADR 0093 (the team's coordinator)
- Amends: ADR 0081 (one-click Criar and Criar e testar on the right hand's cards), ADR 0092 §5 (a teammate's settings, on the right hand's card)
- Extends: ADR 0053 (who is behind a run), ADR 0061 and 0129 (action cards applied as whoever clicks), ADR 0085 (an agent's audience by roles), ADR 0074 (the router)
- Code: db `packages/db/src/schema/agents.ts` (`agents.builtin`, index `agents_one_right_hand`, migration `right_hand`), `schema/context.ts` (`proposal_target` `agent_settings`, `context_proposals.settings`, `requested_by_user_id`, `asked_at`, migration `right_hand_settings`); engine `right-hand.ts` (`ensureRightHand`, `ensureRightHands`, `followOwner`, `RIGHT_HAND_GRANTS`, `RIGHT_HAND_EDITABLE`, `refuseRightHand`, `rightHandReaches`), `right-hand-prompt.ts` (`rightHandPrompt`), `settings-proposals.ts` (`SETTING_GROUP`, `settingLines`, `applySettings`, `revertSettings`), `context/proposals.ts` (`askProposal`), `agent-proposals.ts` (`askAgentProposal`, `first_task`, superseded cards), `setup-tools.ts` (`propose_settings_change`, the card cap), `agents.ts` (`unarchiveAgent`), `router.ts`, `organizations.ts`, `exports.ts`; server `routes/app/agents.ts`, `routes/app/memory.ts` (`POST …/proposals/{id}/ask`, `POST …/agent-proposals/{messageId}/ask`); client `lib/right-hand.ts` (`isRightHand`, `rightHandOf`, `RIGHT_HAND_DEFAULT`, `finishOnboarding`, `introCard`), `lib/proposals.ts` (`settingLineText`, `decidersOf`, `onlyKey`, `sentToText`); web `components/RightHandCards.tsx`, `RightHandIntro.tsx`, `RightHandSettings.tsx`, `Sidebar.tsx`, `pages/OnboardingPage.tsx`; phone `features/right-hand/*`, `features/chats/logic.ts` (`rightHandPin`), `features/onboarding/OnboardingFlow.tsx`

## Context

People asked for a way to build and run the team by talking: "I need someone to answer customers by email", "put this agent on a better model", "what isn't set up yet?". Everything that does it already existed as screens and as cards agents may post (ADR 0061, 0081, 0092, 0129), but no agent was there to start them, and every agent's cards went through a review screen first.

ADR 0093 tried a narrower fix: a switch that made one agent take the messages the router gave to nobody. It answered one complaint (a person alone with a new team got no answer to "bom dia!") with hidden routing nobody could see on a screen.

## Decision

### 1. One built-in agent per workspace

- It is an ordinary `agents` row marked `builtin = 'right_hand'`, with a unique partial index on `org_id`. DMs, runs, budget, the Model Gateway's accounting, cards, the profile and the phone work as for any agent. Jev stays the router and judge behind the scenes; Ada stays a ready-made agent.
- It is made with the workspace (`ensureRightHand` in `createOrganization`) and, for workspaces made before, by a backfill that runs off the boot path (`ensureRightHands`), so every workspace has it on the next load. No announcement is posted.
- Its name is **Lodi**, the same in every language, with the teal look, happy eyes and the headset. Admins may rename it and change its look. Its label stays fixed: "seu braço direito" (en "your right hand", localized as each language says it).
- It can't be archived or deleted (403 `agent.right_hand_permanent`). Only its name, handle, AI and model, budget, look and audience change (`RIGHT_HAND_EDITABLE`), and it never thinks on a computer. It is left out of exports, so imports never make one, and out of the team counts and the invitation page.
- Its owner is the workspace's longest-standing owner who can still sign in, followed through role changes, people leaving and deleted accounts (`followOwner`).

### 2. One agent, a private DM per person, acting as that person

- Each person talks to it in their own DM. Every tool acts with the permissions of the person in that DM (`personBehindCall`, ADR 0053): a member's Lodi and an admin's Lodi are the same agent with different rights.
- Its prompt is read live on every run (`rightHandPrompt`): what the person behind it may and can't do, the team as they may see it (agents, models, apps, channels, routines, budgets), the setup checklist (no AI, an agent without one, no agent besides it, nobody invited, no app, no workspace context, no computer ready, an agent in no channel, a budget running out) and the card rules.
- It keeps no memory across people in v1: its memory tools are denied and its conversations are never reflected or learned from.
- It is in no channel. An @mention in any channel reaches it all the same (`rightHandReaches`, read by the mention lookups and `eligibleChannelAgents`), never in a DM between people, so the router never picks it and it posts nothing unless someone writes to it.

### 3. Who sees it and what admins set

- Everyone sees it by default. Admins narrow it through its audience by roles (ADR 0085). Outside its audience there is no row for the person. There is no off switch and no per-person hide in v1.
- Settings › Lodi (by its name and face, for `manage_agents`): name and look, AI and model (Automático, which starts it on the cheap tier), its own monthly budget (empty is the workspace's default), who may use it, the line that it can't be archived or deleted, and its audit log. Its agent page is the same short form; its instructions are the product's.

### 4. What it may do

Anything a person can do in the app, started as a card applied as whoever clicks (ADR 0129), checked against that person's permissions at the click, never when the card was written. The audit log records the person, `via` the right hand.

- **A new agent:** its `propose_agent` card reads **Criar** in one click, or **Criar e testar** when it carries a first task (posted from the clicker in their DM with the new agent, which opens), plus Editar antes (Criar agente filled in) and Descartar. A newer card for the same agent puts the older one away (`superseded`). This amends ADR 0081 for the right hand's cards only: the card already shows everything the review screen would, and the click is still the person's. Other agents keep the review.
- **A teammate's settings:** `propose_settings_change` posts one card with a row per agent and decider: model, AI account, budget, owner, who talks to it, channels joined or left, reply mode, archive. Each row is decided by whoever may make that change on the agent's page (`manage_agents`; its owner too for its audience and channels; an AI account only by the account's owner, who must own the agent), applied through the page's own editors as them. A row made against a value that moved since is out of date ("Desatualizado", with Refazer). An applied row is a receipt with Undo (`agent.settings_changed`), which stops once someone changed it again; archive's Undo is `unarchiveAgent`. This amends ADR 0092 §5 for the right hand's card only.
- **Asking whoever may:** a person who can't decide a row (or create the agent) sends it with **Pedir a um admin** (`POST …/proposals/{id}/ask`, `POST …/agent-proposals/{messageId}/ask`). Each person who may decide it gets a waiting inbox entry (`change_request`), decided there; the asker's card reads whom it went to, then "Aplicado por …" or "Recusado por …" live (`proposal.decided`). Nothing is sent before they press it.
- **The rest exists already:** instructions, role and apps (`propose_instruction_change`, ADR 0092), adding an agent to a channel and creating a channel (direct, with Undo), routines, Connect AI, connecting an app and inviting people (ADR 0129 cards). It may post up to 10 cards a turn; every other agent keeps 3.
- **Never, even when asked:** decide approvals, change people's workspace roles, remove members, billing, delete a workspace, an account or an agent, or take a key, password or token in the chat (those are typed only into our dialogs; it says where the setting is).
- **Its tools are fixed in code** (`RIGHT_HAND_GRANTS`): setup cards, reading context, routines and instruction proposals, without the memory tools, the web, apps, a computer, databases, files, mail, posting elsewhere or long work, so it can't be used to reach data.

### 5. The coordinator goes

ADR 0093 is superseded. The switch, its chips and lines, the delete warning, `setCoordinator`, the first-agent claim, the `rule:coordinator` tier, its prompt line, the `agent.coordinator` event and their strings in all 14 languages are gone from the engine, the web and the phone. In its place, one router change (R2 in the design): in R5, a person alone in a channel with two or more agents gets the top-scored candidate when the message needs an agent (the existing need gate); a greeting under it, or an ok, wakes nobody. When no step can read a message, the rules are reply, only agent, follow-up, else nobody.

### 6. Onboarding

The onboarding asks only the workspace's name (its logo and time zone), in Lodi's face, finishes the workspace at once and opens Lodi's DM (`finishOnboarding`), on the web and the phone. A workspace left at any step of the older onboarding is finished and opened there. The top of Lodi's DM is drawn by the app, never stored, so it costs nothing and works before any AI is connected: its greeting, then one card (`introCard`): Connect AI while there is none; with one and no other agent, how to start (the four ready-made agents, describing the need, an import or the form); with a team and nobody else yet, inviting people and the first task. The workspace context and the computer, which the old onboarding asked for, are lines of the setup checklist.

### 7. Cost

It runs on the workspace's AI through the Model Gateway like any agent: budget checked before each call, usage and cost recorded with `org_id` and its `agent_id`, and stopped by its own budget with the usual card. It never runs on Jev's or the platform's key; a message typed before any AI exists gets the standard no-AI card.

## Consequences

- Every workspace gets one more agent row. Lists that count "the team" leave it out; its pinned row is its entry (the sidebar on the web, the top of Conversas on the phone), never Mensagens diretas or Agentes.
- `agents.coordinator` and its index stay in the database, read and written by nothing, until no running version selects them (`check:migrations`); a later migration drops them. Workspaces that had a coordinator get an ordinary agent back, and nothing is posted.
- Stored decisions keep their strategy `rule:coordinator`, read as the default rule's line, and still count toward the per-channel cap for their hour.
- `PATCH …/agents/{agentId}` ignores an incoming `coordinator` and answers 200, because phones without an over-the-air update still send it.
- Every proposal made in conversation now keeps who asked for it (`requested_by_user_id`).

## Alternatives considered

- **Jev as the right hand:** Jev has no agent row and runs on the installation's key; making it a chat partner mixes "the model that routes" with "an agent on your AI" and puts its cost on our key.
- **Promote Ada:** she is the Dev preset, renamed, reassigned and deleted like any agent; one face would do two jobs.
- **One right hand per person (N rows):** private memory, but N budgets and a roster that grows with the people. One row acting as the person in their own DM gives the same privacy.
- **Keep the coordinator, hide its switch:** an agent answering what nobody took with no screen saying why.
- **Move the coordinator's routing to the right hand:** it would answer unasked in channels and run on every unclaimed message.
- **Make it a hidden member of every channel** so mentions reach it: it would show in rosters and need a membership row per channel; reading it in the two mention lookups was smaller.
