# Discord-style layout (web)

Build plan for the layout the owner approved in the concept (version 2). Four slices, built one after another in
this worktree (`feat/discord-layout`, from origin/main fd8844719). Each slice ends green on its own tests, lint,
typecheck and boundaries, and is committed before the next starts.

The concept is the spec. Its files live outside the repo (the session's scratchpad, folder `discord-concept/`):
`concept-render.tsx` (markup of every screen, built from the real components), `css/concept.css` (only what
changes, on top of the app's CSS), `shots/*.png` (light and dark, desktop 1440×900 and phone 390×844; `before-*` is
today's app), `review.html` (what changes). When the plan and the concept disagree, the concept wins, except for the
decisions written here.

## Approved decisions (the owner's)

- Copy Discord. Header: threads (with count), pins, a cog for channel settings, members toggle, then the search
  field. Remove the avatar stack and "Detalhes do canal".
- Header icon buttons: even 14px gaps, no plate on hover or when pressed. Hover only changes the icon color. The
  members icon stays in full ink while the column is open.
- Search in the header: a mini menu (filters, then recent searches), results in the right `.thread-panel` (the
  same one threads use), grouped by channel and thread, with "Ir para" that jumps and highlights.
- People and agents in a right column, grouped by hoisted roles. Open by default on desktop.
- Roles have their own configurable colors (already true, see slice 3). Agents hold no roles.
- Unread: bold name with a left pill. A red count only when you're mentioned.
- Member card: person with role chips and a roles picker. Agent with live activity, "Quem pode falar" as plain
  lines (role mark or face, then the name) with "Editar", owner and model, a ⋯ menu.
- Every role mark is a full circle (`RoleMark`, wherever it shows: chips, members column headers, pickers, Quem
  pode falar lines, Settings › Papéis). Not a rounded square.

## Rules for every slice

- Design-system tokens only. No literal colors in component CSS. New raw values go in
  `docs/design/design-system/tokens.css`, copied to `packages/ui/src/styles/tokens.css` and mirrored in
  `packages/tokens/src/index.ts` (`packages/tokens/test/tokens.test.ts` keeps them equal).
- Every user string through i18n: add to `packages/i18n/src/pt-BR.ts` and `en.ts`, then for each of the 12 other
  languages `bun run i18n:missing <code>`, translate, `bun run i18n:apply`. `bun run i18n:status` stays at 100%.
  No semicolons in copy.
- Helpers go in shared utils (`packages/client/src/lib/*` for logic, `apps/web/src/lib/*` for web-only), with a
  grep first for one that exists. Keep new UI out of `ChannelPage.tsx` (4,600 lines): new components in their own
  files, ChannelPage only wires them.
- Tests are required. One file at a time: `cd <package> && bun test test/<file>`. Typecheck one package at a time
  (`bun run typecheck`), `bunx biome check <changed files>`. No full suite, build or dev server. No Docker or
  Postgres.
- Migrations: `bun run db:generate <name>` (numbers 0183+; they get renumbered at integration). Custom SQL:
  `cd packages/db && bunx drizzle-kit generate --custom --name <name>`.
- Commit as you go: `git -c user.name="Heitor Lima" -c user.email="wnogueira@example.com" commit`, conventional
  plain-English messages ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Never push, merge to main or deploy.
- Don't remove or weaken features. Anything the concept leaves out moves behind the new entry point (see "Keep").

## How to check visually (all slices)

No dev server here. Two checks:

1. Structure and CSS in tests: screen tests with happy-dom (`apps/web/test/render.tsx` + `fake-api.ts`) for
   markup, states and aria. CSS rules in `*-css.test.ts` files over the built CSS (`apps/web/test/built-css.ts`,
   as `sidebar-css.test.ts` does).
2. Screenshots: reuse the concept's harness. `discord-concept/build.sh` server-renders real components into static
   HTML with the app's CSS, and `shots.ts` screenshots it in headless Chrome for Testing over CDP. Copy both to a
   new scratchpad folder, point `build.sh` at this worktree instead of a throwaway one at 53f28b270, and render
   the new components with fixture data (the fake-api seed, wrapped in the app's providers with a seeded
   QueryClient). Take light and dark, 1440×900 and 390×844, and compare each with the matching
   `discord-concept/shots/<screen>-<theme>.png` by eye. Never commit the harness or the shots.

The full app is checked in CI and on the review box after integration, not here.

---

## Slice 1: sidebar (contrast, selected plate, unread, mentions) and shared foundations

### Foundations first (first commits, used by every later slice)

- `RoleMark` circle: in `packages/ui/src/styles/components.css`, set `.ac-rolemark { border-radius: 50% }`
  instead of `var(--radius-agent)`. Update the doc comment in `packages/ui/src/components/RoleMark.tsx` (it says
  "the people tile's shape (the cut corner)"). Check the dither and the icon still sit centered at 16, 18, 36 and
  64px. Check `RoleMark` isn't drawn with its own clip in `apps/mobile` (today it isn't).
- New icons in `packages/ui/src/icons/extra.ts` on the 20px grid: `cog` (the concept's `COG` path plus a
  r=2.4 hole, `concept-render.tsx` near the top) and `crown` (the concept's `Crown` path). Keep `settings`
  (sliders) for the places that use it.
- Dark tokens: `--pane: #181817` and `--side: #0b0d11` (both sidebars a step under the chat), in the three token
  files. `--side-hover` / `--side-chosen` as `color-mix` of `--ink` into `--side` (5% / 10% light, 6% / 14% dark),
  defined in the design-system tokens so the right column uses the same plates.

### Unread backend: take feat/unread-states, drop its UI

Branch `feat/unread-states` (worktree `/Users/heitor/Code/agentes-chat/wt/unread-states`, commits c2255f606 to
8cfddec15) fits: main already has `channel_reads` and `unreadCount`. The branch adds what's missing.

Take (port by hand or cherry-pick and resolve):

- `packages/db/src/schema/chat.ts`: `thread_reads` table, `channel_reads.muted`. Don't copy its migration
  file (`0187_unread_states.sql`). Change the schema, run `bun run db:generate unread_states` (it becomes 0183),
  then add the branch's backfill `INSERT INTO thread_reads … ON CONFLICT DO NOTHING` to the end of the new file
  before committing.
- `packages/engine/src/channels.ts` (`mentionCount`, `muted` in `listChannels`), `follows.ts`
  (`threadReadAtSql`), `threads.ts`, `dms.ts`, `events.ts` (publish to `chatActivityTopic`),
  `packages/adapters/src/pubsub.ts` (`chatActivityTopic`), `apps/server/src/realtime/ws.ts` (relay
  `channel.activity` to members' sockets, never the author's), `apps/server/src/routes/app/{chat,dms,threads,
  schemas}.ts` (mute PUT/DELETE, `POST …/threads/{id}/read`, `GET …/unread-threads`).
- `packages/client`: `Channel.mentionCount` / `muted`, `ThreadInfo.unread`, `UnreadEvent`, the API methods,
  query keys and live updates in `queries.ts`, `lib/unread.ts` (`looksUnread`, `unreadTotal`,
  `titledWithUnread`), `lib/recent.ts`, `lib/audience.ts`.
- Web behavior that isn't visual: `apps/web/src/realtime/context.tsx` (the user-scope unread events),
  `hooks/useUnreadTitle.ts` (tab title count), the "Silenciar canal" entry in `components/entity-menus.tsx`,
  ChannelPage's thread read call.
- Phone behavior that keeps counts right (`cf1752b70`: a thread view marks its thread read). Without it, the
  phone leaves followed threads unread forever once the server counts them apart. Take
  `apps/mobile/src/features/chat/ChatScreen.tsx`, `features/shared/queries.ts`, `features/chats/logic.ts`, the
  signed-out badge reset (8cfddec15) and their tests. Leave out the branch's mobile visual tweaks.
- Tests: `packages/engine/test/unread-states.test.ts`, `packages/client/test/unread.test.ts`,
  `apps/server/test/ws.test.ts` additions, `apps/mobile/test/features/chats.test.ts`.
- `docs/backend-progress.md`: the branch's entry (Portuguese).

Drop: the branch's `Sidebar.tsx` and `layout.css` visuals, and `apps/web/test/unread-marks.test.tsx` (it tests
the disliked look). Rewrite that test for the new look below.

### Sidebar UI (`apps/web/src/components/Sidebar.tsx`, `apps/web/src/layout.css`)

From `concept.css` "Sidebar: channel states like Discord":

- Channel rows (`row()` in `SidebarChannels`): `data-kind="channel"` and `data-unread={looksUnread(c)}`. Read rows
  in `--faint`, weight 500. Unread rows in `--ink`, weight 650, icon in `--ink2`, and the pill (`::after`, 4×8px,
  `left: -12px`, radius `0 4px 4px 0`, `--ink`) at the sidebar's edge.
- The red count only for mentions: `mentionCount > 0` renders `CountBadge` with class `sidebar__mention`
  (`--danger` background, `--raised` text, 18px). No number for plain unread. aria-label `shell.mentions`.
- Selected (`data-status="active"`): one solid plate `--side-chosen`, no sky image, no glow, no `::before`; name in
  `--ink` 600. Hover plate `--side-hover`. Remove the old sky/glow rules for the active row in `layout.css`
  (around lines 617 and 5094–5130), don't stack overrides on them.
- The active row's own actions stay visible (`personAdd` and the new `cog`, which replaces `settings` in
  `RowAction`). Other rows keep them on hover for who manages the channel.
