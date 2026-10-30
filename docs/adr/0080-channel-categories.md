# 0080. Channel categories in the sidebar

- Status: Accepted (built: the server, the shared client and the web; the phone app still lists channels without them)
- Date: 2026-10-30
- Code: `packages/engine/src/channel-categories.ts`, `packages/engine/src/channels.ts` (`createChannel`, `listChannels`), `packages/db/src/schema/chat.ts` (`channel_categories`, `channels.category_id`, `channels.position`), `apps/server/src/routes/app/channels.ts`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/ChannelCategoryDialogs.tsx`

## Context

With a dozen channels, one alphabetical "Canais" list mixes every team's channels. People asked to group them the way Discord does: named sections in the sidebar that open and close.

## Decision

1. **The organization's layout.** A category belongs to the organization (`channel_categories`, with `org_id`) and everyone sees the same sidebar. Its name is kept as typed, at most 40 characters, unique per organization ignoring case (the engine checks the case; the table's unique key is the name as typed). Opening and closing a category is each person's own, in their browser, like the sidebar's other sections.
2. **Who arranges it.** Admins (`configure`) create, rename, reorder and delete categories. Whoever may change a channel (its creator or an admin, as for renaming it) puts it in a category or moves it. Whoever creates a channel may put it in an existing category as they create it.
3. **Order.** `channel_categories.position` orders the categories; `channels.position` orders the channels inside theirs, then by name. Channels with no category (`category_id` null) come first, with no header. Moves renumber the whole category in one transaction (`placeChannel`, `placeChannelCategory`). A group nobody arranged by hand has every position at 0 and reads by name, so a new channel joins it at 0 and the list stays alphabetical, as before categories; once arranged, a new channel goes to its end.
4. **Deleting a category** moves its channels to the end of the ones with none, in their order. Archiving a channel leaves its place as it is.
5. **Live.** Every change sends an org broadcast `channels.layout` with no names in it (private channels stay private); clients refetch the channel list and the categories.
6. **The sidebar.** A category is a section like Agentes: same header, chevron and a + to create a channel in it. Closed, it still shows the open channel and the unread ones. Channels move from their right-click menu ("Mover para…"), the channel details (Categoria) or by dragging.
