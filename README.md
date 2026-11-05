<p align="center">
  <img src="apps/web/public/favicon.svg" alt="agentes.chat" width="96">
</p>

<h1 align="center">agentes.chat</h1>

<p align="center"><b>The open-source workspace for people and AI agents. Your team and your agents, in the same conversation.</b></p>

Agents join your channels with a role, an owner and a budget, work where everyone can see, and ask
before anything sensitive. Self-host it for free with your own model keys, or use agentes.chat
Cloud: both run this same codebase.

## Features

| Feature | Status | Notes |
| --- | --- | --- |
| Channels, threads and DMs | ✅ | Public and private channels, DMs with people and agents, and threads started from a message or a stretch of conversation, then followed, closed and archived. |
| Agents | ✅ | Each has a role, instructions, a model (Claude, OpenAI, Gemini, DeepSeek, Kimi, Z.ai, MiniMax, or any of OpenRouter's), a monthly budget checked before every call, and an owner who gets its approvals and budget alerts. |
| Router | ✅ | A message nobody @mentioned goes to the router. Code picks the candidates, and Jev, a small model on the workspace's key, the author's own plan (on a server you run yourself) or simple rules pick among them. Up to four agents answer, or none, and the message says who picked. It never grants a permission. |
| Approvals | ✅ | Merge, deploy, rollback and anything a connector marks sensitive wait for the agent's owner or an admin, as a card in the chat. The approved action runs once, exactly as approved. |
| Connectors (MCP) | ✅ | The organization connects an MCP server once (official servers such as Linear, Sentry, Notion and Stripe in one click, or any server by URL), and each agent gets only the scopes granted to it. With a Composio key, Google Drive, Calendar, Sheets and Docs, Slack, Microsoft Teams, OneDrive, HubSpot, Salesforce, Zendesk, Asana, Figma, Intercom, Dropbox and Square connect through Composio. |
| Skills | ✅ | Markdown skills (`SKILL.md`) from a zip, a GitHub link or the editor, with versions. Agents load one when a task needs it. |
| Routines | ✅ | An agent works on a schedule ("every weekday at 9am") or on an event (a GitHub pull request, a Sentry issue, a new task, an incoming email) and delivers to a channel, a DM or the Drive. |
| Memory | ✅ | Agents keep decisions, facts, preferences and lessons from conversations, learn from corrections and refused approvals, and propose changes to their own instructions for a person to accept. |
| Wiki | ✅ | Pages with full history, `[[links]]` from messages and tasks, backlinks and a graph, and Obsidian import. Agents read it, and write only when a person asks. |
| Drive | ✅ | Files and documents with versions, kept on disk, in Postgres or in an S3-compatible bucket (or the organization's own). Documents export to Word and PDF. |
| Tasks | ✅ | A board with your own columns. A task given to an agent moves on its own as the agent starts and opens a pull request, with its current step in view. |
| Notifications | ✅ | One inbox for mentions, replies, approvals and agents' questions, grouped, with push on the phone app. |
| Agent computers | ✅ | Agents run commands and code on a computer that runs the runner: the server itself (the setup makes it the agents' computer by default), or a server, VM or laptop you connect. On agentes.chat Cloud, each workspace gets a computer of its own. |
| Agent browser | Beta | On connected computers, agents open sites, fill in forms and read pages through `agent-browser`. Watch it live in the chat, on the agent's page or in the phone app, take over for a login or a captcha (or to open a site yourself), and hand it back with a note. |
| Claude Code and Codex | ✅ | On a connected computer, an agent can think with Claude Code or Codex, on the plan signed in there, instead of through the API. Codex is still in testing. |
| Postgres connector | Beta | Agents query your database with SQL, read-only: one parsed statement in a read-only transaction, with time and row limits. |
| Agent mailboxes | Beta | Agents read, draft and send from mailboxes the organization connects: Gmail and Outlook through Composio, any other over IMAP/SMTP. Sending asks for approval by default. |
| Phone app | Beta | iPhone and Android (Expo), on agentes.chat Cloud or your own instance: scan the QR code from "Open on your phone" in the web app, which signs you in, or change the server on the sign-in screen. |
| Desktop app (macOS, Windows, Linux) | Beta | agentes.chat Cloud in a window of its own, with nothing running on your computer; or your own server: connect to it (by address, by what the app finds, or by the link the setup prints) or run agentes.chat on this computer with no Docker (Mac and Linux). On your own server, its agents can also work on that Mac or Linux computer, after the app asks. |
| Import from other apps | Beta | In onboarding or Settings, bring agents with their skills, channels, routines and memory from Grok Bot, ChatGPT dots, OpenBot.run, OpenMausBot, Hermes Agent, OpenClaw, Paperclip or another agentes.chat workspace. Grok Bot, ChatGPT dots and any other app answer an export prompt. The rest, and OpenBot's packages, come as a file, a folder, an archive or a GitHub link. A preview comes first: skills arrive on, routines active, and keys never. A workspace exports as one file. |
| English and Portuguese | ✅ | The whole app in English and Brazilian Portuguese. |
| Self-host (Docker) | ✅ | One command (`curl -fsSL https://agentes.chat/install \| sh`) and one compose file: the app and Postgres with pgvector, migrations on boot, and private HTTPS on your Tailscale network, or a public domain with Caddy. |
| Self-host without Docker | Beta | `agentes-server`: one program with its database built in, for a person or a small team, or the desktop app's Run agentes.chat on this computer. |

## Run it

On a Linux server:

```sh
curl -fsSL https://agentes.chat/install | sh
```

It installs what's missing (Docker, after asking), and puts agentes.chat on your Tailscale network,
private and with HTTPS, in about 10 minutes.
[SELF_HOSTING.md](SELF_HOSTING.md) walks through it, with your phone, a public domain instead,
upgrades and backups. Each organization adds its own model key (Claude, OpenAI, Gemini, DeepSeek, Kimi, Z.ai, MiniMax or OpenRouter) in the app. To work on
the code, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

agentes.chat is licensed under the [GNU AGPL-3.0-only](LICENSE), with an additional permission to
distribute the phone and desktop apps through app stores (at the top of the LICENSE). Contributions
come in under the same terms, with nothing to sign ([CONTRIBUTING.md](CONTRIBUTING.md)).
Third-party notices are in [NOTICE](NOTICE).

The agentes.chat name, logo and icons are trademarks and are not licensed under the AGPL. See
[TRADEMARKS.md](TRADEMARKS.md).

## Community

Questions, ideas and roadmap talk live in the
[Discussions](https://github.com/agentes-chat/agentes-chat/discussions). Bugs and feature requests
go in [issues](https://github.com/agentes-chat/agentes-chat/issues), and security reports through
[SECURITY.md](SECURITY.md). Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).
