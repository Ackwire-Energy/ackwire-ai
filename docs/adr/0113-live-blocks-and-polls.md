# 0113. Live blocks and polls: what an agent shows to be used, not kept

- Status: Accepted
- Date: 2026-11-01
- Code: `packages/engine/src/blocks.ts` (`show_block`, `start_poll`, `votePoll`, `closePoll`, `replyToBlock`, `BLOCK_MANUAL`), `packages/engine/src/block-state.ts` (`setBlockState`, `drawBlock`, `blockStateNotes`), `packages/db/src/schema/storage.ts` (`artifacts.in_drive`, `polls`, `poll_votes`, `block_states`), `packages/client/src/api/queries.ts` (`useSharedBlock`), `packages/client/src/lib/block-kit.ts` (the kit), `packages/client/src/lib/blocks.ts` (the page, what a frame may say), `packages/client/src/lib/isolated-page.ts`, web `apps/web/src/components/blocks/*`, phone `apps/mobile/src/features/blocks/*`

## Context

An agent can answer with text, a table, a chart or a file. A file is the wrong shape for "what if I move 20 thousand to Google?": it goes to the Drive, opens elsewhere and goes one way. People asking that want to move something, see the result and go on talking. ADR 0019 already lets an agent save a page, and a page already shows as a card in the message, but it stays a document to open.

Two questions decide the design: how something an agent wrote can run in the conversation without being able to do harm, and how it can look like part of the app without the agent spending thousands of tokens on CSS.

## Decision

**A file is for keeping; a block is for using now.** A block lives in its message, not in the Drive, unless a person keeps it. It is one subject and fits the conversation. It wears the app's theme, font and controls. It goes both ways: what the person picks reaches the agent.

**The agent decides, with no permission to ask for.** `show_block` and `start_poll` have no scope, like `react` and `ask_user`, and need no approval: they speak only in the agent's own conversation (`HERE` in `tools/run-policy.ts`, so never in a routine's room) and a block can reach nothing. A real action that follows still goes through its approval.

**A block is short HTML over a kit.** Every frame gets our kit before the agent's code: sliders, choices, fields, stats, charts in the chart style of messages, tables, and a small state (`agentes.compute`, `when=`). The agent writes a line per control and no CSS, so the blocks we measured are 1 to 2.5 KB. The same code runs on the web and in the phone's web view. When the kit doesn't reach, the agent writes plain HTML and canvas in the same frame. The manual (`BLOCK_MANUAL`) is the tool's description, because a model needs it exactly when it uses the tool. A cheap model given only that manual wrote three new blocks that opened with no error and no edit.

**A block looks like the app, not like a page.** What an agent writes by hand drifts: colors that break in the other theme, tinted boxes, a native select. So the kit carries the design language in three layers. Plain HTML wears the app's look at no CSS weight, which an agent's own CSS always beats and blocks already sent get too. Parts cover what agents kept inventing (`ac-card`, `ac-result`, `ac-actions`). The agent's six tones are `--s1` to `--s6`, set for each theme. The manual says to build from these and never to write a color, and a test keeps the tokens the kit shares with the app equal to the app's. Nothing refuses a block that ignores this: the frame is safe either way, and looks aren't worth a failed reply.

**Stored as an artifact, kept out of the Drive.** Kinds `block` and `poll`, `in_drive = false`. That reuses channel visibility, versions, `meta.artifacts` on the reply, events and trash. Being out of the Drive also keeps them out of `listArtifacts` and search. The message only points at the block, so its code doesn't weigh on the conversation's history. "Guardar no Drive" sets the flag and indexes it.

