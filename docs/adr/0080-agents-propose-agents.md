# 0080. Agents propose agents; a person creates them

- Status: Accepted
- Date: 2026-10-30
- Extends: ADR 0061 §8 (action cards: "creating agents … come after, as proposals"), ADR 0059 §3 (a plan thinks only for its owner's agents), ADR 0053 (who is behind a run)
- Code: `packages/engine/src/agent-proposals.ts`, `packages/engine/src/setup-tools.ts` (`propose_agent`), `apps/server/src/routes/app/agents.ts`, `packages/client/src/lib/action-cards.ts`, `apps/web/src/components/ActionCard.tsx`, `apps/web/src/pages/NewAgentPage.tsx`, `apps/mobile/src/features/agents/ProposalCard.tsx`, `apps/mobile/src/features/agents/NewAgentScreen.tsx`

## Context

Agents could connect an AI, create channels and invite people through cards (ADR 0061), but had no way to create an agent or propose one.

Creating an agent is a person's permission (`manage_agents`): an agent gets scopes, a budget, a computer and its owner's plan. So there is no "manager" agent that creates agents. Any agent may propose one, and a person decides.

## Decision

### 1. The tool creates nothing

- `propose_agent`, under `setup:write` (granted by default, the setup group the judge loads when a message is about setting up), posts one card where the run replies. In the run policy it speaks here: unattended runs may post it, routines (which speak only through `hand_off`) may not.
- It takes the draft: a name, an @handle, a role, what it does (the instructions), a look (the app's allow-list), the public channels it joins by name, its level (read or write) on the workspace's connected apps by catalog id or name, and one line for the person (`why`).
- The draft is checked as the create-agent API checks an agent: a name of up to 80 characters, a handle of the right shape that no agent (archived ones too) or person has, a role of up to 200 characters, instructions of 1 to 50,000, a look from the allow-list. Channels are public ones only, because the card shows their names to everyone in the conversation; the person adds private ones while reviewing. Unknown channels and apps are refused with the ones that exist, so the agent can correct itself.
- The card is `meta.actionCard` with `kind: "agent_proposal"` (`bodyCode: "agent_proposal"`), so it starts no run and counts toward the run's 3 cards.
- It is posted only where someone who may create agents can open the conversation (`deciderCanOpen`): a public channel, which they may join, or a forum; a DM or a private channel only with one of them in it. Elsewhere (a member's DM with an agent, say) a card could never be decided, so nothing is posted and the tool tells the agent to send the person to an admin or owner.

### 2. The AI it suggests

The draft carries one suggestion, computed when it is proposed:

1. An account that thinks for no agent: an active sign-in of the person behind the run, on a computer that is still there, the oldest first. Only when that person may create agents, since a plan thinks only for its owner's agents and the creator is the new agent's owner.
2. Else the workspace's model, when a new agent on "Automático" with the workspace's key would think (the AI status check, no key decrypted).
3. Else none: the agent is created all the same, and Connect an AI opens for it right after.

The card shows the suggestion made for the asker. The review screens read the proposal through `GET`, which suggests again for whoever opens it, at that moment: an account the asker has is theirs alone, so another admin starts on their own free account, the model or none.

### 3. The card keeps its state

- Unlike a Connect card, what a person decided can't come from live data, so the card holds it: `state` (`pending`, `creating`, `created`, `denied`), the agent made from it, who decided and when, and `expiresAt`, a day after it was posted, like an approval. "Expired" isn't stored: a pending card past it.
- Only the decision routes write it, each with a conditional update on the state it expects, so two people deciding at once get one decision. `creating` holds the card while the agent is made and goes back to `pending` if that fails. A crash in between leaves it decided for good, as the forum's suggestions.
- `agent.proposal.updated` on the channel carries the decision (the state, the agent made, who decided and when), never the draft: its instructions alone can be past a Postgres NOTIFY payload's limit (ADR 0010). Every app puts it on the card it already has.

### 4. Deciding

- `GET /api/app/organizations/{orgId}/agent-proposals/{messageId}`: whoever reads the conversation, with `canDecide` for who may create agents while it is open. Anyone else gets 403, and the review screens say that only people in its conversation see it.
- Creating it is the create-agent route itself, `POST …/agents` with `proposal`: the person's own fields, edited or not, and their own permission. The card then says created and links to the agent.
- `POST …/agent-proposals/{messageId}/deny`: the card stays, marked denied.
- Both need `manage_agents` and a person's session; no tool decides a proposal, so no agent approves its own or another's. Decided or expired: 409 `agent_proposal.decided` or `agent_proposal.expired`.

### 5. The agent hears it

The decision reaches the agent that proposed it as a `proposal_result` notice in its run's conversation (`deliverNoticeToRun`), like another agent's answer: who created it and its @handle, or that a person said no and it shouldn't propose it again unless asked. It wakes the agent like other notices (up to the notice hop limit), so it can go on with what was asked.

### 6. The apps

- Web and the desktop app (its window loads the site, ADR 0036): the card shows the draft's face, name, @handle and role, the AI it would think with and the agent's line, with Revisar and Recusar for who may create agents while it is open; anyone else sees it waiting for an admin. Revisar opens Criar agente (`?proposal=`) on its last step, filled in with the draft, where every step can be edited and Recusar says no too (then back to the conversation). Picking a role there changes the role alone, and a role's words are a field of their own under Do zero (in any new agent). The channels it proposes are listed even when the reviewer isn't in them, and the agent joins them. Created, the card links to the agent's page.
- Phone: the same card in the chat. Revisar opens the phone's own Criar agente (Papel, Quem é, O que faz, Revisar) filled in, with the same rules for the role and the channels; a tap on an app in Revisar moves its level on (Sem acesso, Ler, Ler e escrever), and Recusar is there too. The suggested account is given to the new agent when it is the reviewer's, and with no AI the Connect sheet opens over the new agent's conversation.

## Consequences

- An agent can answer "create a bot that…" with a ready draft one review away, and nothing exists until a person creates it.
- A prompt injection can at most post a card that a person has to review and create.
- Nobody is told outside the conversation: a member's request waits on the card for an admin who reads it there. Where no admin or owner can read it, there is no card, and the person is sent to one.

## Alternatives considered

- **A manager agent that creates agents:** one agent with a person's permission, which any message to it could use.
- **Create at once with Undo, like `create_channel`:** a new agent gets scopes, a budget and a computer, and creating one is a permission people hold.
- **A table of proposals, like the calendar's:** the card needs the draft anyway, so the state would live twice.
