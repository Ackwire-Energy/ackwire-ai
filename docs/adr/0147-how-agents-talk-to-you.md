# 0147. How agents talk to you: simple by default, technical by choice

- Status: Accepted (built)
- Date: 2026-11-04
- Extends: ADR 0053 (who is behind a run), ADR 0122 (fourteen languages), ADR 0137 (the right hand's greeting cards)
- Code: db `packages/db/src/schema/tenancy.ts` (`organization_members.agent_style`, migration `0217_agent_style.sql`); engine `agent-style.ts` (`AGENT_STYLES`, `agentStyleOf`, `saveAgentStyle`, `TECHNICAL_STYLE_LINE`, `set_reply_style`), `context.ts` (`PLAIN_WORDS_LINE`, `personNotes`), `organizations.ts` (`setAgentStyle`, `Membership.agentStyle`), `tools/directory.ts` (`RARE_TOOLS`), `tools/run-policy.ts`; server `routes/app/management.ts` (`PUT …/me/agent-style`), `routes/app/account.ts` (`agentStyle` in `GET /me`), `engine.ts`; client `api/queries.ts` (`useSetAgentStyle`), `lib/right-hand.ts` (`introCards` `style`), `lib/markdown.ts` (`detailsAt`); web `components/AccountSettings.tsx`, `RightHandIntro.tsx` (`StyleCard`), `lib/markdown.tsx`, `layout.css` (`.md__details`); phone `features/me/PreferencePages.tsx` (`AgentStylePage`), `MeScreen.tsx`, `app/(app)/me/agent-style.tsx`, `features/right-hand/Intro.tsx`, `features/chat/logic.ts` (`parseBlocks`), `MessageText.tsx` (`Details`)

## Context

People who don't code read agents' replies as a wall: a request for the GitHub app's access to one repository came as three paragraphs of folder names, commit hashes, file paths, HTTP codes and JSON keys. A person said that at a glance they thought about not reading at all and approving every button that appeared. That is the opposite of what approvals are for.

The prompt already said not to name tools, and to write like a colleague texting. Nothing said to lead with what the person must do, nor kept paths and codes out, and a technical person had no way to ask for the details.

## Decision

### 1. One choice per person and workspace, Simples until changed

`organization_members.agent_style`: `simple`, `technical`, or null (never picked). Null reads as simple. Per workspace like `show_activity` and `timezone`: a developer may want details at work and not in a side project. It is set in Sua conta (web Settings, phone Você), by the right hand's question, or by asking any agent.

### 2. Simple is the rule every agent reads; technical is a line in the turn

The simple rules sit in "# How to reply" (`PLAIN_WORDS_LINE`), for everyone: lead with what happened and what the person must do, in one or two short everyday sentences; no tool names, paths, hashes, codes, JSON keys or internal names unless the person must type or click them or is clearly technical; a step of theirs is a short numbered list of what to click; more only when asked, or last in a collapsed block.

A person who chose technical gets `TECHNICAL_STYLE_LINE` among the per-turn blocks: paths, codes, ids and tool names are welcome, details may go in the text, and what goes with an approval or a card stays plain.

Why the default in the system text and not in the turn: the system text is cached and shared by every agent of the workspace, the turn is paid again on every call. Most people get the default, so it costs nothing per turn, and a DM "oi" stays under its ceiling.

### 3. Whose style

The person behind the run (ADR 0053): the trigger's author for a DM or channel message, and for a routine's brief (written as its creator). With no author (another agent's mention), `runAuthority` finds the person, else the routine's creator (`wikiPersonOf`). The agents' DM gets no line: no person reads it, and the asking agent words the answer for its own person. For a message a person wrote, the style is read in the same statement as the app language, so a run reads nothing more before the model call.

### 4. Asking once, and changing it by saying so

Under the right hand's greeting, once an AI is connected and while the person never picked, a card asks "Como prefere que eu fale com você?" with two answers. A tap saves it and the card goes, on every device. It is drawn by the app (ADR 0137 §6), so it costs no model call.

`set_reply_style` lets any agent save it when the person asks ("fala mais simples", "pode ser técnico"). It acts only for the person behind the run (`personBehindCall`) and refuses when nobody is. It loads on demand with the conversation's rarer tools, so it adds nothing to every prompt but a word in that group's label.

### 5. Collapsed details in Markdown

Agents write `<details><summary>Details</summary> … </details>` (the label in the reply's language), the HTML every model knows. The shared parser (`detailsAt`) reads it as a block whose body is Markdown of its own, on one line or many, `</details>` ending its last line (a nested block or one inside fenced code doesn't close it; unclosed while streaming, it runs to the end). The web draws a native `<details>`, the phone a row that opens on tap. Every other HTML stays text. The wiki editor's parse leaves it off, so a page keeps its source as written.

### 6. Cards

Approval and action cards keep their own app-written text. What the agent writes with them follows the same rule in both modes (`TECHNICAL_STYLE_LINE` says so).

## Consequences

- Replies to most people get shorter, with the action first; the details are one tap away.
- A technical person's turns cost about 170 characters more.
- The plain-words rule is now longer for everyone (about 90 characters more in a DM "oi").

## Addendum (2026-11-14): replies that name tools or cite the agent's own files are written again

The plain-words rule already says not to name tools or paths, but nothing checked replies. Agents still asked people to "send it by `request_secret`", a tool the person can't see or use, and said "saved in `notas/precos.md`", a file on the agent's own computer that nobody else can open. The turn-end controller (ADR 0097) now has two cheap rules for conversation replies. Both are a regex over the reply and need no model call of their own. They come last: only a reply every other rule (and the judge, when one is asked) would post is held for its wording, so a reply held as a secret asked in the chat or as an unbacked claim is held by that rule and never for its wording. A held turn costs the judgment it would have had anyway plus the rewrite turn (one model call and, when asked, its judgment); a reply that trips neither rule costs nothing more:

1. **Tool names** (`toolsNamed`, rule `tool_names`): a reply that names one of the run's own tools is not posted. Only names with an underscore count, bare, in backticks or behind `mcp__agentes__`, and only in prose: a name in a code block, in inline code that holds more than the name (`client.send_email(to)`), in a web address or an address's path (`/api/create_issue`), as a file's name (`send_email.py`), or used in the reply's own code is code. The run writes the reply again once, in plain words (`toolNamesNudge`).
2. **Local paths** (`localPathsCited`, rule `local_paths`, checked before tool names): on the model brain, in a run whose agent has `upload_file` and no git tools, a reply that cites a path on its computer (`notas/precos.md`, `notas/`, `~/out/`, `/home/agent/x.csv`) is not posted. A path counts only when the run's computer tools worked on it in this run, as a whole name (`precos.md` is not `precos.md.bak`), and did not already share it (`computerWork`, read only when the reply has a candidate path), so a path in a cloud drive, a wiki or the person's own computer is left alone. The run is told how to share instead: `upload_file`, `export_file`, the content in the message, or a wiki page linked as `[[Title]]`. These never count as paths: web and mail addresses with or without a scheme (`Gmail/Outlook.com`, `localhost:3000/api`), channel names (`#vendas/#suporte`), wiki links, code blocks, pairs, ratios and units (`e/ou`, `24/7`, `km/h`), dates and versions (`HTTP/1.1`). A reply that names a source file outside a home folder (`src/login.ts`) is code talk, all of it. The rule is also skipped when the person's message writes a path (a file, a folder, a path from the root or a source file; a date or a pair like `01/11` is none) or code, or names the cited file, when the computer the run works on is the person's own connected computer, since they can open the path (a server's own computer, connected by its owner, is nobody's), and on a coding CLI brain, whose own shell the transcript doesn't show.

Neither rule applies in an agents' DM, in a repository's or a mission's work, for a person who chose technical replies, or to a reply held earlier (`held`): only this turn's own words are read.

Each rule holds a reply at most once per run (`toolsNudged`, `pathsNudged`). It does not count against the other nudges, keeps a question the run was told to ask, and never applies at the turn cap. A rewrite that still names a tool or cites a path is posted as written. Like the secret and unbacked holds, a held reply moves `postedUpTo` past itself, so its text is never picked up again as working text. Held only for its wording, it is still an answer (`heldWording`): wherever the run ends before its next words, that reply is posted instead of nothing or a server's line: a rewrite that writes nothing, only calls a tool or only repeats its emoji reaction, a pass, a failure, the step limit, Stop and "stop and send" (in what the stopped run wrote), and the restart sweep (over any working text written since). A run that parks (a usage or budget wait, an outage, its computer) keeps the held reply on its saved transcript: the rewrite goes on when it resumes, and a person who stops it while parked gets the held reply (just before their message on "stop and send"). The held reply is kept as the run would publish it, credentials masked and the right hand's sign-ins scrubbed, so a fallback outside the run posts nothing unsafe; scrubbing twice changes nothing. A rewrite that is posted replaces it, and anything posted clears it. A later reply held as a secret or an unbacked claim leaves it standing and is itself never posted. A pause card (an approval, a question, a secret) is the run's next step and drops it; a line written next to one is not checked. The fast reply (`talker.ts`) gets the same tool-name rule in its prompt. The main prompt is unchanged.

## Addendum (2026-11-15): a pass leaves no words on its step line

Words an agent writes before a tool call show on that step's status line (`agent.tool`'s `said`). Before a `pass` they were words the agent then chose not to post, so they showed for a moment and vanished with no message. `invokeWithChip` now drops them for `pass` alone, on the model brain and on computer brains alike; every other tool keeps them.
