# 0041. Claude and Codex accounts on a connected computer, chosen per agent; effort per agent

- Status: Accepted (2026-10-20). Superseded in part by ADR 0059 (§2 who adds accounts, §4 who decides, §7 removing)
- Date: 2026-10-20
- Extends: ADR 0025 (connected computers), ADR 0027 (secrets, end to end), ADR 0032 (Claude Code and Codex as brains), ADR 0036 (desktop app)
- Out of scope for now: cloud computers, switching accounts by itself when a plan runs out

## Context

A computer brain (ADR 0032) runs `claude` or `codex` on the person's computer with the runner's environment. Every agent on that computer uses whichever account is signed in there (`~/.claude`, `~/.codex`). People have more than one account (a personal plan, a work seat) and want to pick which one each agent spends. Today that means signing out and in again in a terminal, for every agent at once.

Constraints:

- Anthropic does not let third-party products collect, store or intermediate Claude.ai credentials (see ADR 0027). Our code must not hold the token; our server must never see a sign-in code in the clear.
- Sign-in goes through the provider's own flow, run by its own CLI on the computer.
- Most users aren't technical: no terminal in the happy path, and they are often on another device (phone, another laptop).

What the CLIs do (checked 2026-10-20, Claude Code 2.1.304, Codex 0.163.0):

