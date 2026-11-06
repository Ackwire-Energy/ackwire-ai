# 0150. Who sees what: one audience for tasks and wiki pages, and administrators see every channel

- Status: Accepted (built)
- Date: 2026-11-06
- Extends: ADR 0023 (wiki addenda), 0085 (roles), 0121 §4 (Mostrar para todos), 0125 (channels by role), 0145 (task conversations)
- Code: engine `task-access.ts` (`Audience`, `taskSeenSql`, `taskReaderSql`, `taskReadersAmong`, `adminChannelSql`, `audienceOfConversation`), `issues.ts` (`IssueAudience`, `personSees`, `agentReaches`, `canSee`, `seenByConversation`, `setIssueAudience`, `announce`), `issue-tools.ts`, `wiki-tools.ts`, `requester.ts` (`visibleToField`, `chosenAudience`), `wiki.ts` (`chosenCols`, `setWikiPageAudience`), `wiki-links.ts`, `channels.ts` (`requireChannelAccess`, `readableChannelIds`, `listChannels`, `channelCard`, `joinChannel`), `search.ts` (`userVisibleChannels`, `issueSearchScopes`), `messages.ts` (`mentioned_people`), `notification-producers.ts` (`inChannel`), `artifacts.ts`, `calendar.ts`, `team-week.ts`, `agent-audit.ts` (`callSubject`, `hiddenFrom`), `authority.ts` (`runPerson`); adapters `search.ts` (`visibleIssueScopes`); server `routes/app/issues.ts` (`PUT …/issues/{id}/audience`), `routes/app/wiki.ts`, `routes/app/schemas.ts` (`AudienceChoice`), `realtime/ws.ts`; client `lib/who-sees.ts`, `lib/channel-access.ts`; web `components/WhoSees.tsx`, `wiki/WikiAudience.tsx`, `pages/IssuePage.tsx`, `pages/NewIssueDialog.tsx`, `pages/ChannelPage.tsx`, `components/Sidebar.tsx`, `components/AgentActions.tsx`; phone `features/shared/WhoSees.tsx`, `app/(app)/who-sees.tsx`, `features/issues/*`, `features/chat/ChatScreen.tsx`, `features/chats/ChatsScreen.tsx`; migration `0240_task_audience.sql`

## Context

A task had two states: the workspace's, or tied to a conversation (`issues.channel_id`), and only people of that conversation saw it, administrators included. Nobody could keep a task to themselves or show it to two colleagues. Admins couldn't see private channels at all, which doesn't fit a work environment: the owner's rule is Discord's, administrators see every channel, and DMs between other people stay private.

## Decision

### 1. One audience: everyone, only me, specific people

`Audience` is `{ mode: "everyone" }` or `{ mode: "people", userIds }`. "Only me" is a list of one, so it needs no state of its own. Administrators (the `administrator` key and owners) always see, wherever the list points. This is the wiki's model already (`restricted` and its lists), so a task takes the same two columns and a page needs no new one. Drive files, Painéis and missions keep their own rules (§8).

### 2. Tasks

`issues.restricted` and `issues.audience_user_ids`. A task's audience is one of three, exposed as `IssueView.audience`:

- `everyone`: `channel_id` null, or a public channel.
- `people` with `channelId`: tied to a DM or a private channel. Those people are whoever is in it now, as before this ADR, so joining and leaving keep working with nothing to sync.
- `people` with no `channelId`: `restricted`, the list.

**Existing tasks don't move.** A tied task shows as specific people, with the conversation's names, and stays live. Writing a snapshot of members would have let someone removed from a private channel keep its tasks and left someone added later out, and neither is what those people expect. Migration 0240 only adds the columns. Changing who sees a tied task unties it: the chosen list replaces the conversation.

Anyone who can edit a task, which is anyone who sees it, changes it (`PUT …/issues/{id}/audience`). Whoever changes it stays in the list unless they're an administrator, and a person assigned to it stays too, so nobody loses a task by surprise. Assigning someone outside it is refused with `issue.assignee_outside`, which says to add them first. Limiting a task limits its steps; showing it to everyone leaves its steps as they are, so a step someone kept back isn't shown. A new step follows its parent.

### 3. What an agent picks and reaches

From a public channel a task is everyone's, from a DM or a private channel it's tied there, and from a task's own conversation it follows that task (`conversationOf`). The agent may pick otherwise with `visible_to` (`requester`, `everyone`) when a person is behind the run; with nobody behind it, nobody asked for it to reach further. The tool's answer says who sees it and tells the agent to say so, and its receipt carries `params.audience`, a link to the same control.

