# 0142. The Vault: logins, keys and contacts agents use, personal or the team's, from any source

- Status: Accepted (built: the server, the runner, the web and the phone app)
- Date: 2026-11-03
- Amends: ADR 0027 (§7: a site's password is kept in the runner's memory only, never in `store.json`; a request may
  carry a username and ask for a code; the card can save the value to the Vault), ADR 0040 and 0054 (the browser
  types a Vault login), ADR 0133 (Chrome's own password manager is off in agent profiles)
- Builds on: ADR 0007 (sealed values at rest), ADR 0002 (adapters and modules), ADR 0053 (who is behind a run),
  ADR 0085 and 0125 (roles as an audience), ADR 0110 (browser profiles), ADR 0117 (injection hardening)
- Code: schema `packages/db/src/schema/vault.ts` (`vault_items`, `vault_connections`, `vault_uses`), migration
  `0213_vault`; engine `packages/engine/src/vault/*` (access, items, connections, sync, CSV import, uses, the agent
  tools in `tools.ts`); sources `packages/adapters/src/vault/*` (the port `source.ts`, the site rule `site.ts`,
  `onepassword.ts`, `bitwarden.ts`); the box's additional data `vaultAad` in `packages/adapters/src/secret-box.ts`;
  protocol 43 (`VAULT_PROTOCOL`, `vault.key`, `agentes:type_vault`, `exec.vault`) and the runner's in-memory store
  `apps/server/runner/vault.ts`; routes `apps/server/src/routes/app/vault.ts`; client `packages/client/src/vault/*`;
  web `apps/web/src/components/vault/*`; phone `apps/mobile/src/features/vault/*`

## Context

Agents sign in to sites, call APIs and fill in forms for people. Until now each password or key reached them through
a request card (`request_secret`, ADR 0027): typed by one person, for one run, kept on the computer. Nothing was kept
for next time, nothing could be shared with a team, and the values people already keep in a password manager
weren't reachable. A site's password also sat in the runner's `store.json` as plain text.

People need one place for what agents use, which works for a team (who may use what, on whose behalf) and for one
person (my own logins, used only when I ask), and which reads the password manager a company already has.

## Decision

### 1. What the Vault holds

- **Login**: website, where it may be typed (`exact`, the default: that origin only; or `site`: any HTTPS page of
  the same registrable domain, by the public suffix list with private suffixes, so one `*.github.io` site never fills
  another's), username, password.
- **Key**: a variable name (`SECRET_NAME`, never a reserved name), a description, the value.
- **Contact**: name, company, tax id, email, phone and address. Not a secret: agents read the fields and type them.
  Still sealed at rest, as personal data.

No authenticator seed is stored: a login that keeps its second factor next to its password stops being two factors.
A code from a text message or an email is asked of the person when it's needed (§6).

### 2. Personal or the team's, and one rule for use

Each item is **personal** (its owner alone sees, edits and deletes it) or **the team's** (created and edited
with `manage_credentials`; its audience, everyone or roles or people, says who sees it). Each item also lists the
agents that may use it, or all of them.

An agent may use an item in a run when:
- the agent is on the item's list; and
- personal: the person behind the run (who asked, else the routine's creator, ADR 0053) is the owner;
- team: that person is in the audience, or nobody is behind the run and the audience is everyone.

The check runs at every use, with no cache: someone who leaves a role or the workspace stops counting at once. A
person who leaves takes their personal items and connections with them. New team items start open to everyone and
to no agent; an item saved from a request card starts with the agent that asked.

**A saved value never comes back to a person.** Once a password or a key is saved, no answer carries it to anyone:
not its owner, not the people who manage credentials. An item's page says one is saved (a key, by its last four
characters), and changing it means typing a new one. Only an agent's computer gets it, sealed for one use (§4), so a
value leaves a person's screen once, as it is typed, and never comes back to one. A contact isn't a secret:
whoever sees the item reads it.

Two narrower rules:
- **Routines type logins but give no key to a command.** A run a routine feeds (ADR 0053 §3: its own run, or one its
  report or work woke) never sends a credential, and a command holding a key could send it anywhere, so `run_code`
  with `keys` is refused there ("A routine can't use Vault keys in commands…"). A saved login it may still type in
  the browser: that value never reaches the model or a command.
- **A shared browser profile (ADR 0110) takes only what all its agents may use, for anyone.** A session signed in
  there is every granted agent's, whoever each one works for, so a personal login is never typed in one, nor a team
  login open only to some people or roles; a team login open to everyone, only when it is shared with all agents or
  with each agent the profile is granted to (the grants read at the fill).

What agents change: a contact they keep for the person behind the run, a login's username, an item's description,
on that person's own items, or on the team's only when that person manages credentials, as in the app. An agent
deletes only what it saved itself; everything people saved, people delete in Settings › Vault.

### 3. Sources

A source (`VaultSource`, `packages/adapters/src/vault/source.ts`) connects, lists metadata and reveals one value on
demand. Nothing else knows which source an item comes from: access, history, the box to the computer and the
runner's checks are the same for all.

- **Built-in**, always on, needs only Postgres: values sealed like every org credential (ADR 0007), with additional
  data that binds org, item, owner and version (`vault-item|org|item|owner|version`), so a row moved or restored onto
  another owner doesn't open.
- **1Password**: a service account the person creates with access to one vault only (the connection refuses one
  that sees more). Overviews are listed every 10 minutes; a full item is read only when it's new or changed, since
  service accounts have read limits. Passwords are read at use and kept nowhere.
- **Bitwarden and Vaultwarden**: a client of their API written here (no CLI to download), with the account's API key
  and master password, reading the logins of one folder. The master password opens the whole account, so the screen
  asks for an account made only for agents. A self-hosted server's address is typed by a person, so every request
  goes through the server's guarded fetch (`publicHttpsFetch`): https only, every address the host resolves to
  public, the socket pinned to the address checked, no redirect; a refused address is `invalid_input`. The key
  derivation the account's server asks for is capped (Argon2id's memory times its iterations at most 256 MiB, e.g.
  64 MiB with 4 iterations; heavier is `unsupported`) and runs one at a time per workspace, two at most across the
  process; every call into a source has a 60 s deadline.