- Categories: small and gray (12.5px, 600, `--faint`), chevron after the name, `+` on hover only.
- DM rows (people and agents): their unread count turns red (the same `sidebar__mention` style), as on Discord.
- A closed category or part keeps its summary. It shows the red mention total, or the pill when only plain unread
  is inside.

### The Agentes and Pessoas parts of the left sidebar (decision D1, approved by the owner)

The concept's sidebar has only tools and channel categories. People and agents move to the right column. But
today the left parts also hold the DM list, DM unread counts, agent groups (ADR 0083: create, rename, drag) and "+
new agent". The right column shows only the open channel's members, and only on channel pages.

The owner chose to replace them, as on Discord: the "Agentes" and "Pessoas" parts become one "Mensagens diretas"
part (`shell.directMessages`, the key exists). It lists the conversations that have messages, people and agents
together, latest first, with the red unread count, the presence badge and the agent's working trail. Its `+` keeps
today's entries (new DM, new agent). The agent group arrangement (new, rename, delete, drag) moves to the Team page
(`/org/$orgId/team`), reusing the dialogs and `GroupMenu` from `AgentGroups.tsx`. The agent's Settings tab still
picks its group. The rail (tablet or collapsed) shows the same DMs as faces. The part always shows (empty until
a first message), with Equipe beside its +. Its + is a menu (Nova mensagem, Criar agente) for who creates agents,
else the plain Nova mensagem button. The saved section order keeps "agents" (the server checks all four); the web
hides it and puts it back on save (`SidebarOrder.tsx`). Built as one commit, so keeping the parts is a revert.
The phone needs no matching change: its home already lists conversations (agent DMs, channels, people's DMs,
latest first, with agents to start one while there is none) and its agent groups already live in the Agentes tab.

