# 0131. Autonomy brakes: proactive by default, bounded where nobody asked

- Status: Accepted (built: the server, the web and the phone app)
- Date: 2026-11-02
- Extends: ADR 0097 (the turn-end controller and its default-allow addendum), ADR 0032 (calm waits and calm wakes), ADR 0053 (who is behind a run), ADR 0121 (long work), ADR 0034 and 0085 (agents asking agents)
- Code: `packages/engine/src/brakes.ts` (`endsAsking`, `askStillOpen`, `costlyKind`, `costlyGate`, `decideCostlyProposal`, `signatureOf`, `triageItem`, `brakeWakes`, `postAutonomyDigests`, `callableAgents`), `autonomy-settings.ts`, `continuation.ts` (rule `asked`, the judge's `continue` wording), `follow-through.ts` (`wakeFollowUp`), `context.ts` (the proactivity line), `talker.ts` (`statusReply`), `tools/gateway.ts` (the costly gate), `jobs.ts` (`onlyCallable`, the brakes before `dispatchMentions`, `autonomy.later`), `consultations.ts` (`reachableAgent`), `team.ts` (`teammatesFor`), `notification-producers.ts`, `agents.ts`; server `routes/app/agents.ts` (`brakes` on the agent, `POST …/autonomy-proposals/{signalId}`), `workers.ts` (`autonomyDigest`); client `lib/action-cards.ts` (`CostlyProposalCard`), `lib/message-body.ts`, `lib/long-work.ts` (`talkerStatusText`); web `pages/agent/BrakesCard.tsx`, `components/CostlyProposalCard.tsx`; phone `features/agents/BrakesSection.tsx`, `features/ai/CostlyProposalCard.tsx`; migration `0186_autonomy_brakes.sql`

## Context

The default-allow direction (ADR 0097 addendum, ADR 0120, 0121) made agents act and wake by default within their permissions. A co-owner then hit three runaway cases in one afternoon:

- **(a) Asked, then went ahead.** An agent ended its turn with "Quer que eu faça?". The turn-end judge's `continue` criteria counted "offered reversible work inside what it was asked ('want me to create the issues?')" as a promise to keep, so the controller told it to go on: it installed packages and ran a 40-file benchmark. The person's "ta fazendo oq ai?", "??" and "ow maluco" got no answer for four minutes (the quick reply runs on the workspace's cheap API model, and a workspace on a Claude plan alone has none, so every try failed silently), until the safety net moved the run to long work and "cancela tudo" stopped it.
- **(b) Alert noise became work.** A routine watching an error tracker posted each error and tagged an agent. The agent tried to fix each one, most of them old or benign (known freeze errors), opened about ten PRs in a loop and overloaded its computer, until the owner shut it down.
- **(c) Cross-project calls.** An agent mentioned another agent that works on a different repository and mixed their contexts; the owner had to add an instruction forbidding it.

Calm waits and calm wakes (ADR 0032 addenda) order and park turns on a busy computer. They never cap how much work starts, nor what it is about.

## Decision

The brakes apply to work nobody asked for directly: a run whose authority (ADR 0053) isn't `person` (a routine's run, or an unattended run woken by a routine's report, a webhook or an agent's own work), and an agent's message whose chain doesn't root in a person (`messageRoot`). What a person asks, directly or through a chain of agents, is never held by them. Cheap proactive steps (answering, reacting, reading, notes, internal changes) stay automatic.

### 1. Asking means waiting

- **The controller.** `decideTurnEnd` gains a cheap rule before the judgment: a conversation turn whose reply ends asking something (`endsAsking`: its last line ends with "?", code blocks and trailing marks aside) ends `done` with rule `asked`, unjudged, so no continue nudge can push it into doing what it asked about. A run told to ask (`askPending`) still turns its question into the card. The judge's `continue` criterion drops the "offered reversible work" example and says an ask to the person waits for their answer.
- **The prompt.** The proactivity line of "# How you work" adds: if you asked the person something, wait for their answer: end your turn there and don't go ahead as if they had said yes.
- **Follow-ups.** `wakeFollowUp` settles a follow-up `canceled` instead of waking the agent while the agent's last word in that conversation is an unanswered question (`askStillOpen`): the answer wakes it.
- The long-work safety net needs nothing: the run ended.
- No timeout on the wait: the person's answer (or anyone's message) is what moves it, as before.

### 2. A person always hears what a working agent does

The quick reply (`talker.ts`) already answers a person who writes to a working run, from what the run does. When its cheap model can't answer (an error, no API key, too slow), it no longer passes silently: the server posts its own status line (`statusReply`, body code `talker_status`): how long it has worked, what it does now (the agent's automatic status line, `presence.agent.*`) and that it reads the message after this step. Same rate limits and checks as a quick reply (one per run per 30 s, never after the agent answered). A deliberate pass still posts nothing. Live steering on computer brains is unchanged.

### 3. Costly unrequested work needs a go