- **Modules** add sources through `AgentesModule.adapters()` (`vaultSources`, merged by kind).

A source's items are indexed (`vault_items`, metadata only) and follow the connection's default access until someone
changes theirs. An item gone from its source is marked missing, not deleted, so its history stays. The workspace's
item limit counts them too: at it, the items already indexed stay and new ones wait, the connection showing
`too_many_items` ("Remove items before syncing more") until a later sync finds room; what is missing is decided by
the source's list alone.

### 4. Filling without asking

A saved login is typed without a person's yes each time. The guards are elsewhere:

1. **The model never gets a value.** Tools return names, sites and usernames; a value never enters a tool argument
   or result, a message, a log, an audit row, an event or an outbox payload.
2. **A one-use key in the computer's memory.** For each fill the engine asks the agent's runner for a key
   (`vault.key`, protocol 43). The runner keeps the private key in memory only, for 2 minutes and one opening, in the
   agent's own worker in system mode, so root never sees the value. The server seals the password to it with the
   ADR 0027 box and additional data `agentes-vault|v1|key|agent|fill:<rule>`, which the runner rebuilds from its own
   record: a box replayed to another key, agent or site rule doesn't open.
3. **The runner checks the frame that owns the field, when it types.** In one browser invocation it focuses the
   field, checks that its frame's origin and every ancestor's match the rule, that it is a password field and that
   neither its form nor a submit button of it (`formmethod`) sends by GET, marks that field with a one-time
   attribute, fills the element carrying the mark (a page that moved on has none) and takes the mark off. The value
   is dropped when the batch ends. The page's own scripts can patch the DOM the check reads; they can't fake
   `location`, `ancestorOrigins` or `top`, so what the check guarantees is the origins the value goes to, and the
   field checks catch honest mistakes (a script of the rule's own site could read the field anyway). A field inside
   an embedded frame (the ref is the frame itself) gets nothing (`in_frame`): the agent asks the person to sign in
   there through the browser hand-off (`browser_ask_person`).
4. **A typed value doesn't leave in an address.** Before a password is typed, its Chrome pauses every request and
   the fill waits until Chrome acknowledged that on every page and frame, those opened since an earlier fill too
   (unconfirmed, or refused by one still open: nothing is typed); for 2 minutes then, a request whose URL carries
   the value (raw or encoded) is stopped, and the agent is told. A fill that was refused takes the guard back.
5. **Replies are redacted.** For 10 minutes the value is removed from every browser reply and error, browser
   profiles' included.
6. **Chrome keeps nothing.** Its own password manager, sign-in and form autofill are off in every agent profile.
7. **Every use is recorded** on the item (who, where, for whom) and in the audit log.

Keys follow the same path to step 2, then go into the environment of one command only (`run_code` with `keys`,
`exec.vault`), with its output redacted, and are kept nowhere; never in a run a routine feeds (§2). Computer brains,
whose own shells can't take a value for one command, reach the same path through a tool. A key's use is recorded
once the computer took the command with it: an answer came back (any exit code), or none did (the link dropped, no
answer in time). Not when the command never reached the computer or the runner refused it before opening the keys
(the command policy, a switch, a key it couldn't open).

What agents read of an item (its title, username, description, a contact's fields) was written by people, agents,
password managers or CSV files: `vault_list` gives each item's text in its own `untrustedBlock` and counts as
reading outside text (ADR 0117). No other tool text carries it: refusals, `vault_save`'s answers and a browser plan's
report name an item by its id and what the server checked when it was saved, a login's site and a key's variable
name (`vaultItemName`: "Typed the Vault login for github.com"). `vault_list` records a read only for the contacts it
shows.

### 5. What it doesn't protect against

- **The agent's own code on the same computer.** A key exists for its commands to use. A typed password sits in the
  page, which a script running as the same user can read through Chrome's debugging port. Redaction, the outbound
  checks (ADR 0117) and the field going unreadable to the agent's tools narrow it; running the browser as another
  system user would close it, and is left for when browser profiles move to their own users (ADR 0110, phase 2).
- **The server itself.** It opens built-in values and uses the connections' credentials, as it does for model keys.
  The database alone opens nothing; the database and the server's key together open everything. A module can keep
  that key in a KMS (ADR 0007).
- **An agent already signed in** can do wrong things with the session, as a person could. Sensitive actions keep
  asking for approval (ADR 0015).
- **A session stays in the agent's browser.** A session an agent opens stays in its own browser for its later work,
  so on an agent several people use, people give it logins meant to be shared, not personal ones.

### 6. The request card

`request_secret` keeps its card and gains:
- **Save to the Vault**, checked by default for a site's password and for a key, never for a file or a code:
  personal or the team's (the team's only with `manage_credentials`), and the agents that may use it, starting with
  the one that asked. The card delivers the box as before and then sends the value once, over TLS, to be sealed in
  the Vault: the only moment the server gets a value a person typed.
- A **username** the agent may fill in, shown on the card and kept with the login.
- A **code** mode (`digits`), with one box per digit, typed by the runner into one field or one field per digit.

A site's password from a request is no longer written to `store.json`: the runner keeps it in memory for 15
minutes (`SITE_SECRET_TTL_MS`, the protocol's), and drops any site entry left in the file when it loads. The server
counts it gone after the same 15 minutes: the agent isn't told it still holds it, the agent's page doesn't list it,
a new request doesn't "replace" it, and an agent that tries to type it hears plainly that it was kept in memory only
and is gone (ask again, or save it to the Vault). Keys and files asked with `request_secret` (`env`, `file`) are
unchanged.

### 7. Screens

In Portuguese the feature is called **Cofre**; every other language keeps **Vault** as its name.

Settings › Vault, on the web and the phone: Team, Personal and Connections, each item with who may use it and its
last use (a contact by its title and description: the list carries no contact's details, so it opens no contact's
seal); an item's page with its fields (a password or a key always behind its dots, §2; a contact whose saved
details don't open on this server says so, and is never changed on top of nothing, for a person to save them again),
who has access in one sentence and its recent uses; a new item by kind; a CSV import from a browser or password manager export (web),
which keeps nothing of the file; and one card per source to connect, generated from what the source describes.
The apps reload the Vault on `vault.changed`, sent when an item, a connection or an access changes, never for a use
alone (a fill, a key or a read): agents at work don't make every open app reload it.

## Consequences

- Agents find what they need before asking (`vault_list`), and a password typed once in a card can serve the next
  time.
- Old runners (protocol < 43) never receive a Vault value; the agent is told the computer needs an update.
- More values pass through the server than with request cards alone. The Vault is opt-in per item, and the card says
  so.
- Left for later: the browser under its own system user, usage alerts to an item's owner (first use on a new site,
  bursts), Bitwarden organization collections, 1Password's desktop app as a source.
