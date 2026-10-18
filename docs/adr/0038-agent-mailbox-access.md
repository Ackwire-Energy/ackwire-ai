# 0038. Agents use people's mailboxes: Composio for Gmail/Outlook, our IMAP/SMTP connector for the rest

- Status: Proposed
- Date: 2026-10-18
- Planning: none yet (D53 lists the security prerequisites)
- Extends: ADR 0015 (Tool Gateway and approvals), ADR 0016 (connectors), ADR 0007 (credentials)
- Out of scope: an address of the agent's own (`ana@org.agentes.chat`), which gets its own ADR

## Context

People want agents to read, triage and answer their email. We studied two open-source products that do this:

- **OpenBot (CopilotKit):**
  - Gmail and Outlook go only through Composio. Composio holds the OAuth and exposes actions such as `GMAIL_FETCH_EMAILS` and `GMAIL_SEND_EMAIL`.
  - An admin grants actions to each bot, one by one. An app is Personal (acts as the asker) or Shared (one team account).
  - Drive, Notion and web search are its own reviewed connectors.
  - Inbound mail reaches a bot only through a receive-only `trigger-<id>@domain` address (SES).
- **OpenMausBot:**
  - Every external app goes through Composio, behind a Cloudflare broker that keeps the project key out of the desktop build.
  - Each bot has three layers of access: on/off, an exact tool list per service, and read or write per app. The read/write split comes from the action's verb.
  - Every send asks "Send on your behalf?" by default; an alternative is allow with a cap of 25 per day.
  - A new email wakes a bot through Composio triggers. The Gmail filter becomes a Gmail search, and the payload is wrapped as untrusted.

Neither has an IMAP client, and neither gives the bot its own sending address. Both keep permissions and approvals on their side; Composio only executes.

### Constraints

- **Google's restricted scopes:** reading Gmail (`gmail.readonly`, `gmail.modify`) requires app verification and a yearly CASA security assessment for whoever owns the OAuth app. With Composio's managed app, that is Composio. Sending only (`gmail.send`) is a lighter, sensitive scope.
- **Apple:** there is no email API or OAuth for iCloud Mail, so Composio can't help. The only way in is IMAP (`imap.mail.me.com:993`) and SMTP (`smtp.mail.me.com:587`) with an app-specific password. Custom domains on iCloud+ work the same way: you log in with the Apple ID and send from the domain alias. The same IMAP/SMTP path covers hosting mail (Locaweb, Hostinger, cPanel), Fastmail, Zoho and Yahoo, which are common among small companies in Brazil.

## Decision

### Which path for which mailbox

| Mailbox | Path |
| --- | --- |
| Gmail, Outlook / Microsoft 365 | Composio, with its managed OAuth app |
| iCloud (including custom domains), hosting mail, Fastmail, Zoho, Yahoo, any IMAP | Our IMAP/SMTP connector, using an app password and presets per provider |
| Apps with a good official MCP (GitHub, Linear, Notion, Supabase, Stripe, Figma…) | Direct MCP (ADR 0016), never through Composio |

### Composio is a `ToolSource`, not a policy

