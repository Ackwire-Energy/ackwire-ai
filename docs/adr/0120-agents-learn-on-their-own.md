# 0120. Agents learn on their own

- Status: Accepted (built)
- Date: 2026-11-01
- Amends: 0017 (proactive writes and the trust rule), 0020 (agent-made skills, `update_skill`, promotion), 0097 §4 (the `remember` policy), 0028 (the background job only adds)
- Code: `packages/engine/src/context/learn.ts` (`learnTrust`, `afterTurnDone`, `learnRun`), `context/learned-skills.ts` (`changeSkillAsAgent`, `revertSkillChange`, `promoteHowTos`, `shareAcrossAgents`, `decayAgentSkills`), `context/items.ts` (`mayReplace`, low trust never verifies, `person` scope), `context/tools.ts` (memory tools, retrieval), `context/consolidate.ts`, `continuation.ts` (the `learn` question, `runCalls`), `executor.ts` (`learnLater`), `jobs.ts` (`context.learn`), `skill-tools.ts` (`update_skill`, use counting), `skills.ts`, `context/proposals.ts` (target `skill`), `agent-actions.ts` / `agent-undo.ts` (`skill.created`, `skill.updated`), `message-memories.ts`, `context.ts` (`HOW_YOU_WORK`), `capabilities.ts`; routes `apps/server/src/routes/app/knowledge.ts`, `memory.ts`, `skills.ts`; web `apps/web/src/pages/agent/MemoryTab.tsx`; migration `0173_agent_learning.sql`

## Context

Agents already kept memory: `remember` when a person asked, `context.reflect` on threads, lessons from refused approvals and corrections, the daily `context.consolidate`, `save_how_to` (the reuse-past-work addendum to ADR 0017). Three gaps kept them from getting better with time:

- They saved only when told to. A correction in passing, a preference, a way they worked out after five tries were lost unless a person said "remember".
- Reflection runs on threads only: top-level DMs and channels, where most work happens, never taught anything.
- A procedure saved as a how-to stayed a note. Nothing turned a method used again and again into a skill, and a wrong skill stayed wrong.

The design (owner-approved, with research on Hermes's background memory review) is to extend what exists, not to add a second memory system.

## Decision

### 1. When learning happens

No ordinary turn pays for an extra model call.

- **In the turn (free):** the prompt tells the agent to save on its own when a person corrects it, states how they want things done, or it learns a lasting fact, and to save a how-to when something took figuring out. `remember`, `update_memory`, `forget` and `save_how_to` no longer need a person to ask (§3).
- **At turn end, on the existing judgment:** `continuationVerdict` asks a second question, `learn` (`none | method | correction | fact`), in the same `follow_through` call. A turn judged done whose answer isn't `none` queues `context.learn` for the run (`afterTurnDone`). With no judge, code signals do it: a failed tool call later fixed on the same tool in a run of at least `LEARN_MIN_TOOL_CALLS` calls, or a task `search_context` found among its own earlier steps with no how-to in its memory yet.
- **Skipped:** a run that already wrote memory itself (`remember`, `save_how_to`, `update_memory`, `update_skill`); a turn not judged done; an agent at its daily cap.
- Unchanged: refused approvals and UI corrections → lessons, reactions → relevance, `context.reflect`, the daily consolidate. The per-run job closes the flat-conversation gap; reflect stays thread-only.

### 2. The `context.learn` job

A sibling of `reflectThread`: one structured completion, no tool loop. It reads the conversation (thread or flat top level, up to 20 earlier messages, `m1…`, `[untrusted]` marked), the run's tool calls (`s1…`, `[outside]` marked), what the agent already knows on the subject (titles), the skills it loaded and the ones it made. Usage kind `summary` with `agentId` and `runId`, through the Model Gateway (the org's budget check; an agent past its own monthly budget is skipped; usage recorded with `org_id` and `agent_id`). Model: the summary model with the org's override.

The model proposes items (`fact | preference | decision | lesson | how_to | term`, a scope `own | team | workspace | person`, refs) and at most two skill fixes. Code decides everything else:

