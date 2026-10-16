# 0030. Isolation on connected computers: an environment per agent, scoped git, optional OS sandbox

- Status: Proposed (to build after missions, ADR 0029)
- Date: 2026-10-16
- Planning: D43
- Extends: ADR 0025 (connected computers), ADR 0024 (git proxy), ADR 0027 (secrets to agent computers)

## Context

On a connected machine the runner runs commands as the OS user that runs it. What isolates agents today:

- each agent has its own folder in the workspace (`<handle>-<id8>`), the `cwd` of its commands;
- the file tools refuse `..`, absolute paths and symlinks that leave the workspace;
- secrets live per agent outside the workspace and are redacted from output (ADR 0027);
- `--no-exec` turns commands off.

A shell command still reaches anything that user can: `~/.gitconfig`, `~/.ssh`, the owner's GitHub login, other agents' folders, the whole network. Two consequences:

- **Git.** The git proxy (ADR 0024) does not apply, and we never rewrite a person's global git config. An agent that needs git either uses the owner's identity and credentials or can't push. Commits look like the owner's.
- **Approvals.** With the owner's credentials on the machine, the executor can merge to the default branch itself. "Merge needs approval" (ADR 0015, 0029) is then a policy in the instructions, not a guarantee.

## Decision

Three levels. Level 1 is the default for every connected machine; levels 2 and 3 are choices made at pairing.

### Level 1: an environment per agent (cross-platform)

The runner builds each command's environment for the requesting agent, without touching the owner's files:

- **Git config:** `GIT_CONFIG_GLOBAL=<agent folder>/.agentes/gitconfig`. A `configure_git` op (from a tool) writes that file: name and email of the agent, a credential helper, `insteadOf` rules. The owner's `~/.gitconfig` is never read for writing and never changed.
- **Authorship:** commits are authored as the agent (`Dev (agentes.chat) <dev+<org>@agents.agentes.chat>`) with a `Co-authored-by` trailer for the person who started the work.
- **GitHub access, preferred:** a short-lived token minted by our server from the org's GitHub connection (GitHub App installation token, ADR 0016/0024), scoped to the repos the agent may use, delivered to the runner per task through the credential helper (`agentes-runner git-credential`), never written to disk in plaintext. The policy lives server-side, like the git proxy: push only to `agentes/{handle}/*` and mission branches, no force push to protected refs, no direct push to the default branch. Merges go through our GitHub connector after an approval card. This makes approvals binding.
- **GitHub access, fallback:** a token the person hands over with `request_secret` (ADR 0027), stored in the agent's secrets, used through the same credential helper.
- **SSH:** if a remote needs it, an agent-only key under the agent's secrets via `GIT_SSH_COMMAND="ssh -i … -o IdentitiesOnly=yes"`.
- **Not changed:** `HOME`. The executor's own sign-in (`~/.claude`, `~/.codex`) must keep working, so isolation is by targeted variables, not by a fake home.

### Level 2: OS sandbox ("modo protegido", optional)

- **macOS:** commands run under Seatbelt (`sandbox-exec` with a generated profile): writes only to the agent folder, the task worktrees and a temp dir; reads of the owner's home limited to what the executor needs; network off, all, or an allowlist.
- **Linux:** the same with bubblewrap (or landlock where bubblewrap is missing).
- **Windows:** not available; level 1 only, and the pairing screen says so.
- **Executor sandbox:** when the executor has its own sandbox (Claude Code's sandbox settings), the runner turns it on through the settings it already passes, as a second layer. To be confirmed against the executor's docs when built.
- Turned on per machine at pairing (`--protected`) or later from the machine page; the agent's `computer_status` says which mode it is in.

### Level 3: real separation (documented)

- A dedicated OS user for the runner (the install guide already recommends it), or
- the runner executing commands inside a container or VM the owner provides.
- The agent then has full freedom inside, and the owner's machine stays out. We document and detect it (`computer_status`), we don't manage the container.

## Order

1. Level 1 git: `GIT_CONFIG_GLOBAL`, agent authorship, credential helper with `request_secret` tokens.
2. Short-lived GitHub tokens from our connector with server-side branch policy; merges only through the connector after approval.
3. Level 2 on macOS and Linux behind a pairing option.
4. Level 3 docs and detection.

## Consequences

- Agents get a git identity of their own and the owner's config stays untouched.
- With connector tokens, "merge needs approval" holds on connected machines too, not only in the cloud.
- Level 2 trades convenience for safety (some tools break without network or home access); it stays opt-in.
- Windows machines get level 1 only.
