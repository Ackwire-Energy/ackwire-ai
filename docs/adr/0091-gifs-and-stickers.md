# 0091. GIFs and stickers in chat, and agents that send them

- Status: Proposed (built on the server and the web; the phone app shows them still and has no picker yet)
- Date: 2026-10-31
- Code: `packages/engine/src/media.ts`, `packages/engine/src/agent-media.ts`, `packages/adapters/src/gifs.ts`, `apps/server/src/routes/app/gifs.ts`, `packages/ui` (`AgentSticker`, the composer's picker), `packages/client/src/lib/media.ts`

## Context

People wanted to answer with a GIF, and agents had no light way to show they were glad, grateful or done: only text and emoji reactions (`react`). Two questions came with it: where GIFs come from without breaking the rule that a self-hosted server needs only Postgres, and how an agent decides to send one without making every reply's prompt longer or leaving it to each model's taste.

## Decision

### 1. One picker, three tabs

- The composer's emoji button opens one picker: Emojis (unchanged), GIFs and Stickers. One click sends. The reaction picker stays emoji-only.
- A message may have media and no text. `messages.meta.media` is `{ kind: "gif", provider: "giphy", id, title, width, height }` or `{ kind: "sticker", agentId, mood }` (`mediaOf`). A GIF is stored without a URL.
- A GIF or a sticker alone is like a reaction: it routes to nobody, starts no run, doesn't reach a run in progress (nor answers its question) and reopens no thread; agents read it in the conversation later.
- `POST …/channels/{channelId}/messages` takes `media: { kind: "gif", id } | { kind: "sticker", agentId, mood }`. The server looks a GIF up again (`gifs.get` at the workspace's rating) and stores what the provider says, never what the app sent; a sticker's agent must be the workspace's.

### 2. GIFs are optional and go through the server

- GIF search is an adapter (`GifProvider`), GIPHY when `GIPHY_API_KEY` is set. Without it the GIFs tab doesn't show and nothing else changes.
- `GET /api/app/organizations/{orgId}/gifs` searches (free text, a category, or trending) at the workspace's rating, members only, rate-limited per person. `GET …/gifs/{gifId}/media?size=preview|full|still` sends the file: browsers and the phone app load every GIF from our server, so a viewer's address never reaches the provider, and the key never leaves the server.
- Categories are a closed list (`GIF_CATEGORIES`: celebrate, thanks, ok, applause, wow, coffee, good morning, bye, friday, oops, thinking), each searched with its own English query. The picker shows them as chips; agents pick among them (§4).
- The picker credits the provider, as its terms ask.

### 3. Stickers are the agents' own

- Every agent has six stickers, one per mood (`STICKER_MOODS`: celebrate, love, deal, thinking, wow, dizzy), drawn by each app from the agent's look with the agent engine (`packages/ui/src/agent/engine.js`). Nothing is uploaded or stored but the agent and the mood, a new agent has its stickers at once, and a changed look changes them.
- They animate while on screen, and stand still with reduced motion.

### 4. Agents send them in a second step, not in their prompt

- The agent's prompt and tools don't change. After an agent's reply is posted, a job (`agent-media.ts`) decides whether to follow it with a sticker or a GIF.
- Code decides first, for free: the workspace's level is not `never`, the agent's own switch is on, the reply is the final answer of a run a person started (not a routine, a background run, another agent, a mission card, an approval, a fast reply or an email), in a chat channel or a person's DM, short and with no code, table or chart; no agent media in the conversation's last 8 messages, none from this agent in the channel in the last 15 minutes, and nothing newer in the conversation.
- Then one judgment by Jev (`judge.ts`, `calibrated`): a `noul` on whether a light visual reaction fits right after this reply among teammates, a `choice` of mood, and a `choice` of GIF category when a GIF may go. The level sets the threshold (`sometimes` 0.8, `often` 0.6, tuned by `bun run eval:media`). Without a Jev key nothing is sent: a calibrated probability is what the level means, and a cosmetic touch isn't worth the workspace's own model on every reply.
- A GIF goes only where people already send GIFs (a person's GIF in the conversation lately); otherwise the agent's own sticker. Jev picks a category, never a search: it doesn't write text.
- The sticker or GIF is a message of its own from the same agent, right after the reply, with `meta.mediaAfter` (the reply's id). It is silent: it starts no run, routes to nobody and notifies nobody.

### 5. Settings

- Workspace (admins): GIFs on or off, their rating (`g` for any age, the default, or `pg`), the agents' stickers on or off, and how often agents send (`never`, `sometimes`, the default, or `often`): `organization_settings.gifs`, `gif_rating`, `agent_stickers`, `agent_media`. Per agent: `agents.media_replies`.
- The settings say what the server can't do (no GIF provider, no Jev key) instead of offering switches that do nothing.

### 6. What the agents read

- In an agent's context a GIF is a short line with its title as outside text (`untrustedBlock`), and a sticker is the agent and the mood, so agents understand what was sent and what they sent.

## Consequences

- A self-hosted server without the two keys still has stickers for people; agents send nothing on their own.
- GIF files cost the server's bandwidth; browsers keep them (`immutable`), and the media route checks membership.
- The phone app shows GIFs and stickers (stickers still) and has no picker yet; animated stickers there need the engine on Skia.
- Uploading the workspace's own stickers is left for later.