1. An item with no valid ref is dropped; credential-shaped text is dropped.
2. Trust is high only when the run's trust is high and no cited ref is outside content (§5).
3. Scopes beyond the agent's own need high trust; `person` also needs a cited message of that person's (matched by name). Otherwise the item is the agent's own. A how-to is always the agent's own.
4. Storage, no new kinds: `how_to` → a `note` with subject `how to <title>`, `term` → a `fact` with subject `term <word>`, `person` → `scope_type person`, `scope_id` the user's id, no agent.
5. It only adds: `consolidateItem` runs with `mayReplace(old) = old.createdByKind !== "person"`. A contradiction with something a person wrote keeps both, linked and `disputed`, until a person decides (Hermes's silent supersede, avoided).
6. Each new item is a `memory.saved` receipt with Undo; nothing is posted. Learned items are the agent's own writing (`created_by_kind agent`), so no memory mark shows on the person's message.
7. A skill fix applies only to a skill this run loaded: the agent's own unlocked skill gets a new version (`skill.updated` receipt, its `before` holding the old body); a person's skill becomes a proposal.
8. Bounds: `agent_learning_days` counts jobs per agent and UTC day against `LEARN_MAX_PER_AGENT_DAY` (0 turns learning off). While the agent has another run active in the same conversation the job is skipped; the next turn end queues it again. Learning never waits on or blocks a live turn.

### 3. The memory tools

- **`remember`**: new `basis` (`person_said | found`). `person_said` when a person wrote the message this run answers: human evidence, 0.95, `created_by_kind person`, the memory mark in the chat, `everywhere` honoured, may replace what a person wrote. Otherwise: the agent's own claim (self evidence, 0.75, `created_by_kind agent`), channel-scoped, quiet, and it never replaces a person's item (both disputed). Every new item or version is a `memory.saved` receipt.
- **`update_memory` / `forget`**: on what the agent or its learning wrote, owned by this agent, no person needed; on what a person wrote or the team's shared memory, a person's request as before.
- **`save_how_to`**: trust from `learnTrust`, channel-scoped (unchanged), a quiet `memory.saved` receipt (new), never replacing a person's item.
- **`update_skill`** (new, `skills:read`): `{name, body}`, only after `load_skill` of that skill in the same run. Its own agent-made unlocked skill: a new version with a receipt; locked or another agent's: refused; a person's: a `skill` proposal that someone who manages agents accepts (the stored body must still match). The prompt says: fix a wrong skill before answering.
- `HOW_YOU_WORK`: "saving what you learned (a correction, a preference someone stated, a fact about the company, how you got something working)" among the internal changes that need no permission. The branch's "look for how it was done before" line stays.
- No skill is created in a turn: skills appear only by promotion (§4).

### 4. Promotion and sharing (daily consolidate)

- **How-to → skill:** a how-to whose `recurrence` plus 2 per positive outcome of a run that used it reaches `LEARN_SKILL_AFTER`, with high trust, not disputed and relevance ≥ 0.5, becomes a skill of its agent. A negative outcome of a run that used it marks it disputed and blocks it. Its cluster is the same agent's how-tos with a similar subject. One summary-model call writes `SKILL.md` (broad kebab-case name, a description under 200 characters, steps then pitfalls); code checks the name, credentials and the permission judge, stores a `skills` row (`source manual`, `origin agent`, `owner_agent_id`), turns it on for that agent only, archives the notes and writes a `skill.created` receipt on the latest run that used them (Undo brings the notes back). People give it to other agents in Skills.
- **Reuse counting:** a turn judged done bumps `recurrence` on the how-tos its memory carried (the run's `context` step).
- **Own → team:** the same lesson or how-to subject held with high trust by two or more agents becomes one item for the team (no agent), its channels all of theirs; the originals are superseded. Low trust is never shared.
- **Skill decay:** agent-made skills unused for 30 days (since the last `load_skill`, or since they were made) are archived (`deleted_at`, restorable); never a locked one, one an active routine's prompt names, or a person's skill.
- Promotion of items to instructions is unchanged (`proposals.ts`).

### 5. Trust

- **Run trust** (`learnTrust`): high only with a person behind the run (`personBehindCall`) and no outside content read so far: `web_search`, `web_fetch`, browser tools, and any result in an outside envelope (`external_data`, `page_content`, `email_content`, `database_rows`), which covers MCP and connector answers and mail. A person's message sent through a connected AI app (ADR 0119) carries `meta.readOutside` and counts as outside content too: the person stays behind the run, but what is learned from it is low trust and the agent's own.
- **Low trust never verifies** (`insert_context_item`, merges): such an item is labeled data, never shared, never promoted, never a skill. Only a person's edit (a new version) or a linked positive outcome raises it.
- Confidence set by code: a person's words 0.95, the agent's own finding 0.75 to 0.8, inferred from a person's message 0.7, outside content 0.5.

### 6. Retrieval

- The agent's own items rank by `verified`, then `0.7 × relevance + 0.3 × exp(−age/30 days)`, so the most used items don't stay on top forever; each use raises relevance by `0.05 × (1 − relevance)`.
- A person's preferences come in for runs they are behind (the trigger's author, the run's requester), at most five, and never elsewhere: not in another person's run, not in `search_context` or `expand`.
- A how-to found for the request gets 600 characters (the method is the point). The budget stays 3,500 characters; pinned items stay exempt.

### 7. Transparency

The agent page's Memory tab gets "Aprendizados" (What it learned): what the agent learned itself (its saves, its learning job's, what a person said that it kept), newest first, each with where (a link to the conversation), a chip (verified, unverified, outside data), disputed, the use count, Editar (a person's version, verified) and Esquecer (archived). Below, the skills it made: Ver, Desfazer última mudança (back to the body before its latest `skill.updated`, outside the receipts' undo window), Travar, Dar a outros agentes (Skills), Restaurar for an archived one. API: `createdBy` on `GET …/context-items`, `useCount`, `disputed` and `channelIds` on its items; `learned`, `howTo`, `disputed`, `channelId` on memories; `PATCH …/skills/{id}` with `locked`, `POST …/skills/{id}/restore`, `POST …/skills/{id}/revert`, `GET …/agents/{id}/learned-skills`; proposals with target `skill`.

### 8. Storage and config

Migration `0173_agent_learning.sql`: `skills.origin`, `owner_agent_id`, `locked`, `use_count`, `last_used_at`; `proposal_target` value `skill` (a skill proposal keeps the skill in its one access line, the new body as the proposed text); `agent_learning_days`. Config: `LEARN_MAX_PER_AGENT_DAY` (20), `LEARN_MIN_TOOL_CALLS` (6), `LEARN_SKILL_AFTER` (3). All core and Postgres-only through the outbox: self-host and Cloud behave the same.

### 9. Secrets

Learning never records a secret's value or where it is kept; the credential check and the permission judge apply to items, skill writes and fixes. The agent's context keeps the names of the secrets its computer holds (the reuse-past-work addendum), names only, which is not the future Vault.

## Consequences

- An agent gets better with use without anyone saying "remember", and people see every write and can undo, edit or forget it.
- Outside content can't poison shared memory or skills: it stays low-trust data in the agent's own memory.
- One structured call per learning-worthy turn, bounded per agent and day; nothing on ordinary turns.

## Skipped on purpose

| Skipped | Add it when |
|---|---|
| A forked tool-loop review (Hermes) instead of one structured call | one call proves too shallow |
| Reflect on flat conversations by period | flat channels need period-level learning |
| A notices setting (quiet unless a person's words were kept) | people ask for it |
| A model-driven merge of skills | — |
| The memory mark for a skill made from how-tos (no message carries it; the receipt does) | people miss it in the chat |
| "What it learned" on the phone (the phone already edits and forgets each memory) | the web list settles |
| The team's and a person's learned items on the agent's tab (they show on the workspace memory page) | people look for them there |
| A separate "stale" state for skills before archiving | something reads it |
| The new judge question and learn prompt checked on a Claude subscription sign-in (its filter refuses some wordings with a 400 that reads like billing) | before turning learning on for a subscription workspace in production |

## Addendum (2026-11-02): failures are reported

When the judge refuses the `learn` question and the verdict is asked again without it, `continuationVerdict` calls `onLearnFailed`, and the executor reports it (ADR 0104 addendum) with the judge's name and the model and provider of the judge call that failed, the agent's brain, provider, model and account kind apart (`agent_*`), once per workspace an hour. The learning job's refused model call is reported the same way and the job ends `skipped: "model_failed"` instead of failing; a rate limit or an overload still throws so the outbox tries again. A failure while queueing learning at turn end is reported too. This is how a Claude subscription sign-in refusing the wording shows up before learning is turned on for such a workspace.

## Addendum (2026-11-02): learning stays quiet

A non-technical owner saw chat receipts like "Guardei na memória: …the functions live in `supabase/functions/_shared/…`" and found them strange: nobody asked, nobody could judge them, and they felt fleeting. How and when agents learn, and every trust rule above, are unchanged. What changes is what people see.

1. **The agent's playbook is quiet.** `isPlaybook` (`context/items.ts`): a note (how-tos included) or lesson the agent wrote for itself (`created_by_kind agent`, agent scope). `save_how_to`, `remember`, `update_memory`, `forget` without a person's request and the learning job write no receipt for one; it lives in the Memory tab under "Como ela trabalha" (How it works), with the skills it made. What matters to people (their preferences, business facts, decisions about them or the workspace) still gets the one quiet receipt line. The learning prompt and `remember` put how its systems work (where code lives, what a file does) in a how-to or lesson, never a fact.
2. **A plain summary first.** An item's `title` is now one plain line in the language of the conversation, with no paths, code or ids (the learning job's schema, `save_how_to`'s and `remember`'s `title`), written in the same call that saves it: no extra model call and no new column. The receipt's line is the title; the API's `Memory` gains `summary` (the title when it says something the text doesn't) and `playbook`. Web and phone show the summary, the technical text folded under "Detalhes técnicos".
3. **Fleeting lessons expire.** The daily consolidate archives a low-trust note, lesson or fact the agent saved itself, never carried into a run (`use_count` 0, `recurrence` ≤ 1), not pinned, older than `LEARNED_EXPIRE_DAYS` (14). Archived items are restored from the Memory page. A how-to becomes the agent's skill as before (high trust, `LEARN_SKILL_AFTER` reuses in turns judged done, no negative outcome), now also only once used in finished runs of `SKILL_MIN_SPREAD` (2) conversations or days: one long conversation that keeps carrying it is not reuse. Low trust still never becomes a skill or is shared.
4. **Nobody is asked to review what they can't judge.** The consolidate's proposals skip playbook items (no "add this lesson to the instructions?" for a technical lesson). Playbook items are listed (`listAgentMemoryRows`, `listOrgMemoryRows`) only for the agent's owner and who manages agents; others who talk to it see what it knows about people and the business.

Follow-ups, same day:

- **Identity stays apart from the plain line.** A plain title in the conversation's language can't identify what an item is about (two projects' "Publicar o site", the same how-to learned in English and Portuguese). The learning job's schema, `save_how_to` (required) and `remember` take a `key`: a short, stable English name, technical words allowed, the term itself for a term. It is the item's subject; the title is only shown.
- **A receipt needs a plain line** (`receiptLine`): the title, or a person's own words. An agent's untitled finding gets none; it stays in the Memory tab. `update_memory` takes a new title and the receipts of `update_memory` and `forget` show titles too; a new text without a new title (an agent's update or a person's edit) drops the old title rather than show a summary of text that is gone.
- **Expiry respects a restore.** The expiry also needs `updated_at` older than 14 days, so an item a person restored gets a full new stretch instead of being archived again the next day.
- **The playbook's technical text stays with its owner and admins everywhere**: `listContextItems` (`/context-items`) and workspace search apply the same `readsPlaybook` rule (`audience.ts`) as the Memory tab.
- The phone's agent profile lists the playbook apart, under "Como ela trabalha" with its note, like the web. The note says only what came from outside leaves on its own: high-trust lessons don't expire.

Skipped: a separate `summary` column (the title carries it; add one when titles and summaries need to differ), regenerating summaries for items saved before this addendum (their titles stay as they were; the next version gets a plain one).