### i18n (slice 1)

- `shell.mentions` ("{{count}} menção" / "{{count}} menções", plural), `shell.unreadMark` ("Não lida", the pill's
  aria for screen readers when no number shows).
- The branch's mute and unread keys (take them with their translations).
- Team page group section: `team.groups.title` ("Grupos de agentes"), `team.groups.empty` if needed. Reuse the
  existing `agentGroups.*` dialog keys.

### Tests (slice 1)

- Ported backend tests above, then `packages/engine/test/unread-states.test.ts` must pass on PGlite.
- `apps/web/test/sidebar-parts.test.tsx`: unread row has `data-unread="true"` and no number. A mentioned row shows
  the red count with its aria. A muted row never looks unread but keeps its mention count. The active row shows
  its actions.
- `apps/web/test/sidebar-css.test.ts`: the active row has no background image, the pill rule exists, the mention
  badge uses `--danger`, `.ac-rolemark` is `border-radius: 50%`.
- `packages/tokens/test/tokens.test.ts` stays green with the new dark values.
- DM part: lists only conversations with messages, latest first. Team page: group create/rename/delete reach the
  same mutations as before (update `agent-groups.test.tsx`).

### Visual check (slice 1)

Compare the sidebar crop with `channel-light.png` / `channel-dark.png` (x 0 to 264): gray read rows, bold unread
with the pill, the red 2 and 1, the solid plate on `lancamento-v2` with its two icons, gray categories.

---

## Slice 2: header and search

### Header (`ChannelPage.tsx` around line 1829, new `apps/web/src/components/ChannelHeader.tsx`)

Move the channel header into its own component. ChannelPage passes `channel`, `isMember`, the details opener and
the panel state.

- Title row: `#` icon (`channel__title-hash`, `--faint`), name, and the topic beside it after a hairline, shown
  only when it fits whole (the concept's wrap-and-hide trick: a 30px box with `flex-wrap` and
  `overflow: hidden`). Keep `entityMenu(() => channelEntries(channel))` on the title (right click). The subtitle's
  "Ada e Theo respondem aqui" (`channel.agentsAnswer`) leaves the header: the members column says it (slice 3
  keeps the auto-reply chip on rows).