- `claude auth login` with `CLAUDE_CONFIG_DIR=<dir>` keeps that sign-in in `<dir>`. It works with plain pipes (no terminal needed), prints `If the browser didn't open, visit: <url>` (an OAuth URL whose redirect is Anthropic's code page, `platform.claude.com/oauth/code/callback`) and waits on `Paste code here if prompted >`. It also tries to open a browser on the computer itself with a local callback; signing in there finishes without a code.
- `claude auth status --json` reports `loggedIn`, `email`, `subscriptionType` (pro, max, team…).
- `claude --effort <low|medium|high|xhigh|max>` sets the effort of a session.
- `codex login --device-auth` with `CODEX_HOME=<dir>` prints a device link (`https://auth.openai.com/codex/device`) and a one-time code (15 minutes), and finishes by itself once the person enters the code anywhere. `codex login status` reports the sign-in.
- Codex takes the effort as `-c model_reasoning_effort="<level>"`.

## Decision

### 1. An account is a folder on the computer, signed in by the provider's own CLI

- Each account is `<runner home>/accounts/<kind>/<accountId>/`, used as `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). The CLI writes and keeps its own sign-in there; the runner never reads, copies or sends it. Folder mode 700, outside every agent workspace (the runner refuses `read` and `push` inside `<runner home>`).
- There is always **"Conta deste computador"**: no folder, the sign-in already in `~/.claude` / `~/.codex`, exactly as today. It is the default.
- An account's sessions live in its folder. Changing an agent's account starts a new CLI session for its threads (the conversation itself is ours and continues). Rare, and accepted.
- The person's personal CLAUDE.md, skills and plugins don't load in an account folder. That matches the runner's `--setting-sources project` (`apps/server/runner/brain.ts`) anyway.

### 2. Adding an account from the web or the phone

1. Only the computer's owner sees **"Adicionar conta"**, at the end of the account dropdown in the agent's "Quem pensa".
2. The server asks the runner to start a sign-in (op `account`, action `begin`, `{ kind }`). The runner creates the folder, starts the CLI with pipes and answers with what the person needs:
   - Claude Code: `{ loginId, url, publicKey }`. The URL is the one the CLI prints; `publicKey` is an ephemeral key made as in ADR 0027 (private key stays on the computer).
   - Codex: `{ loginId, url, userCode }`.
3. The web shows it:
   - Claude Code: **"Entrar com Claude"** (opens the URL), then "Cole o código que o Claude mostrou". The browser encrypts the code with the computer's key (ADR 0027 crypto, AAD `loginId | orgId | account`); the server relays the ciphertext in memory and stores nothing; the runner decrypts it and writes it to the waiting CLI. If the person is at the computer and signs in through the browser the CLI opened there, it finishes without a code.
   - Codex: the link and the code to type there, with a line saying the person started this sign-in from agentes.chat (Codex warns against codes "a website gave you").
4. The runner watches the CLI. When it exits signed in, it runs the status command in that folder and answers with metadata only: email and plan. The server stores the account and tells the page (realtime), which picks it.
5. A sign-in expires in 15 minutes; the process is killed and the folder removed.
6. **Entrar de novo** on a signed-out account signs in again to that same account (`begin` with `again`): same id and folder, the agents keep it, and a failed retry leaves the folder as it was.

From the desktop app the same op runs locally: the CLI opens the computer's browser and finishes by itself.

### 3. Data

- **`machine_accounts`**: `org_id`, `machine_id`, `id`, `kind` (`claude_code` | `codex`), `label`, `email`, `plan`, `status` (`active` | `signed_out`), `created_by`, `created_at`, `last_used_at`. Nothing secret.
- **`agents.brain_account_id`**: nullable, FK `(org_id, brain_account_id)`; null = "Conta deste computador". It must belong to the agent's machine and match its brain kind (checked in code). Moving the agent to another computer, or changing brain kind, clears it.
- **`agents.brain_effort`**: nullable text (`low` | `medium` | `high` | `xhigh` | `max`); null = the CLI's or model's default.

### 4. Who decides

The subscription is personal: only the **computer's owner** adds or removes accounts and sets an agent's account. Others who can edit the agent see the account, locked. Effort is part of the brain settings and follows their rules. An agent never changes its own account or effort (no tool for it).

### 5. A turn

- `BrainTurnRequest` gains `account?: string` and `effort?: string`.
- Account: the runner sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to that folder (and looks up sessions there). A missing folder fails the turn with `account_missing`; a refused sign-in fails it with `not_logged_in`. Either way the runner asks the CLI again and reports the accounts (`accounts.changed`): only the computer says an account is signed out or gone, so a passing failure never sticks. **It never falls back to another account**; the model fallback (`brainFallback`) behaves as for any brain failure.
- Effort: `--effort <level>` (Claude Code), `-c model_reasoning_effort="<level>"` (Codex; `xhigh` and `max` map to `high`). The page offers Baixo, Médio, Alto, Máximo (`low`, `medium`, `high`, `max`). Effort for the organization's model brain (provider effort parameters through the Model Gateway) comes later.
- A live process is keyed by (agent, session, account, effort).
- Plan limit events carry the account, so the page says which account hit its limit.

### 6. No automatic rotation

When an account runs out of plan, the agent says so and waits, or uses the model fallback. It never moves to another account by itself: subscriptions are personal and rotating them to get around limits can break the providers' terms.

### 7. Removing an account

The owner sees which agents use it and confirms; those agents go back to "Conta deste computador". The runner runs the CLI's logout in that folder and deletes it.

### 8. Security, honestly

The CLI keeps the sign-in in the account folder, and the agent's commands run as the same user, so a hostile agent could reach it, as it can reach `~/.claude` today. The account is as safe as the computer, no more. Isolation (ADR 0030) raises that bar later.

## Consequences

- Positive: one subscription per agent, chosen per agent, added from the phone or the web without a terminal. Our code never holds a token; our server only relays an encrypted one-time code (Claude) or shows a device code (Codex).
- Positive: effort is a real per-agent knob for the computer brains.
- Negative: we read the CLIs' printed output (URL, prompt). It can change between versions: tests use fake CLIs, and on failure the page says so and offers the desktop app.
- Negative: a new runner protocol version, a migration, new UI on the agent page and in the desktop app.

## Alternatives considered

- **A long-lived token per account (`claude setup-token`) kept by the runner.** Simpler sessions, but our code would store a Claude.ai credential. Rejected.
- **The token in the agent's folder.** The agent's own tools read it. Rejected.
- **The token encrypted on our server.** Forbidden for Claude.ai credentials. Rejected.
- **Signing in only on the computer (desktop app).** Safe, but useless from the phone. Kept as the local path.
- **Our own OAuth with the provider's client id, so the redirect comes to us.** That would be passing ourselves off as the CLI. Rejected.
