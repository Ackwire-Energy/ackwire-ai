# 0043. Tools and context on demand, chosen per run by the judge

- Status: Accepted (2026-10-20)
- Date: 2026-10-20
- Extends: ADR 0015 (Tool Gateway), ADR 0032 (computer brains), big connectors as a directory (`packages/engine/src/tools/directory.ts`)
- Out of scope for now: provider-native tool search (Anthropic `defer_loading`, Claude Code's own ToolSearch), changing the list in the middle of a run, Claude Code's own floor (`apps/server/runner/brain.ts`)

## Context

Every run listed every tool the agent was granted, and the prompt repeated each one with a description. An agent with the default scopes and two connectors had 105 tools. One run of a Claude Code agent read ~1M input tokens over ~15 steps, because every step resends the whole base (~48k). Memory and wiki pages also went in as full text whether the message needed them or not.

Big connectors already became a directory (`<prefix>_find_tools` + `<prefix>_use_tool`), provider-neutral, through the gateway. Letting the judge pick which connectors go in whole was evaluated on 222 real runs: the judge alone at ≥ 0.3 got 92% of connector uses, and with "always load what was used in the channel in the last 6 hours", 77/77.

Requirement: provider-neutral. The same mechanism must work for the API (any provider), Claude Code and Codex.

## Decision

### 1. Tool groups, a core, and one directory for the rest

- A tool's group is its scope's prefix (`browser:use` → `browser`, `github:repo.read` → `github`); each custom connector is its own group (`toolGroupKey`).
- The core is always listed: the conversation (scope `""`), `context`, `memory`, `skills`, and `read_wiki_page` / `search_wiki` (the prompt points at them).
- `presentTools(tools, sensitive, loaded)`: with `loaded`, the core and the loaded groups go as they are (big connectors still as their own directory); every other tool goes behind `find_tools` (BM25 over names, descriptions and inputs, no model call) and `use_tool` (runs one by its real name). Without `loaded`, everything is listed, as before.
- The gateway runs `use_tool` as the real tool (scope, schema, call checks, approval, steps, chip), exactly like a big connector's directory. A tool on demand called by its own real name also runs: the gateway knows every granted tool.
- `find_tools`'s description names every group with its count, so the model knows what it can reach.
- `find_tools` also ranks the tools already listed, in the same BM25 pass: those that outrank every other match open its answer, to call directly and not through `use_tool`; one that matches less keeps its rank, marked the same way, so it never comes before a better match. A model that searched for a tool it already had otherwise read the unrelated matches as all there was, and said it couldn't.
- `find_tools` also ranks, in the same pass, this server's tools the agent may not use (every source's tools for the workspace, the agent's grants decide; the browser's and the desktop's give theirs without a grant, with no machine lookup). Those among the best close its answer, after the usable ones and never in their place, by name and one sentence, never their input: "Not allowed for you yet", grouped by the permission `request_permission` offers for them (the same list, `missingPermissions`, so what the agent asks for is what the card grants; the computer's scopes, which "all tools" never covers, with what they give), and "Turned off for you by an admin" for a `deny:<tool>`, without `request_permission`. A permission `request_permission` doesn't offer (a mailbox's, a database's, one more scope of a connector the agent already has some of) isn't named, nor a tool the run's policy would refuse anyway; a run that can't call `request_permission` is told a person can turn them on. A missing permission otherwise read as a missing capability: the agent said it couldn't, never that a person could turn it on.

### 2. The judge picks the groups once per run

- `chooseToolGroups`: one calibrated `noul` per group not kept (below), in one judge request. State: the agent (name, role, instructions), the message, and the last 6 messages where it answers. A group loads at ≥ 0.3.
- Kept without asking (`keptToolGroups`): the groups of the agent's previous run in the same thread (the thread's list only grows, so a computer brain's live session and the prompt cache aren't reset by every message), and the groups of the tools the agent called in the channel in the last 6 hours.
- Calibrated only (`calibrated: true`): without Jev, on a 1.5 s timeout or an error, the run gets the core and the kept groups. A wrong guess costs a `find_tools` call, never a capability. The judge never grants anything.
- The choice is saved on the transcript (`toolGroups`) and in the run's `context` step (groups, scores, source, kept). Every turn of the run, its resumes after approvals and the runner bridge read the same list (`ToolContext.loadedGroups`).
- On by default in the server (`toolsOnDemand`); the engine's tests list every tool unless they turn it on.

### 3. A shorter "What you can do"

Tool names only, by group (the description is already in each tool's schema), plus one line for what is on demand. Guidance tied to a tool (browser, schedule, PDFs) is still there when the tool is reachable on demand, and tools it names that aren't listed run through `use_tool`.

### 4. Context on demand

- Wiki: pages the message names and the best match go in, up to 1,500 characters each; other matches are one index line each, read with `read_wiki_page`.
- Memory: at most 3,500 characters; an item over 240 characters is cut with "[more with expand]" (pinned items keep 600).

## Consequences

- Smaller base per call on every brain, with the biggest gain on the API (schemas of the core and the chosen groups only). On Claude Code, which already hides MCP tools behind its own ToolSearch, the gain is the shorter prompt now; a short MCP list also makes the runner's `alwaysLoad` cheap, removing its extra ToolSearch call.
- One more judge call at the start of a new run (p50 ~245 ms in that eval), in front of the first model call.
- The model sometimes needs one `find_tools` call before acting. To verify with a behavior eval on real models before tuning the threshold or the core.