- **What is costly** (`costlyKind`): opening a PR or MR (a connector tool named so, or `gh pr create`, `glab mr create`, `hub pull-request`), installing packages (`npm|pnpm|yarn|bun install|i|add|ci`, `pip install`, `uv add`, `poetry add`, `apt|brew|cargo|gem|go install`), and a long run (`long`: more than `LONG_STEPS`, 40, tool calls). Starting long work is already only for runs a person is behind (ADR 0121 `workEligible`).
- **Where** (`costlyGate`): in the Tool Gateway, after the arguments' checks and before approvals, so every brain meets it: API calls, bridged tools, and a computer brain's permission prompt (a refusal is the prompt's JSON `deny`).
- **What it does**: the agent's `never` list refuses; a go (the agent's `costly: go`, its `go` list, or a person's go on this run) passes, PRs within `maxPrsPerHour` (default 3, counted as `pr` signals in the last hour). Anything else is refused with "a card asks the person responsible; end your turn with one line of what you'd do", and the first refusal per run and kind posts the **proposal card** (`meta.actionCard.kind = autonomy_proposal`) where the run answers, for the person accountable (a routine's creator, else the agent's owner), notified as that card's person.
- **The card**: Pode fazer (this run), Sempre (remembered on the agent: `brakes.go`), Agora não, Nunca (remembered: `brakes.never`), by the person it is for, the agent's owner or who manages agents (`POST …/autonomy-proposals/{signalId}`). The decision reaches the run that asked as an agent-only `proposal_result` notice, which wakes it.

### 4–7. One item is worked once, noise waits, repeats stop, caps

Before `dispatchMentions` wakes agents for an agent's or a routine's message nobody asked for, `brakeWakes` decides per agent:

- **Signature** (`signatureOf`): the item's first link without query or fragment (an issue's or an error's page), else its first line with numbers, ids and hashes taken out, hashed. Every outcome is an `autonomy_signals` row (`wake`, `linked`, `digest`, `loop`, `later`; also `pr` and `proposal`).
- **§4 open work takes it** (`linked`): the agent already has an active run woken for the same signature: no second run, an agent-only note goes into that run ("reported again: include it in your report").
- **§6 repeats stop** (`loop`): `LOOP_MAX` (3) wakes on one signature within 24 h: no more runs on it that day, and one line from the agent where it came in, for its owner ("it came back 3 times in a day; tell me how you want it handled"). The same tool error repeating inside a run is already stopped by `stuck.ts`.
- **§5 noise waits for a digest** (`digest`): one cheap judgment per message (`alert_triage`, kind `work` or `noise` at p ≥ 0.6; no judge or an error is `work`). Noise starts no run. Every 10 minutes the worker posts, per agent and conversation whose oldest held item is an hour old, one digest line from the agent, grouped by signature with counts, for its owner (`autonomy_digest`).
- **§7 caps** (`later`): an agent with `maxUnrequested` (default 2) unrequested runs active, or, for work a routine or a webhook started, whose computer has turns waiting for room (`crowdedAgents`; agents' own chains already wait in calm wakes' inbox and ranks), doesn't start new unrequested work: the wake looks again every 2 minutes (`autonomy.later`), up to an hour, then goes to the digest. People-asked work never meets these caps; their runs come first in the computer's line already.

### 8. Who an agent may call

`brakes.callAgents` (`all` by default, `some` with `callAgentIds`, `none`) and `brakes.project` with `otherProjects` (agents with different non-empty projects don't call each other unless allowed). Enforced on an agent's mentions and copies to non-members (`onlyCallable` in the message job: the left-out agents aren't woken and the run that wrote it gets a `wake_skipped` note saying so), on `ask_agent` / `tell_agent` (`reachableAgent` refuses), and in the prompt's "# Your team" (`teammatesFor` lists only callable agents). A person's mentions are not affected.

### Settings

`agents.autonomy_brakes` (jsonb, `{}` = the defaults), read through `autonomySettings` (clamped and filled), shown as `Agent.brakes` and changed with `PATCH …/agents/{id}` `brakes` (fields merged, who manages agents). Web: Configurações → "Trabalho que ninguém pediu" (`BrakesCard`, saved at once). Phone: the agent's edit screen (`BrakesSection`). The defaults keep today's autonomy for normal use: everything a person asks, and cheap proactive steps, are unchanged; only costly unrequested steps ask first.

## Consequences

- One extra judge call per agent message nobody asked for that wakes agents (`alert_triage`); mentions between agents in a person's chain skip it.
- An unrequested run that needs a PR now waits for a person once per run and kind, unless the owner says Sempre or sets "Fazer direto". Expect a few proposal cards per day on workspaces with error routines; "Sempre" makes them go away for that kind.
- Signatures are heuristics: two different errors with the same first line and no link share one; the same error worded differently gets two. The loop stop and the digest are per agent and conversation.
- Open PRs on the code host aren't read (no GitHub call): §4 links only to work this server knows (active runs on the signature). A PR the agent opened lately counts through the `pr` cap and the loop stop.
- Migration 0186 (`agents.autonomy_brakes`, `autonomy_signals`).
