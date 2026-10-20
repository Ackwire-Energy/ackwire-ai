# 0041. Claude accounts on a connected computer, chosen per agent

- Status: Proposed
- Date: 2026-10-20
- Planning: D63
- Extends: ADR 0025 (connected computers), ADR 0027 (secrets, end to end), ADR 0032 (Claude Code as a brain), ADR 0036 (desktop app)
- Out of scope for now: Codex accounts (same shape later, `CODEX_HOME` per account), cloud computers, switching accounts by itself when a plan runs out

## Context

A Claude Code brain (ADR 0032) runs `claude` on the person's computer with the runner's environment (`apps/server/runner/brain.ts`, `spawn`). So every agent on that computer uses whichever account is signed in to Claude Code there (`~/.claude`, or `$CLAUDE_CONFIG_DIR`). The runner only reads it (`claude auth status --json`, `executors.ts`).

People have more than one account: a personal Pro, a work Max or Team seat. They want to pick which one pays for which agent, for example the reviewer on the work account and a personal assistant on their own. Today the only way is to sign out and in again in a terminal, and that changes every agent at once.

Constraints:

- Anthropic does not let third-party products collect, store or intermediate Claude.ai credentials or session tokens (see ADR 0027). Our server must never see a token or a sign-in code in the clear.
- Sign-in has to go through Anthropic's own flow, run by `claude` on the computer.
- Most of our users aren't technical (no terminal in the happy path).

## Decision

### 1. An account is a long-lived token kept only on the computer

- An account comes from `claude setup-token` (Anthropic's sign-in, run by the runner on the computer). Its token is stored in `<runner home>/claude-accounts/<accountId>.json` (mode 600, folder 700).
- **Not in the agent's folder.** The agent works in its folder with a shell and file tools, so a token there would be one `cat` away. The accounts folder sits next to `secrets/` (ADR 0027), outside every workspace, and the runner refuses `read` and `push` inside it.
- There is always one more choice, **"Conta deste computador"**: no token, the `claude` sign-in already on the machine, exactly as today. It is the default, so nothing changes for people who don't care.
- Token, not a `CLAUDE_CONFIG_DIR` per account: `~/.claude` stays the only one, so the person's sessions keep resuming when an agent changes account, and nothing depends on how each OS keeps the sign-in (Keychain on macOS).

### 2. Adding an account from the app (chat card)

1. The computer's owner taps **"Adicionar conta do Claude"**: on the computer's page, on the agent page, or on the card shown when a turn fails with `not_logged_in`.
2. The server asks the runner to start a sign-in (op `claude_account`, action `begin`, new protocol version). The runner:
   - runs `claude setup-token` in a pseudo-terminal (it waits for input; a plain `spawn` doesn't do);
   - reads the sign-in URL it prints;
   - makes an ephemeral key pair as in ADR 0027 (the private key stays in `keys/`);
   - answers `{ loginId, url, publicKey }`.
3. The card shows **"Entrar com Claude"** (opens Anthropic's page) and a field for the code that page gives back.
4. The browser encrypts the code with the computer's key (ADR 0027 crypto, AAD `loginId | orgId | claude_account`). The server relays the ciphertext in memory and stores nothing of it.
5. The runner decrypts, writes the code to the waiting `claude`, reads the token from its output and checks it (`claude auth status --json` with that token). Then it writes the account file and answers with metadata only: email and plan when `auth status` reports them.
6. The sign-in expires in 10 minutes. After that the process is killed and the key deleted.

**Fallback:** if the pseudo-terminal is missing or `claude` prints something we can't parse (its wording may change between versions), the card says so in plain words and offers the same flow from the desktop app on the computer (`agentes-runner claude-login`, run locally, nothing relayed).

**To check in a spike before building:** that `setup-token` offers the paste-the-code path when nothing on the machine can receive the callback, what it prints, and whether `auth status` reports email and plan when only the token is set.

### 3. Data

- **`machine_claude_accounts`**: `org_id`, `machine_id`, `id`, `label` (the person's name for it: "Trabalho"), `email`, `plan`, `status` (`active` | `signed_out`), `created_by`, `created_at`, `last_used_at`. There is no column for the token.
- **`agents.claude_account_id`**: nullable, FK `(org_id, claude_account_id)`. Null means "Conta deste computador". An agent has one computer (`agents.machine_id`), so the account must belong to that machine (checked in code). Moving the agent to another computer clears it.

### 4. Who decides

The subscription is personal, so only the **computer's owner** adds or removes accounts and sets an agent's account. Other people who can edit the agent see the choice ("Conta do Claude: Trabalho, de Walter") but can't change it. An agent can never change its own account (no tool for it).

From the chat this is a button on the card or on the agent page. "A partir de agora, o Revisor usa minha conta do trabalho" can show that same card to the owner, who confirms it.

### 5. A turn

- `BrainTurnRequest` gains `claudeAccountId?`. When it is set, the runner loads the token and starts `claude` with:
  - `CLAUDE_CODE_OAUTH_TOKEN`;
  - `ANTHROPIC_API_KEY` removed from that environment, so a key on the machine doesn't win over the account.
- The token joins the values the runner redacts from output (`redactSecrets`).
- If the account file is missing, the turn fails with `account_missing`. If the token is refused, the runner marks the account `signed_out` and the agent page offers to sign in again. **It never falls back to another account.** The model fallback (`brainFallback`) behaves as it does for any brain failure.
- Plan usage and limit events carry the account, so the agent page shows which account hit its limit.
- A live process (`keepAlive`) is keyed by (agent, session, account): changing account starts a new process on the same session.

### 6. No automatic rotation

When an account runs out of plan, the agent says so and waits, or uses the model fallback. It doesn't move to another account by itself: subscriptions are personal, and rotating them to get around limits can break Anthropic's terms. A person may still point the agent at another account.

### 7. Removing an account

The owner sees which agents use it, confirms, and those agents go back to "Conta deste computador". The runner deletes the file. The page reminds the owner that the token can also be revoked on claude.ai.

### 8. Security, honestly

The token reaches `claude` through its environment, and the commands the agent runs (Bash) inherit that environment. A hostile agent could read it, and redaction can't stop it from sending the token out some other way. This is no worse than today: the agent already runs as the person and can reach the machine's own sign-in. The account is as safe as the computer, no more. Isolation (ADR 0030) is what raises that bar later.

## Consequences

- Positive: one agent per subscription, chosen per agent, added from the phone or the web without a terminal. Our server never sees a token or a code.
- Positive: sessions survive a change of account, and people who don't care see no change.
- Negative: we parse the output of an interactive CLI command. It can break on a Claude Code update, so it needs a test with a fake `claude` (`claudeCommand`) and the local fallback.
- Negative: a pseudo-terminal dependency in the runner (and in the compiled desktop sidecar).
- Negative: a new runner protocol version, a migration, and a selector on the agent page.

## Alternatives considered

- **A `CLAUDE_CONFIG_DIR` per account.** Each folder keeps its own sign-in and sessions. Rejected: changing account loses the session (or needs copying), the person's CLAUDE.md, skills and plugins stop applying, and the macOS Keychain behavior per folder is uncertain.
- **The token in the agent's folder.** Simple, but the agent's own tools read it. Rejected.
- **The token encrypted on our server** (like ADR 0007 credentials). Forbidden for Claude.ai credentials. Rejected.
- **Sign in only from a terminal on the computer.** Safe, but not for non-technical people and impossible from the phone. Kept only as the fallback.
- **Signing in to Anthropic ourselves with Claude Code's client id.** That would be passing ourselves off as Claude Code. Rejected.
