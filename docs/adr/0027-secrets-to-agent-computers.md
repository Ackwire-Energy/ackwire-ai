# 0027. Secrets delivered to an agent's computer, end to end

- Status: Accepted (built 2026-10-16). Superseded in part by ADR 0077 (2026-10-28): the cloud computer's helper (`packages/engine/src/secret-helper.ts`) and its command wrapper; secrets reach connected computers through the runner (protocol 3)
- Date: 2026-10-16

## Context

Agents work on computers: their cloud computer (ADR 0021, Daytona) or a connected machine (ADR 0025). Real work there keeps needing something only a person has:

- an OAuth code to finish a CLI sign-in (`claude`, `gh auth login`, `gcloud`, `vercel login`);
- a token for a CLI (npm, AWS, Vercel), a password, a 2FA code, the values of a `.env`.

Today the only way to hand one over is to paste it in the chat. Then the value:

- is stored in `messages` (and in search, summaries, exports);
- is shown to everyone in the conversation;
- goes into the model's context (a third party) and into run transcripts.

Organization credentials (ADR 0007) solve a different problem: secrets **our server** uses (provider keys, connector tokens), encrypted at rest and decrypted by us. Here the secret is for **the computer** only. Some providers also forbid us from holding it at all: Anthropic does not let third-party products "collect, store, or intermediate Claude.ai credentials or session tokens" (Claude Code legal and compliance page, 2026-10).

## Decision

### 1. The plaintext exists only in two places

The person's browser and the agent's computer. Our server, database, logs, outbox, pub/sub, the model and the chat never see it. The server relays ciphertext it cannot open, plus metadata (name, purpose, target, who, when).

### 2. The agent asks with a tool; the person answers in a card

- **`request_secret`** (built-in, scope `sandbox:run`: it needs a computer). Input:
  - `name`: `^[A-Z][A-Z0-9_]{0,63}$` (e.g. `GITHUB_TOKEN`);
  - `purpose`: one sentence shown to the person ("publicar o repositório no npm");
  - `target`: where it goes (section 4).
- The run suspends like `ask_user` (`waiting_input`) until the secret is delivered, declined or expires (15 min). The tool result is only metadata: `GITHUB_TOKEN delivered (env)`, `declined`, `expired`.
- **Who can answer:** only the person whose message started the run (`requested_for`). Everyone else in the conversation sees "Theo pediu um segredo a Walter" and nothing more. An agent can't request a secret for anyone else, and a run started by a routine or by another agent can't request one.
- **The card** (chat, `meta.secretRequestId`): agent, computer (its name; "computador na nuvem" or "MacBook do Walter"), `name`, `purpose`, target, a password field, Enviar / Recusar. After delivery it reads "GITHUB_TOKEN entregue a Theo · 16/10 01:30"; the value is never rendered again.
- **`secret_requests`** table (`org_id`, agent, run, channel, thread, `requested_for`, `name`, `purpose`, `target`, computer ref, `public_key`, `status` pending | delivered | declined | expired, `expires_at`, timestamps). There is no column for the value or the ciphertext.

### 3. Crypto: an ephemeral key per request, generated on the computer

1. On `request_secret`, the server asks the computer for a key pair for that request:
   - cloud computer: a dependency-free Node helper we install at `$HOME/.agentes-secrets/helper.mjs` (rewritten on each secret action, so a recreated computer gets it back; `packages/engine/src/secret-helper.ts`), run through `exec`;
   - connected machine: runner op `secret` with actions `keypair`, `deliver`, `discard`, `remove` (runner protocol 3; older runners are told to run `agentes-runner update`). Each agent's secrets live in `<runner home>/secrets/<agent id8>/`.
   The private key is written to `keys/<requestId>` (mode 600, folder 700) and never leaves the computer. The public key is stored on the request. Keys of requests nobody answered are pruned after an hour, the next time a key is made.
2. The browser encrypts with WebCrypto: ephemeral ECDH P-256 against the computer's key, HKDF-SHA256, AES-256-GCM. The AAD binds the ciphertext to `requestId | orgId | name | target`, so it can't be replayed onto another request or target.
3. `POST /api/app/secrets/{id}/deliver { epk, iv, ciphertext }` (cookie session + CSRF): the server checks requester, status, expiry and size (≤ 16 KB), forwards the payload to the computer in memory and stores nothing of it. The computer decrypts, writes the target, deletes the private key and answers `ok` (with the byte size only). Offline computer or failure: the request stays pending and the person can try again until it expires.
4. Declined: the server tells the computer to delete that private key. Expired or canceled: the key is pruned there (see 1).

### 4. Targets

- **`env`**: one line in `~/.agentes/secrets/env` (mode 600). Commands the agent runs see it as an environment variable: on Daytona our exec wrapper sources that file; the runner adds it to the child's environment.
- **`file`**: a path in the agent's workspace (e.g. `.npmrc`, `.env`), mode 600; paths outside it are refused.
- **`stdin`** (later): the input of a process that is waiting (a CLI sign-in in a session kept by the computer). Until then, interactive sign-ins use the computer's terminal shown in the app, which talks to the computer directly (Claude Code sign-in must complete through Anthropic's own flow).

### 5. Keeping the value away from the model afterwards

The agent has a shell on its computer, so it can read a secret it was given. We reduce, not prevent:

- **Redaction on the computer:** exact secret values (4+ characters) are replaced with `[secret:NAME]` in command output before it leaves the computer. Cloud computer: when the agent has secrets there, its commands run through the helper (`helper.mjs run`), which gives them the env values and filters stdout and stderr, holding back a tail so a value split across chunks is still caught; without the helper the command runs as is. Runner: in its output, live and final.
- The secrets store sits outside the workspace, so the file tools never see it. Files that hold a secret can't be read, exported or uploaded (`read_file`, `export_file`, `upload_file`; the runner refuses `read` and `push` of them too).
- Tool descriptions and the agent context say: never ask for passwords, tokens or codes in the chat; use `request_secret` and refer to secrets by name.

### 6. Lifecycle and audit

- The agent page lists the secrets on its computer (name, target, delivered by, when), never values, with **Remover** (deletes them on the computer). A cloud computer that is recreated loses its secrets, and the page says so. To rotate a secret, request it again.
- Audit entries: `secret.requested`, `secret.delivered`, `secret.declined`, `secret.expired`, `secret.removed`, with name and target, never the value.
- Limits: at most 3 pending requests per run and 50 secrets per computer.

## Consequences

- Positive: one safe way to give a computer what only a person has, the same for cloud computers and connected machines. The chat, search and the model stay clean, and we never hold users' credentials, which some providers require.
- Negative: we trust the code of our server, not just its storage. A compromised server could hand the browser its own public key instead of the computer's. Showing a fingerprint wouldn't help people in practice; the direct terminal remains the path where even that relay is gone.
- Negative: redaction is best effort. A transformed value (base64, split strings) can still reach the model if the agent prints it.
- Negative: new runner protocol 3 and a helper installed in cloud computers.

## Alternatives considered

- **Paste it in the chat.** What happens today: stored, shown and sent to the model. Rejected.
- **An organization vault on our server, injected at exec time** (like ADR 0007). Simpler, and right for secrets the organization manages (it may come later as "segredos da organização"), but the server sees the plaintext. That isn't acceptable for personal credentials and is forbidden for Claude sign-ins.
- **A form served by the computer itself** (a Daytona preview URL, straight from browser to computer). It bypasses our server entirely, but it only exists for Daytona, not for connected machines, and every computer would need to run a small web server. We keep that direct path only for the interactive terminal.