- It plugs in as a tool source behind the Tool Gateway, like an MCP connection. The org connects once, and each agent gets a subset (ADR 0016).
- **Only explicit actions are exposed.** The meta-tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_PROXY_EXECUTE`) never are, because each of them is a way around per-tool grants.
- The Composio project key lives only on the server; agents and clients never see it. The Composio user id is our org id, plus the person's id for personal accounts.
- Access is decided only by our grants, approvals and per-call checks.

### Per-call checks (`checkCall`, D53)

Email needs rules about a call's arguments. These go in the standard per-call hook proposed in D53, declared by the connector and run by the gateway before a run and again before an approved action executes:

- **Read:** search, read and list folders. It can be limited to folders, senders or domains, and a time window. Reads never ask (ADR 0037).
- **Draft:** creates a draft in the mailbox and never sends.
- **Send / reply / forward:** a sensitive tool, so every call asks for approval in the chat by default, showing the exact recipients and body (ADR 0015).
  - Optional settings: allowed recipients or domains, a daily cap per agent, and which From address to use.
  - An agent can be set to "send without asking" only when it has an allowed-recipients list.
- **Organize:** move, flag and archive.
- **Delete:** off. If turned on, it always asks.

Send detection never trusts the tool name alone. Each email tool declares its effect, and anything undeclared counts as a send.

### Our IMAP/SMTP connector

- **Libraries:** `imapflow` and `nodemailer`. Running them on Bun needs a spike first. If they fail, the fallback is a small protocol client behind the same interface.
- **Credentials:** the app password is sealed with envelope encryption like the other connection secrets. It is opened only in worker memory, for one call, and never returned to clients or put into prompts.
- **Network:** TLS only, with certificate verification. The host comes from a preset; for a custom host, `net-guard` blocks private and metadata addresses.
- **Read-only at the protocol level:** read tools open folders with `EXAMINE` (not `SELECT`) and fetch with `BODY.PEEK`. A bug on our side then can't change the mailbox or mark mail as read.
- **Parsing:**
  - MIME, attachments (metadata, with download on request into the Drive), HTML to text, charsets.
  - Replies keep the thread (`In-Reply-To`, `References`).
  - Long threads are cut to the latest messages, plus a summary.
- **Setup screen:** one simple question per step. Pick the provider, then follow Apple's (or the host's) steps to create an app password, then paste it. The screen suggests a dedicated mailbox or alias for agents.

### Inbound mail (routines)

- **Composio:** a trigger such as `GMAIL_NEW_GMAIL_MESSAGE` posts a signed webhook into our webhook receiver, and that enqueues a routine run for the agent.
  - The filter (from, subject, label) is pushed to the source as a Gmail search, so unrelated mail never becomes a billed event.
  - Events are deduplicated by message id, and bursts merge into one run.
  - An expired account marks the routine "Reconnect".
- **IMAP:** first version polls every few minutes per watched folder, through an outbox job.
  - It tracks the last seen UID per folder and resets when `UIDVALIDITY` changes.
  - The first run starts from now, not from the whole history.
  - IDLE (one persistent connection per mailbox) comes later, only if latency matters.
- **In both cases** the content enters the context wrapped as untrusted external data. A run started by inbound mail can never approve its own send.

### Prerequisite (D53)

The `checkCall` hook in the gateway, with the GitHub repository check moved onto it.

KMS is not a prerequisite for email. Gmail and Outlook through Composio store no token of ours. IMAP passwords are sealed the same way as the provider keys, GitHub tokens and MCP OAuth tokens we already store. The KMS-backed `KeyWrapper` is ADR 0007's pending Cloud module, due before the first real customers for every credential (D53).

### Order

1. `checkCall`.
2. Gmail/Outlook through Composio: read, draft, and send with approval.
3. Composio inbound triggers into routines.
4. IMAP/SMTP read and send.
5. IMAP inbound by polling.

## Consequences

- People get Gmail and Outlook without us going through Google's verification and CASA. In exchange:
  - The consent screen says "Composio". Showing agentes.chat needs our own Google OAuth app, and then verification and CASA are ours.
  - Composio is a data processor under the LGPD, and sees email content. A formal DPA is on their Enterprise plan; this has to be listed in the privacy policy.
  - We depend on their pricing:
    - Pro is $29 a month, then about $0.0003–0.0005 per call.
    - **Triggers cost $0.003 per event.** At 100 organizations × 1,000 mails a day that is about $9k a month, so filtering at the source is mandatory.
- **Exit:** once email is central and there are paying customers, we register our own Google app, pass the assessment, and move Gmail in-house behind the same tool names. Accounts connected earlier stay on the old auth config until they reconnect.
- **IMAP app passwords can't be scoped at the provider.** Our scopes protect against the agent (prompt injection from mail), not against someone who steals the credential from us. The screen suggests a dedicated mailbox. The KMS from ADR 0007 makes stealing the credential harder for every credential, this one included.
- **Prompt injection through inbound mail is reduced, not removed.** The defences are untrusted wrapping, approval on send, recipient lists, and runs started by inbound mail never approving their own sends. The agent screen warns about "reads outside mail + sends without asking".
- **Tests** use a fake Composio source and a fake IMAP/SMTP server (no network), following ADR 0003.
- **Self-host:** Composio is a Cloud module. The IMAP/SMTP connector works in core. This is noted for the open-source list in the planning doc when it is decided.