- `channel__acts` with `gap: 14px`, four `channel__icon` buttons (28px wide, 20px glyph, `--muted`, hover `--ink`,
  no background ever, including `:active` and `aria-pressed`):
  1. Threads: `ChannelThreadsButton` (`components/threads/ThreadLines.tsx`) gets an icon-only trigger. The thread
     icon plus a small `CountBadge` (`channel__icon-count`, `--sunken`, ring in `--pane`). aria-label
     `threads.popover.button`. The popover stays as it is.
  2. Pins: a pin icon button that opens the pins list. Split `ChannelPinnedBar` (`components/ChannelPins.tsx`)
     into a `PinsPopover` with a `trigger` prop and reuse it from the bar and the header. With no pins, the
     popover says so (`channel.pins.empty`). The pinned bar under the header stays (decision D2, see Keep).
  3. Cog (`cog` icon): opens `ChannelDetails` (the existing dialog: description, members with search, add,
     archive, everything it has today), aria-label `shell.sidebarMenu.channelSettings`.
  4. Members toggle: `members` icon, `aria-pressed` = column open, title `channel.header.showMembers` /
     `hideMembers`. Wired in slice 3. In this slice it renders, pressed, and does nothing until the column lands
     (or ship it hidden until slice 3, whichever keeps tests honest).
- Remove `ChannelMembersStack`, `ChannelDetailsButton` and `SearchHereButton` from the channel header. Delete
  `ChannelMembersStack`, its popover `MembersList` and `ChannelDetailsButton` from `ChannelMembers.tsx` once
  slice 3 has moved `PersonRow` / `AgentRow` (do that move here if it's simpler, the rows are reused). Keep
  `SearchHereButton` for the DM header (`DmPage.tsx`).
- Phone (≤760px): only the members and search icons show. Threads, pins and cog move into the members sheet's head
  (slice 3), so they stay reachable. The topic hides, the hash is 18px.

### Header search (`apps/web/src/components/search/HeaderSearch.tsx`, `SearchBox.tsx`, `search.css`)

`SearchBox` already does what the menu needs (ADR 0123): chips in the field, filters and recent searches when
empty, the `de:` picker with faces, people and agents apart. Reuse it, don't rebuild it.

- Pull SearchPage's state into a hook, `apps/web/src/hooks/useWorkspaceSearch.ts`: places, directory, words,
  recent searches (`STORAGE_KEYS.searchRecent`), chips, input, debounced `q`, sort, `useSearch`. `SearchPage`
  and the header both use it, so there's one copy.
- The header's search state outlives a channel switch ("Ir para" another channel keeps the query): a small
  `HeaderSearchProvider` in `routes/org.$orgId.tsx` (inside `OrgProvider`) holds the hook's state.
- `SearchBox` gets a `variant="header"` (or a `className` and `menuClassName`): 248px field, 320px while focused
  with the raised field and ring, the menu 360px aligned right (`concept.css` "Header" and "The mini menu").
  Placeholder `search.header.placeholder` ("Buscar em {{org}}"). A clear ✕ while it holds something.
- Enter opens the results in the thread panel. Picking a recent search fills the field and searches. Clicking
  the field again with a query, then Enter, reopens the results.
- Phone: the search icon opens a full-screen sheet (`search-sheet`: back button, the field, the menu as a plain
  list). Enter shows the results in the thread panel, which is already full screen under 860px.

### Results in the thread panel (`apps/web/src/components/search/SearchResultsPanel.tsx`)

- ChannelPage's `panel` state becomes a union: `{ kind: "thread", id, reply?, focus? } | { kind: "search" }`.
  One panel at a time. The same scrim, the same `<aside className="thread-panel">`.
- Head (as `ThreadView`'s panel head): search icon, "N resultados" (`search.panel.count`, plural; "100+" at the
  page cap, reusing `searchPage.countMore`), the query under it (`formatSearch`), "Filtros (n)" (focuses the
  header field and opens its menu), the sort `Select` (`SEARCH_SORTS`), close.
- Groups: by channel, and a thread's replies under the thread (icon `thread`, its title, "thread em #canal" on
  the right). Extend `groupByChannel` in `packages/client/src/lib/search-filters.ts` to group by
  `threadId ?? channelId`, or add `groupHitsByPlace`. The right-side category name comes from the channel's
  category. DMs as "Conversa com {name}" (`searchPage.dm`).
