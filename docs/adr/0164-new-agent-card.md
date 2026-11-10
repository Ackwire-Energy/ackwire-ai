# 0164. One card to create an agent

- Status: Accepted (the web app; the phone app keeps its screens for now)
- Date: 2026-11-10
- Amends: ADR 0155 §1 (the two steps become one card), ADR 0159 §3 (a personal workspace's "New agent" opens the card
  instead of asking the right hand in one sentence)
- Extends: ADR 0155 §2 (the agent's checklist reads what its card chose)

## Context

Creating an agent had four ways in and three designs. In a personal workspace, "New agent" asked for one sentence and
sent it to the right hand, which needs an AI before anything exists: without one the person met a silent agent and no
new one. The page at `/agents/new` had steps it skipped but still counted ("step 3 of 4" on the second screen), the team
templates had their own dialog, and choosing an app left the flow for Settings, which suggested apps for teams. Once
made, the agent's chat opened with an extra "open profile" link and a Connect AI window over the checklist, and the
greeting sometimes ended with doubled punctuation. Each door asked differently for the same few things: who the agent
is, what it does, what it uses.

## Decision

### 1. One dialog for every way in

`NewAgentDialog` (`apps/web/src/components/new-agent/`) is mounted once for the workspace (`NewAgentProvider` in the
org layout) and opened by `useNewAgent().open({ channelId? })`: the sidebar's "New agent" (both modes, and the team's
agents section), the Team page, Members, a channel's "add an agent" (the channel comes ticked), the team plan's "from
scratch" link and the desktop app's menu (through the `agentes:new-agent` window event, since the menu bar is mounted
outside the provider). Someone who may not create agents still gets the page's own words about it.

On the left, the starting points: "Start from scratch" first, then the ready-made agents (a personal workspace's
starters, or a team's roles by area), then "Bring agents from another app" (Settings › Import). Arrow keys move through
the list. On the right, the agent's own card, edited in place.

### 2. The card

- **Its voice:** the agent speaks in a bubble, "Hi! I'm" and the name field, then one sentence of what it will do (the
  starter's, or what the person writes from scratch). Its @ is shown under it and follows the name; a taken one says so
  and takes the next free one.
- **Its look:** the fitting room. Hovering a color, eyes or clothes tries them on the agent; Shuffle spins like a slot
  machine. The agent looks at what the pointer is on.
- **Name ideas** (from scratch): a few names that fit what it does (themes found by words in the sentence, per
  language), each tried on when hovered and taken on a click; a die rolls more.
- **Apps it will use:** the starting point's suggestions, each with its level (reads, or reads and writes). The level
  dialog says that sending, deleting and paying always ask the person, at every level. "Other app" adds one from the
  workspace's connections or the catalog's plug-and-play apps; an app not connected yet is connected later, from the
  chat.
- **Skills:** the workspace's skills the role suggests come ticked, the others one click away, each opening a short
  view of what it is. The section shows only when the workspace has skills.
- **Where it works** (a team's workspace) and **what to ask first**: three tasks for the starting point.
- **No AI yet:** one line says it starts thinking once an AI is connected, in its chat. The card never blocks on it.

"Create" makes the agent (Automatic as its model, the AI `newAgentStart` picks: the person's plan account or the
workspace's default), then each part on its own so a failure is said without losing the agent: its AI, channels, app
levels and skills. The agent's face flies from the card to its row in the sidebar and its chat opens.

### 3. What the card hands to the checklist

`agents.setup` (jsonb, ADR 0155 §2) gains three optional fields: `hello` (the sentence, at most 500 characters),
`starter` (the personal starter it came from) and `apps` (connector ids to levels, at most 12). The create route
validates them and `setupOf` keeps them. No migration: older rows read as before.

### 4. The agent's chat

- The greeting ends with the agent's `hello`, and the trailing punctuation of an asked line is trimmed before the app
  adds its own.
- A band above the checklist: the agent asleep at night in its sky until it can think, dawn when it can (1.6 s), with
  slots for its AI and up to four of its card's apps, lit as each is ready.
- The apps row names the apps the card chose. One not connected yet reads "Connect" and opens the same connect flow as
  Settings in place, coming back to the chat; the apps dialog suggests the card's apps first.
- In a personal workspace with one member, "who talks to it" and "where" leave the card; "who talks to it" shows as a
  line that isn't counted, and the meter counts only what is left to do.

### 5. What stays

`/agents/new` stays for an agent's proposal (`?proposal=`, ADR 0155 §5), the import and old links. The phone app keeps
its screens until it gets the same card.

## Consequences

- The one-sentence ask of ADR 0159 §3 goes away (`NewAgentAsk` and its words): the right hand still proposes agents in
  its chat when asked.
- The starter tasks and greetings are product words in every language; skills are suggested by matching role names to
  the library, which is a best effort.
- The phone app follows later, reading the same `setup` fields.
