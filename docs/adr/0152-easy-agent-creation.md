# 0152. Easy agent creation: two steps, then a setup checklist in the agent's chat

- Status: §2 accepted (the checklist, merged with the first run of ADR 0137 §10). §1, §3, §4 and §5 proposed, not built: their code stays on `feat/agent-easy-create`.
- Date: 2026-11-05
- Amends: ADR 0081 (creating an agent), ADR 0137 §6 (the right hand's start card opens the new dialog)
- Extends: ADR 0059 (connecting an AI: one picker everywhere), ADR 0094 (what a new agent starts with)

## Context

Creating an agent took seven steps (role, identity, instructions, tools, where, model, review) before the agent existed. People who aren't technical stopped at the @ handle, the access levels per app, the model and the key, the budget in US$. Connecting an AI was one more dialog with every plan and key in one grid.

## Decision

### 1. Creating takes two steps, in a dialog

1. **Choose**: a list of the ready-made agents by area (Customers, Operations, Technology) with a preview beside it (the agent in its sky, what it does, what it suggests to start with). "Start from scratch" is the first row. Arrow keys move, Enter and a double click choose.
2. **Make it yours**: the name (its @ follows; a taken one gets the next free one, said under the field), what it does in one sentence for an agent from scratch, and its look (color, eyes and what it wears, all in view, with Shuffle).

"Create" makes the agent with the role's instructions, Automatic as its model and the workspace's default AI, and opens its chat. Everything else moves to the checklist. `/agents/new` opens the same dialog.

### 2. The checklist is the top of the agent's chat

A new agent's chat starts with its greeting and a checklist in its voice, drawn by the app (never a stored message), for whoever may change the agent: think (connect an AI), apps (the role's suggestions marked), channels (the role's channel suggested), who talks to it, and how it works (instructions, the monthly limit when it pays per use). Each button opens a small dialog with the suggestion marked; nothing changes without confirming. A done line keeps a "Change" link. Once it can think, the card offers first tasks for its role. The agent's profile shows the same checklist.

`agents.setup` (jsonb, null for agents made before; migration 0239) holds the role it started from and the steps confirmed. A step is also done when its data says so (an AI that works, an app granted, a channel joined).

### 3. Connect AI

The one picker of ADR 0059 keeps every entry point and capability; its content changes: the agent asleep in its sky until an AI is connected, "Do you pay for one of these?" (Claude, ChatGPT, other plans), "Pay per use" (API keys, admins, and "Other provider", a workspace's own endpoint, ADR 0146), a sign-in in named steps with Copy link, and a done step.

### 4. Onboarding

The right hand's start card keeps its ways in (the business types, the team templates, the one-click ready-made agents, the import); its last button, "Choose another agent" (before, "Fill in the form"), opens the new dialog. Agents created in one click get the checklist too.

### 5. An agent's proposal and the import

- **An agent's proposal of a new agent** (ADR 0081): "Review" on its card, and `/agents/new?proposal=` (the phone: `/new-agent-look?proposal=`), open the second step filled in with the draft: its name (its @ while the name is as proposed), its role (a ready-made one when its name or id matches one, which the checklist reads; else from scratch, its instructions as what it does) and its look. Under the form, read-only, what comes with it as its card lists it (channels, apps and mailboxes at their level, its routine), its instructions in two lines and its AI, and that all of it can change after, at the top of its chat. There is no list to go back to; "Refuse" says no. "Create" sends the edits with the card (the card reads created), then gives the agent what the person may give of the rest (`giveProposedParts`: its AI account, the channels, the apps for who manages agents, their own mailboxes, its routine) and confirms its checklist's "how it works" when the draft had instructions, and opens its chat. A proposal already decided, or in a conversation the person isn't in, says so.
- **Bringing agents from another app** (ADR 0055) is the list's second row, right under "Start from scratch": the web's dialog shows the same import as Settings › Import (Back to the list; a link in its report closes the dialog), the phone pushes its own screen (`/import-agents`), which Settings › Import opens too.

## Consequences

- The seven-step page goes away, the proposal's review and the phone's import included (the product is in its MVP stage: one path, no compatibility layer).
- The phone gets the same dialog, checklist and picker after the web.
