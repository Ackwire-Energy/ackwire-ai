# 0059. AI accounts belong to people: one account per agent, a plan answers its owner, more providers, official marks

- Status: Accepted (2026-10-24). Built in steps; the provider marks (§9) first
- Date: 2026-10-24
- Extends: ADR 0018 (providers), ADR 0027 (secrets end to end), ADR 0032 (computer brains), ADR 0041 (accounts per agent)
- Supersedes in part: ADR 0041 §2 (who adds accounts), §4 (who decides) and §7 (removing); ADR 0032 §5 (when the plan warning shows); ADR 0058 §4 (who drives an agent's computer in system mode while its user holds a sign-in)
- Out of scope for now: accounts switching by themselves, a fourth CLI brain, Chinese regional endpoints

## Context

ADR 0041 put Claude and ChatGPT subscriptions on a connected computer, one folder per account, managed only by the person who paired the computer. Three things changed:

- **Computers without a person.** A Cloud workspace's machine and a self-hosted server's own computer have no pairer, yet every member wants to bring their own plan to them.
- **Several seats per person.** A team plan gives one person several seats. With labels such as "Claude Max · Max" nobody could tell the rows apart, or whose account served which agent.
- **Sharing a personal plan.** ADR 0032 warned once, when a plan brain was chosen, and after that the agent answered whoever its audience allowed, on one person's subscription.

People also asked for more providers than Anthropic and OpenAI (DeepSeek, Kimi, Z.ai's GLM, MiniMax, OpenCode), for the providers' official logos wherever a provider is named, and for each plan's usage limits on screen.

## Decision

### 1. An account belongs to the person who added it

- The owner is bound when the sign-in **starts** (the row is written then, with the caller as owner), never inferred later from who polled first. Only the person who started a sign-in may send its code, check it or cancel it.
- Accounts the desktop app reports with no sign-in started from the web belong to the computer's pairer. On a computer with no pairer they have no owner: nobody assigns them, and the pairer or an admin can remove them.
- Only the owner sees the account's email, renames it, assigns it or signs in to it again. The computer's pairer can disconnect any account on that computer; on a computer with no pairer, so can admins.
- **Who adds:** any member on a computer with no pairer (the Cloud machine, the server's own computer). On a personal computer only its pairer adds accounts, as before: other people's sign-ins on someone's laptop raise a consent problem, and they would outlive the computer if its token were revoked.
- A person who leaves the organization or deletes their account has their accounts signed out and removed from every computer, with a tombstone until the runner confirms. They are never inherited by anyone.

### 2. One account thinks for one agent

- An account serves at most one agent (a unique index). Picking an account another agent uses offers to move it here.
- The computer's own sign-in (no folder) can still serve several of its pairer's agents.
- Each seat's limits stay predictable, and on a computer where every agent runs as its own OS user, one sign-in folder can't be shared anyway.

### 3. A plan only serves its owner's agents

A personal plan thinks only for agents owned by the plan's owner. This is checked when an account is chosen, when an agent changes owner (the plan is cleared), when an account goes away (the agent goes back to the API, or waits with no AI), and at run time (`plan_not_owner`, which also covers an owner who left). Runs never slip onto someone else's plan.

### 4. Labels people recognize

Automatic names are the maker and the plan, numbered per owner: "Claude Max", "Claude Team 2", "ChatGPT Plus", "GLM Coding", "Kimi Code", "MiniMax", "OpenCode Go". The owner sees the email under the name (and the organization of a team seat); everyone else sees "Claude Team 2 · {owner}'s" and never the email. The same email twice for one owner on one computer is refused, and the new folder is removed.

### 5. "Only replies to you"

- An agent that thinks with a personal plan answers only its owner by default: the audience is `owner`, enforced everywhere a person's message can start a run (ADR 0032's audience gate).
- Turning the switch off shows the provider's own words about personal use and that answering others might go against its terms. Accepting sets the audience to everyone and is audited with the date. Choosing a plan no longer asks anything; only sharing it does.
- Only the plan's owner can widen the audience of an agent that thinks with their plan. Admins can only narrow it.
- With sharing on, anyone who can talk to the agent can make it use the owner's plan and, on a computer where agents share one OS user, reach its sign-in.

### 6. The sign-in code never passes through our servers in the clear

ADR 0041's path stays: the provider's own CLI signs in on the computer, the pasted code is sealed in the browser to a key made inside the runner (ADR 0027), and the server relays the ciphertext in memory, never storing or logging it. Claude's flow uses PKCE (S256), so a relayed code is useless without the verifier that never leaves the CLI. The paste is the only hard step: the sign-in opens in a popup, "Paste" sends by itself only when the text ends with this sign-in's state, and an optional "Which account?" email becomes the CLI's login hint (validated, never passed to a shell). Each sign-in runs the provider's CLI on a computer others may share, so a computer runs at most four at once and a person starts at most ten per computer every 15 minutes.

### 7. Usage limits, read without touching a token

Each account's usage comes from the CLIs themselves: the rate-limit events during turns and a usage request that makes no model call (Claude Code), the app-server's rate-limit calls (Codex), and the provider's usage endpoint for a coding-plan key, called from the computer. The server keeps percentages and reset times only. The meter shows each window, tightest first, warns at 80% and says until when an account is at its limit. Accounts never switch by themselves.

### 8. More providers, on the right side of their terms

- **API keys** (pay per use, the workspace's): DeepSeek, Kimi (Moonshot), Z.ai (GLM) and MiniMax join Anthropic and OpenAI through the Model Gateway, all four through the existing Anthropic-Messages adapter with a base URL, sent only what they all take; structured output becomes a tool, forced where the provider honors `tool_choice: any` (DeepSeek, Kimi) and offered where it takes only `auto` (Z.ai, MiniMax). Usage and cost are recorded per agent as for every model call.
- **Coding plans** (GLM Coding Plan, Kimi Code, MiniMax, OpenCode Go) run only on a computer, through Claude Code with a base URL, as a "key account". The key is sealed to the runner like a sign-in code and kept in the account folder; base URLs come from the runner's own plan list and are pinned in the runner's own settings file, which outranks project settings an agent could write. The plans' terms allow only coding tools, so our server never holds, routes or sees a plan key.
- A key account's turn gets the key in the process environment only (redacted from everything the runner sends) and keeps Claude Code's model aliases, each mapped to the plan's own models; no CLI signs in or out there, and a key its endpoint refuses reads as signed out until a new one comes. A sign-in account's turn pins Anthropic's own endpoint the same way, and a turn on the computer's own sign-in pins the endpoint, cloud and proxies the runner itself runs with (unless the computer's owner chose to load their own Claude Code settings).
- Account folders are secret paths for agent file operations, and environment names reserved for providers and the runtime are refused as agent secrets.
- Where each agent runs as its own OS user (system mode), account folders live outside root's home and belong to the user of the agent that thinks with one only while it does: handed over before its first turn (from a tree only root can change, its top last), and taken back to root as soon as the agents frame no longer says so (top-down, each folder root's before it is read, never through a link). Root never runs a CLI against a folder an agent's user could write: its status is what its turns said, signing in again starts it over, and removing it signs nothing out.
- While an agent's user holds its owner's sign-in, controlling its desktop or opening its terminal (a shell as that user, ADR 0058 §4) is only the agent's owner's: admins drive it again once it thinks with something else. Watching it stays as it was.

### 9. Official marks, next to the provider's name

- The makers' marks are vendored as 24×24 path data in `packages/ui/src/brand/marks.ts`, each taken from the maker's own files (a press kit, a brand page, or its repository at a pinned commit), which every entry names. A mark can add shapes in fixed colors (Kimi's dot, OpenCode's block, with the maker's dark color where it has one) and a gradient (MiniMax). The `anthropic` provider draws Claude's mark: people know it as Claude. *Amended 2026-10-27:* a maker that publishes its mark only as a raster gets an image mark instead (`ImageMark`). Gemini's own SVG fills the sparkle with an image, so the mark is the icon gemini.google.com serves, scaled to 128 px and otherwise unchanged, served from `apps/web/public/brands` and drawn on the neutral tile. The phone bundles its own copy.
- One component draws them everywhere: `ProviderLogo` (web and desktop) and its React Native twin, by provider, plan, brain or executor id. A brand-colored mark sits on a tile tinted with its color; one-color marks follow the theme; an id without a mark shows its initial; an unavailable one is only dimmed, since the makers' rules forbid recoloring a mark. `BrainLogo` is a wrapper, and `ProviderStack` overlaps several marks for a line that names more than one maker.
- A mark appears next to the name of the provider it stands for (keys, models, brains, accounts, notices), never inside our own feature names, and is never redrawn.

## Risks we accept

- **Terms.** Anthropic says personal subscriptions are for personal use and that "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". OpenAI's Sign in with ChatGPT terms say: "Another user's activity must not trigger requests to the authenticated user's account." Z.ai says "Account sharing or multi-user access is prohibited" and limits the GLM Coding Plan to "officially supported tools and products"; MiniMax describes its plan as individual, interactive developer use; OpenCode Go plans "are for single-member workspaces" (all read 2026-10-23). Our server never sees a sign-in code or a plan key in the clear, a plan answers only its owner unless the owner accepts the risk, and that acceptance is recorded. An owner-only autonomous agent on a Z.ai or MiniMax plan is still a gray area.
- **Several seats.** One person running several seats as several agents sits close to the usage policies' "bypassing restrictions". Accounts never switch by themselves; moving an agent to another of the owner's accounts is always the owner's own choice.
- **Logos.** Anthropic's brand terms rule out its names and logos in "your own product, feature, or company name" and say any other use "requires our written permission"; MiniMax keeps all rights to its drawing. We show marks only to say which provider something is, never redrawn and never in our feature names, and one data file means removing or swapping a mark is a one-line change.

## Consequences

- Positive: a team's seats become distinct, owned rows; any member can bring a plan to the Cloud or the server's computer; a plan never answers someone else by accident.
- Positive: four more API providers through one adapter, coding plans without our server ever holding a plan key, and logos from one source on every platform.
- Negative: more states to keep straight (a sign-in in progress, removing, signed out) and a new migration, runner protocol fields and screens.
- Negative: the providers' printed CLI output and usage endpoints can change; tests use fake CLIs, and a usage source that breaks only empties the meter, never a turn.

## Alternatives considered

- **A direct-to-computer endpoint for the code**, so it never crosses our server. Computers sit behind NAT, and on the Cloud we would issue the endpoint's TLS name ourselves, so it would be no more private than the sealed relay. Rejected.
- **Per-person routing to the workspace key**: the plan for its owner, the workspace's API key for everyone else. One agent would think with two brains and two costs depending on who is talking, and its sessions would split. The audience gate does the job. Rejected.
- **Switching accounts automatically at a limit.** Rotating subscriptions to get around limits can break the providers' terms (ADR 0041 §6). Rejected.
- **Storing plan keys on the server**, encrypted like workspace keys. The coding plans' terms allow only their coding tools, and a server-held key could be routed anywhere. Rejected.