By id, an agent working for a person reaches what that person reaches (`canSee`, the rule ADR 0145's files follow). In a list (`list_issues`, `openTasksBrief`) it shows a limited task only where everyone in the run's conversation sees it (`seenByConversation`), since what it says reaches them, and never in a public channel. With nobody behind the run it keeps its own reach: what's tied to its conversation, and its own task from there.

A wiki page keeps its stricter rule (a run reads a page only if everyone in the conversation sees it, ADR 0023 addendum): a page's text goes straight into answers.

### 4. Wiki pages

The same three options on a page and on a new page, for anyone who edits it (`setWikiPageAudience` with `audience` alone). Choosing agents or editors still takes `manage_roles`, in the full Acesso dialog, a click away. A page is still kept inside its folder's audience. Administrators now always see a page; before, only owners did. An agent's page takes `audienceOfConversation`: the list of the people there from a DM or a private channel. It has no live link to the conversation, because a page outlives the talk it came from.

### 5. Administrators and channels

`requireChannelAccess`, the one check for reading a channel, lets an administrator into every `channel`, never a `dm`. `task` conversations follow their task. The rest follows from the same rule: `readableChannelIds`, `userVisibleChannels` (search, memory, calendar), `currentSubscriptions`, Drive (`personCanRead`, `personReadableChannels`), a wiki backlink, the weekly card, a mention (`mentioned_people`: named, never by `@everyone`) and its notification (`inChannel`).

A DM between other people stays closed everywhere. A task tied to a DM is shown to an administrator, the task, not the DM: `issueFromMessage` checks the message, not the task, and search reaches the DM's tasks through `visibleIssueScopes`, read only on tasks' documents.

**Where they appear.** Discord lists every channel in an admin's sidebar. We list them too, in `listChannels` with `seenAsAdmin`, but keep them off the sidebar, as the owner asked: one "Outros canais" row with a count opens a menu of them, the palette finds them, and the channel being read shows in the list while open. The phone lists them at the end of the home. Opening one reads it at once, with no unread counts, and "Entrar" takes the composer's place: an administrator reads without joining and joins to talk. The API lets an administrator post without joining; the apps don't offer it.

### 6. Reaching people in real time

A limited task's events go to its people and to administrators on their own topics (`userTopic`), never to the workspace; a tied task's also go to its conversation. Changing the audience sends one org broadcast, `issue.audience`, with only the id: everyone's boards read again, and what they get is what they may see. Who loses a task loses its notifications in the same transaction. A socket subscribed to its conversation ends at the next recheck (`SESSION_RECHECK_MS`), not at once.

Search: a limited task's document carries its own id as its scope (`channelIds: [id]`), so no channel reaches it, and `searchForUser` passes the tasks a person sees as `visibleIssueScopes`. An adapter that ignores the field keeps them out, the safe side.

### 7. The audit log

`view_audit` is a role key: administrators hold it by default and any role can be given it. `listAudit` shows everything to administrators. For anyone else, a row about a task or a page they don't see loses its details, keeping that something happened: `hiddenFrom`. A title reaches the log in the `tool.call` rows of `create_issue`, `update_issue`, `comment_issue`, `create_wiki_page`, `update_wiki_page` and `link_to_wiki` (their `input` and `title`), and in `wiki.page_*` rows (`slug`, `title`). `details.about` now says what such a call wrote. An older row, or a failed call, goes by its conversation: who doesn't read it doesn't get what was typed there. People's task changes write no title to the log.

### 8. What stays as it is

- **Drive files.** A file's audience is its conversation (`artifacts.channel_id`), read in `personCanRead`, the list queries, `agentReaches`, sharing and search. A list of people there is a second path through all of them, not the same small change. Administrators reach channel files through §5. A file attached to a limited task keeps its own audience.
- **Painéis.** They already offer workspace, only me and roles (ADR 0135 §8). A `private` board is its owner's alone, administrators included, and what an admin sees they also edit and delete, so opening it is a decision of its own.
- **Rotinas.** Their audience is who may see the run's conversation and its creator; they already follow `requireChannelAccess`.
- **Missões.** They live in a channel, so they follow §5.
- **Channels.** Not redone: membership, role audiences (ADR 0125) and the exceptions (ADR 0134) stand.