- Each hit is a real `Message` (avatar, name, time, `MessageText`) on a raised card, with the matched words
  marked. Add a helper `markTerms(text, terms)` in `packages/client/src/lib/search-filters.ts` that returns
  segments, rendered as `<mark className="search-hit__mark">`. `--search-hit` / `--search-hit-line` are
  `color-mix` of `--info` in `search.css` (light 16% / 60%, dark 22% / 70%), never the mention tan.
- "Ir para" (on hover and on focus, always visible on touch): in this channel's main timeline, close the panel
  and `actions.jumpTo(messageId)` (pages in, `ac-msg--focus` highlight). In a thread, open the thread panel at
  the message (`openThread(threadId, messageId)`). Elsewhere, navigate to the channel or DM with `?m=` (as
  `HitRow` does) and keep the query in the header. Remember the search (`rememberSearch`) on any jump.
- Non-message hits (actions, context items) when no chips: keep them in the panel under their kind headings
  (`groupHits`), as the search page does.
- Server: message hits need the thread's title. In `packages/engine/src/search.ts` `describeHits`, left join
  `threads` on `threads.root_message_id = messages.thread_id` (check which id `messages.thread_id` holds) and add
  `threadTitle: string | null` (the title, else the root message's first line, cut). Add it to the route schema
  and `SearchHit` in `packages/client/src/api/types.ts`. No migration.
- The full search page (`/org/$orgId/search`) stays, for "Mais filtros", the command menu and DMs.

### i18n (slice 2)

`channel.header.threads` (if `threads.popover.button` doesn't read well as an icon label), `channel.header.pins`
("Mensagens fixadas"), `channel.header.showMembers` ("Mostrar membros"), `channel.header.hideMembers` ("Esconder
membros"), `channel.pins.empty` ("Nada fixado aqui ainda"), `search.header.placeholder` ("Buscar em {{org}}"),
`search.header.clear` ("Limpar busca"), `search.header.open` ("Buscar"), `search.panel.label` ("Resultados da
busca"), `search.panel.count` ("{{count}} resultado" / "{{count}} resultados"), `search.panel.filters`
("Filtros"), `search.panel.jump` ("Ir para"), `search.panel.jumpLabel` ("Ir para a mensagem"),
`search.panel.threadIn` ("thread em #{{channel}}"). Reuse `searchPage.*` for the filter names, recent searches,
sort and empty states.

### Tests (slice 2)

- New `apps/web/test/channel-header.test.tsx`: four icon buttons in order with their labels, no avatar stack, no
  "Detalhes do canal", the cog opens the channel details dialog, the pin icon lists pins, threads shows its count,
  the title's right-click menu still opens.
- New `apps/web/test/header-search.test.tsx`: focus shows filters and recent searches, typing `de:` lists people
  and agents, Enter opens the panel with groups by channel and thread, "Ir para" in the same channel closes the
  panel and highlights the message, in another channel navigates with `?m=`, the query survives and Enter
  reopens.
- `packages/client/test/search-filters-lib.test.ts`: grouping by thread, `markTerms` (accents, case, several
  words, no match).
- `packages/engine/test/search.test.ts`: `threadTitle` on a reply hit, null on a timeline hit.
- `apps/web/test/header-css.test.ts`: `.channel__icon` has no background on hover, active or pressed, the acts gap
  is 14px.
- Update the tests that use the old header: `channel.test.tsx`, `channel-members.test.tsx`, `round.test.tsx`,
  `member-invites.test.tsx`, `channel-audience.test.tsx`, `search-filters.test.tsx` (SearchPage on the shared
  hook).

### Visual check (slice 2)

Against `channel-*`, `search-*`, `search-from-*`, `results-*`, `jumped-*`, `thread-*` and `phone-search-*`,
`phone-results-*`.

---

## Slice 3: members column

### Column (`apps/web/src/components/members/MembersColumn.tsx` + `members.css`)

- Rendered by ChannelPage after the main `<Tag>` inside `.shell__pages` (a flex row), so it sits on the right:
  264px, `--side` background, inset hairline on the left, its own scroll. Thread, search, agent and consultation
  panels float over it (they're absolute), and closing them shows it again.
- Only on a channel's own page (not DMs, not a thread inside the panel, not the skeleton).
- Open by default on desktop (≥1200px). Closed by default at 761–1199px (the sidebar is a rail there), where the
  toggle opens it inline. The header toggle remembers it per person and workspace:
  `STORAGE_KEYS.membersColumn` (`agentes.members.column.<userId>.<orgId>`, "0" / "1") through `storage`
  (try/catch is in `lib/storage.ts`).
- Rows: move `PersonRow` / `AgentRow` from `ChannelMembers.tsx` and restyle them (`concept.css` "Right sidebar"):
  32px face with its presence badge, name 14.5px 600, the line under it wrapping to two lines, offline rows at
  45% opacity. People: their status line (`StatusLine`), else nothing. Agents: what they're doing live
  (`agentStateIn` + `useAgentPresence` line, as today), the working trail (`sidebar__trail`, `data-busy`) while
  busy. Keep "você" on your own row and the auto-reply / coordinator chip on agents. The owner's row gets the
  `crown` icon (`--warn`, title `members.column.ownerTitle`).
- Each row is a `ProfileTrigger` that opens the card to the left (`side="left"`). The open row keeps its plate
  (`data-open`). The card itself is slice 4.
- ↑/↓ between rows, as the popover did.

### Grouping (`packages/client/src/lib/member-groups.ts`, pure, tested)

`memberGroups({ people, agents, roles, presenceOf, ownerIds })` returns
`{ key, label, mark?, rows }[]` in this order:

1. Dono: people with `role === "owner"` who are online (mark: violet `audienceOwner`, as Settings › Papéis draws it).
2. Each hoisted role (`hoist`, not `everyone`) in `position` order: online people whose highest hoisted role it
   is. A person shows once.
3. Agentes: the channel's agents, busy first, then by name. Agents hold no roles.
4. Online: online, away and busy people not listed above.
5. Offline: everyone else (a hidden person reads offline, ADR 0084), by name.

Empty groups don't show. Headers read "NAME · N" (`members.column.group`), with the role's mark (16px circle)
when it has one. Data is already on the client: `channelPeople` / `channelAgents` in ChannelPage,
`Member.roleIds`, `useRoles` (any member may read it: `listRoles` needs only `read`), `usePersonPresence`. No
new endpoint.

Large channels: render every row. Cap Offline at 100 with "Mostrar mais N" (`members.column.more`). A
`ponytail:` comment names the ceiling (virtualize if a channel gets thousands of members).

### Phone sheet

At ≤760px the column never shows. The members icon opens `members-sheet`: from the right, 86% wide, `--side`, a
scrim, radius on the left corners. Head: `#name`, then the threads, pins and cog buttons from slice 2 (so they stay
reachable on a phone), then close. A "Buscar pessoas e agentes" field filters the rows by name and handle. Then the
same grouped list. Swipe right or the scrim closes it (reuse the drawer touch handling in `NavDrawer.tsx`).

### Roles: color and hoist (`apps/web/src/components/roles/RolesSection.tsx`)

- Color: already stored (`org_roles.color`) and editable (the "Cor" radiogroup over `data.colors`). Nothing to add.
- Hoist: stored and accepted by the API (`PATCH …/roles/{id}` takes `hoist`), but no UI sets it. Add a `Switch`
  row under the color, "Mostrar separado na lista de membros" (`rolesPage.hoist`) with its description
  (`rolesPage.hoistDesc`: "Quem tem este papel aparece num grupo próprio na coluna de membros"), for editable
  custom roles. Not for `everyone`.
- Built-in Admin hoisted: `packages/engine/src/roles.ts` creates the new workspace's "Admin" with `hoist: true`.
  A custom migration (`admin_hoist`) sets `hoist = true` on each existing built-in Admin (`kind = 'custom'`,
  `name = 'Admin'`, `'administrator' = any(permissions)`). No UI ever set hoist, so this changes no one's choice.
  Mention it in `docs/backend-progress.md`.

### i18n (slice 3)

`members.column.label` ("Membros de #{{channel}}"), `members.column.group` ("{{name}} · {{count}}"),
`members.column.owner` ("Dono", or reuse `roles.owner`), `members.column.ownerTitle` ("Dono do workspace"),
`members.column.more` ("Mostrar mais {{count}}"), `members.column.find` ("Buscar pessoas e agentes"),
`rolesPage.hoist`, `rolesPage.hoistDesc`. Reuse `presence.online` / `presence.offline` for the group names and
`channel.membersAgents` for Agentes.

### Tests (slice 3)

- `packages/client/test/member-groups-lib.test.ts`: owner first, hoisted roles in position order, the highest
  hoisted role wins, offline people only under Offline, hidden reads offline, agents apart, empty groups dropped.
- `apps/web/test/members-column.test.tsx`: open by default on desktop, the toggle closes it and the choice survives
  a remount for that person, a row opens the profile card, a busy agent shows its live line, not shown in a DM.
- `apps/web/test/members-css.test.ts`: column width, offline opacity, group header mark is a circle.
- `apps/web/test/workspace-pages.test.tsx` (or the roles test that covers Settings › Papéis): the hoist switch
  patches `hoist`.
- `packages/engine/test/roles.test.ts`: a new workspace's Admin is hoisted.

### Visual check (slice 3)

Against `channel-*` (x 1176 to 1440) and `phone-members-*`.

---

## Slice 4: member card

### Card (`apps/web/src/components/ProfileCard.tsx`, new `profile-card.css` rules from `concept.css` "Member card")

The card opens everywhere `ProfileTrigger` is used (messages, mentions, the members column). One card, Discord's
shape: 340px, a 96px banner (the person's or the agent's sky, `Sky.tsx`), the 80px face on a `--raised` ring over
the banner's edge, the ⋯ button top right, then the body.

Person (`PersonCard`):

- Name 19px, `@handle` under it.
- Status well (`--sunken`): their line and when it clears, as today.
- "Papéis": each held role (`rolesOf`) as a `Token` with its circle `RoleMark` (18px) as `leading`. An ✕ to remove
  it only when that role is `givable` to the viewer. A `+` that opens `RolesPicker` (only `givable` roles, a check
  on held ones, the `members.everyoneNote` note) when the viewer may give any role. Changes go through
  `useSetMemberRoles` (optimistic, it exists). No roles and nothing to give: the section hides. The owner shows
  "Dono" as a plain chip with its mark, not removable.
- `RolesPicker` gets `side` and `align` props (pass-through to `Menu`) and opens to the right of the card
  (`side="right"`).
- Facts: Hora local (as today), No workspace desde (`joinedAt`, month and year, `profile.memberSince`). Keep the
  presence fact ("Offline · visto há 2 h").
- Message box: "Mensagem para {{name}}" (`profile.messageTo`). Enter opens the DM and sends the text: resolve the
  DM channel the way `DmPage.tsx` does (its `useQuery` on the DM), send with `usePostMessage`, then navigate to
  `/org/$orgId/dm/person/$userId`. Hidden on your own card.

Agent (`AgentCardBody`):

- Name, "@handle · Agente" (or its role line), `NoAiChip`, `CoordinatorChip`, as today.
- Live activity well: its line (`agentLine`), and under it "agora, em #canal" (`profile.nowIn`) when the stream
  store knows the channel it's working in, else today's `presence.bySelf` / `byAuto`.
- "Quem pode falar" (`profile.audience`, exists), for who sees its details: plain lines, no pills.
  `everyone`: one line with the `everyone` mark and "Todos do workspace". `owner`: the owner's face and name.
  `people`: each role (circle mark, then name), then each person (18px face, then name). Under it, "{{name}}
  sempre pode, como responsável." (`profile.ownerAlways`). Add a helper `audienceLines(agent, roles, members)` in
  `packages/client/src/lib/audience.ts` next to `audienceNames`.
- "Editar" (`profile.audienceEdit`, a quiet text button right of the label) only when
  `canEditAudience(org, agent, me.user.id)`. It opens a popover with `AudienceChoice compact` and Salvar, saving
  through the same path as the agent's Settings tab (`useUpdateAgent` with `audience`, `audienceValid`, and the
  widening confirm if that tab has one). Reuse, don't fork.
- Facts: Responsável, Modelo (the brain line, as today), the spend meter (`Spend`) for who sees spend.
- `AskAccessButton` when it can't talk to you. The former-agent card stays as it is.
- Message box: "Mensagem para a {{name}}" via `agentGrammar`, only when it can talk to you, sending like the
  person's.

⋯ menu: the button opens the entity menu at its rect (`openContextMenu` with the button's bounding box) with
`useAgentMenu` / `usePersonMenu` entries, so the right click and ⋯ stay one list: Ver perfil completo (the panel in
a conversation), Configurações de {{name}} (`contextMenu.editAgent` for who may edit), Mensagem direta, Copiar link
do perfil, Parar (while working), then a new "Copiar ID" (`contextMenu.copyId`, copies the id with the toast).
The concept's "Silenciar neste canal" and "Tirar do canal" have no backend today (there is no channel member
removal or per-channel agent mute endpoint). Leave them out and name them in the review as the next step.

### i18n (slice 4)

`profile.roles` ("Papéis"), `profile.rolesOf` ("Papéis de {{name}}"), `profile.removeRole` ("Remover
{{role}}"), `profile.memberSince` ("No workspace desde"), `profile.messageTo` ("Mensagem para {{name}}"),
`profile.audienceEdit` ("Editar"), `profile.ownerAlways` ("{{name}} sempre pode, como responsável."),
`profile.nowIn` ("agora, em #{{channel}}"), `profile.more` ("Mais"), `contextMenu.copyId` ("Copiar ID"),
`contextMenu.idCopied` ("ID copiado"). Reuse `audience.summary.everyone` for "Todos do workspace".

### Tests (slice 4)

- New `apps/web/test/member-card.test.tsx`:
  - Person: held roles as chips with circle marks. An owner viewer sees ✕ and +, the picker lists only givable
    roles with checks, toggling calls the set-roles API. A plain member sees chips without ✕ or +.
  - Agent: Quem pode falar lines for everyone, owner and people (roles then people). Editar shows for the owner
    and for who manages agents, not for others. Saving sends the audience.
  - ⋯ opens the same entries as the right click, plus Copiar ID.
  - The message box opens the DM and posts the text.
- `packages/client/test/audience-lib.test.ts` (or the existing audience test): `audienceLines`.
- Update `mentions-profile.test.tsx`, `profile-menu.test.tsx`, `audience.test.tsx` for the new card markup.

### Visual check (slice 4)

Against `profile-person-*` (card plus open picker) and `profile-agent-*` (card plus ⋯ menu).

---

## Keep (today's UI that must survive)

- Channel details content (description, members list with search, add people or agents, archive, audience by
  role, everything `ChannelDetails` shows), now behind the cog. The sidebar's right-click "Editar canal" and its
  row actions still open it (`requestChannelDetails`).
- The title's right-click channel menu. ⌘K "Ir para…". The full search page and the DM header's search button.
- The pinned bar under the header (D2: kept. The header's pin icon opens the same list. Ask the owner whether
  Discord's way, no bar, is wanted).
- The threads popover content and "Ver todas". The arrival card and the channel welcome.
- Members' details from the old popover: "você", status lines, "visto há", the auto-reply and coordinator chips,
  agents' live state and role.
- Profile card: NoAi and coordinator chips, spend meter, AskAccess, former agent, Ver perfil opening the panel,
  the DM button's reach rules (`canTalk`, `seesDetails`).
- Sidebar: drag and drop of channels and categories, closed categories with their unread summary, the icon rail,
  the bell, the account menu, More tools, section order, mute (from the unread branch), DMs and their counts (D1),
  agent groups (D1, moved to the Team page).
- Every existing breakpoint: phone ≤640, compact ≤760 (drawers and sheets), tablet rail 761–1199, desktop ≥1200.

## Risks

- D1 (left sidebar parts) is the largest behavior change. The owner approved it. It is its own commit so it
  reverts cleanly.
- The dark `--pane` / `--side` change repaints every dark screen, and the phone app too through
  `packages/tokens`. Check a few other dark pages (settings, issues, wiki) in the screenshot pass. If the phone
  shouldn't change, keep `packages/tokens` on the old values and add web-only tokens instead. That needs a
  tokens-test exception, so ask first.
- Unread counting threads apart (`thread_reads`) is wrong for any client that never marks a thread read. That's
  why the phone's thread-read change comes along in slice 1. The desktop app runs the web build, so it's covered.
- `channel.activity` relay: one members query per message per replica with sockets (the branch marks it with
  `ponytail:`). Fine at today's scale. Watch it on the box.
- Migration numbers (0183 unread, 0184 admin hoist) will collide with other branches. They get renumbered at
  integration. The backfill SQL in the unread migration is hand-added, so keep it at the end of the generated
  file.
- ChannelPage's `panel` state turning into a union touches every `setPanel` call (threads from messages, pins,
  the threads popover, push opens). Grep them all.
- Search state lives above the router outlet. A workspace switch must reset it (key the provider by org id).
- Members column and the floating panels: the panels must stay above the column (z-index 30) and the column must
  not shrink the chat below its min width at 1200px (sidebar 264 + column 264 leaves 672). At tablet widths the
  column starts closed.
- Many existing screen tests assert the old header and sidebar. Update them in the slice that changes the
  markup, not later.
- The ⋯ menu leaves out "Silenciar neste canal" and "Tirar do canal" (no backend). Say so in the review, don't
  fake them.
- Public repo: no customer names, emails or repos in fixtures, commits or this plan. Fixture names stay the
  concept's fictional ones (Ada, Theo, Caio…).
- Self-host parity: everything here is core (no Cloud-only code), so self-hosters get it as is.