**It runs isolated, on every surface.**
- Web: a sandboxed frame with an opaque origin, the policy of ADR 0019 in a fixed prefix, and `frame-src` on our pages.
- Phone: the web view is the sandbox. MCP Apps requires a nested proxy frame only of hosts that are web pages, and hosts on React Native map the rules onto web view props. Ours has no cookies, storage or file access, opens no windows, and refuses every navigation in `onShouldStartLoadWithRequest` with `originWhitelist` open: an address refused by that list would be handed to the system to open, which is itself a way out.
- It doesn't scroll by itself in the list (`scrollEnabled` and `nestedScrollEnabled` off): on Android a web view that takes a drag never gives it back to the list. Its height comes from the page. On its own pushed screen it scrolls.
- No DNS prefetch (`x-dns-prefetch-control` before the policy): a lookup of a name the page made up would leave where the policy doesn't reach.
- What people set is data everywhere it goes: the kit writes it as text, the apps read a frame's messages through `blockEvent`, and the agent reads it inside `untrustedBlock`, with the names people chose. The manual tells agents to write values with `textContent`: a page that used `innerHTML` would run someone else's text, though only inside its own frame.
- A value that looks like a key or a password (`redactCommon`) is refused, because everyone would see it; the manual sends those to `request_secret`.
- At most three frames run at once on the phone (`withLiveBlock`), and a frame the system ended comes back with what the person had set.

**One block for everyone.** A block in a conversation is one thing that everyone in it looks at, like a whiteboard, not a copy each. What a person sets in it (a slider, a field, a pick) goes to the server (`block_states`, one state per version of the block) and reaches everyone looking at once (`block.state`, the newest `rev` wins); whoever opens it later starts from there. Only what the person touched is shared: the kit marks the state `used` after a pointer, a key or an input in the page, so what a page sets as it opens stays in that page. A random pick is the server's (`agentes.draw`): a page drawing with its own random numbers gave each person a different winner. The server draws once among the options, uniformly from the system's random source, and records who asked.

**The agent sees what people see.** The state of each block a message showed is read by the agents right after that message, as outside data (`untrustedBlock`), with who set each value and which ones the server drew. Nothing is sent to the agent and no run starts: the next time it reads the conversation, the block is as people left it. So "it came out Bento, go on" works without anyone pressing a button in the block.

**The page proposes, the person sends.** `<ac-send>` makes the page state what it would send; the app shows that text and the button outside the frame, where the page can't reach. A text that changed in the last 400 ms doesn't take a click, so a page can't swap it under the pointer. What goes is a normal message of the person's, addressed to the agent that made the block.

**A vote is the app's own card.** Inside a frame, a page could cast a vote for whoever opened it. A vote is an act of the person's, so `poll` is drawn by the apps. `start_poll` closes at the agent's time (24 hours by default, 7 days at most) or when everyone in the conversation has voted, and the agent hears the result as a `poll_result` notice.

## Consequences

- A number in a block comes from a formula the model wrote and can be wrong. The manual asks for it to be shown and called an estimate.
- A block is a snapshot of the data it was written with. Newer data means the agent shows it again (`block_id`).
- What anyone sets in a block is stored and seen by everyone in the conversation, as a message is. A block is no place for something private; passwords and keys go through `request_secret`, as before.
- Two people moving the same control at once each see the other's value arrive: the last one in stays.
- A block made before this kept results in the page alone. Those still differ per person until the agent shows them again.
- On the phone, a fourth block on screen shows "Tocar para abrir" until tapped.
- The manual is about 2.5 KB in every run's tool list; it sits in the cached part of the prompt.
- `webrtc 'block'` is in the policy, but browsers that don't know that directive ignore it. There, a page could still leak a little through a lookup to a STUN or TURN server of its choosing; closing that needs a block at the browser level, which no web page can set.

## Alternatives considered

- **A ```html block in the message.** It streams half-written code, puts the page in the message text and in the history of every later run, and gives it no versions or visibility of its own.
- **Only declarative blocks, drawn natively.** Safest and lightest, but every part is built twice and anything new waits for a release. The kit gives the same look and code, and the frame leaves room for what no part covers.
- **The Drive card with a bigger preview.** That keeps a document in a frame: no answer comes back, and it doesn't look like the app.
- **A nested proxy frame on the phone.** The spec doesn't ask it of native hosts, and it would add a layer between the frame and the list for no isolation the web view doesn't give.
