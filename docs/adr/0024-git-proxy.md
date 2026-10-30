# 0024. Git in the agents' computers through our proxy (the token never enters the machine)

- Status: Accepted. Superseded in part by ADR 0077 (2026-10-28): the cloud computer's credential (`sandboxes.id`, `git_token_gen`, issued on every start), its setup inside that computer and **Network**; connected computers (the addendum) are every agent's computer, and the proxy is mounted on every server
- Date: 2026-10-15

## Decision

Agents use real `git clone/commit/push` against private repositories from their computer (ADR 0021), but GitHub's credential stays on our server. The computer talks smart-HTTP git to **our** endpoint, which checks policy and forwards to GitHub with the org's token added server-side.

**Endpoint.** `/api/git/{orgId}/{connectionId}/{owner}/{repo}.git/{info/refs | git-upload-pack | git-receive-pack}`. It uses no session cookie and no CSRF: the computer signs in with HTTP Basic, and the password is our credential.

**Per-computer credential.**
- `agtgit1.<claims>.<hmac>`: an HMAC (key derived from `AGENTES_SECRET`, purpose `git-proxy`) over org, agent, computer (`sandboxes.id`), a revocation generation (`sandboxes.git_token_gen`) and an expiry (6 h).
- It is issued on every start of the computer and refreshed after 3 h of use (`sandboxes.git_token_issued_at`).
- Bumping the generation (`revokeComputerGitCredentials`) or deleting the computer kills every token at once.
- It is not a GitHub secret: it only works against our proxy, for that agent's policy.

**In the computer.** Set up as its user (no environment variables):
- `~/.config/agentes/git-token` (mode 600) and a three-line credential helper that prints it, configured only for our origin;
- `url.<proxy>.insteadOf https://github.com/` (and `git@github.com:`), so `git clone https://github.com/owner/repo` just works;
- commit author "Theo (agentes) <theo@agents.agentes.chat>", `push.autoSetupRemote`.

**Network.** Our host is always reachable from the computer. With the org's network `blocked` or `allowlist`, the provider gets an allowlist that includes our host. The computer row still shows the org's own mode.

**Policy (checked in the proxy on every request):**
- The agent needs `github:git.read` (fetch/clone) or `github:git.write` (push, which implies read) on that GitHub connection. These are grants of the connection, deniable like any other.
- Optional repository list (`agent_repositories`): `owner/name` or `owner/*`, in order. When an agent has any, only those repositories work, here and in the Tool Gateway for every GitHub tool (reads included). It replaced the `github:git.repo:…` grants (migration 0063). Admins set it; the agent's owner, when not an admin, may only narrow it (every entry already in reach, never back to every repository), like its access (ADR 0016).
- Push commands are read from the receive-pack request (pkt-lines) before anything is sent:
  - only `refs/heads/agentes/{handle}/…`;
  - no tags and no deletes;
  - fast-forward only. We walk the pushed commits in the pack (our own small DEFLATE reader, because Node's zlib doesn't report how many bytes it consumed) from the new tip toward the old one. When the walk leaves the pack, GitHub's compare API must say `ahead` or `identical`.
- A refused push gets a proper `report-status` (inside side-band when negotiated), so `git push` prints the reason. It never reaches GitHub.
- Limits: a push of at most 100 MB, a fetch request of at most 10 MB, at most 2 GB downloaded per request, at most 500k objects.
- Audit: `git.fetch` (repository), `git.push` (refs, from/to, commit count), `git.push_refused` (refs and reasons).

**Upstream credential.** A GitHub App installation token for that one repository (1 h, cached) when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` are set and the app is installed there. Otherwise the org's GitHub connection token (OAuth, refreshed; or the API key). It goes out as `Basic x-access-token:…`, is never logged, and is never returned.

**Tools.**
- `git_clone(repo, dir?)` (`github:git.read`, and the computer must be granted) runs `git clone` in the workspace.
- `open_pull_request(repo, branch, title, body?, base?, draft?)` (`github:pr.write`) calls GitHub's REST API with the server-side credential.
- Merge stays approval-gated, as before.

## Consequences

- A fast-forward to an existing upstream commit that isn't in the pack needs the compare API; if GitHub can't answer, the push is refused (safe side).
- Deltified commits in a pack (rare for pushes) are not read. A walk that depends on them falls back to the compare API.
- The proxy holds a whole push in memory (up to the limit) to inspect it.

## Addendum (2026-10-18): the proxy on connected machines

ADR 0025 left connected machines out ("we never set up git on a person's machine"): an agent thinking with Claude Code on someone's Mac had no checkout, `git_clone` refused there, and a raw `git clone` used the machine's own credentials (and waited on a permission prompt). Our proxy is the safer path on a person's machine too: only the agent's repositories, GitHub's token never leaves the server, revocable at once, pushes only to `agentes/<handle>/…`. So connected machines use it, without touching the machine's global git config.

**Credential.** The same `agtgit1` HMAC with `kind: "machine"` (`k: "m"`): `sandboxId` is the machine id and the generation is a number from the machine token's hash (`machineGitGen`). The proxy accepts it only while the machine is paired with that token (not deleted, not re-paired) and the agent still uses that machine (`agents.machine_id`); scopes and the repository list are checked live, as for cloud computers. Lifetime 6 h; a fresh one goes with every `git.sync`.

**Runner op `git.sync` (protocol 11).** The server sends the proxy base URL, the credential, the commit author and a list of `{ repo, dir, clone }` (default `repos/<owner>/<name>` in the agent's folder), plus `existing` (also every checkout already under `repos/`) and a deadline. The runner:
- writes the credential to `<runner home>/git/<agent id>.token` (mode 600, outside the agent's folder);
- clones with `git clone --filter=blob:none --progress` (progress streamed as `output` frames), git spawned with an argv, `GIT_TERMINAL_PROMPT=0`;
- sets each checkout's local config: `remote.origin.url` = the proxy URL, `credential.helper` reset (empty) then a helper that prints the token file, the agent as author, `push.autoSetupRemote`. Nothing global changes; no GitHub token is ever written;
- on an existing checkout: `fetch --prune`, then fast-forward the default branch (checked out and clean: `merge --ff-only`; on another branch: its ref only if it is an ancestor). Never a merge, never over local work;
- answers per repository: `cloned`, `updated`, `missing` (not cloned, not asked) or `failed` (offline, refused by the proxy…, with `head` when the checkout is there but stale). Only a bad request fails the whole op.
- *Hardened (2026-10-29).* `git.sync` and `mission.worktree` run without the "commands" switch, in repositories the agent's file ops can reach, so the repository never chooses a program for them: every runner git command gets `-c core.hooksPath=<null device> -c core.fsmonitor=false -c protocol.ext.allow=never -c safe.bareRepository=explicit`; before working in an existing checkout (or a mission's repository and worktree) its own config (local and worktree scopes, includes followed) may hold only data keys (remote, branch, user, credential helper, core basics…), else that repository fails with the key named (filter and diff drivers, `core.sshCommand`, `core.pager`, includes, `url.*.insteadOf`…); and the `write` op and secret files refuse any path in a `.git` folder or onto a `.git` file (`apps/server/runner/git-guard.ts`). The person's global and system git config are theirs and stay in effect. A task's end-of-item commit (ADR 0044) runs only with commands on and keeps running the repository's hooks.
Older runners drop unknown ops, so the server never sends `git.sync` below protocol 11 (`git_clone` tells the agent to update the app).

**`git_clone` on a connected machine.** Scope `github:git.read` only (no `sandbox:run`, no approval); the Tool Gateway checks the repository list as for every GitHub tool. Long timeout (30 min), progress as `agent.tool.output`. In a mission's thread it refuses: the mission has its own folder.

**Before each chat turn of a computer brain** (Claude Code, Codex; not missions): `prepareAgentCode` sends `git.sync` with the agent's explicit repositories (`clone: false`) and `existing: true`, bounded to 20 s; any failure leaves the turn as before. The turn's `cwd` becomes the checkout the conversation names (newest message first, `owner/name` or a bare name), else the agent's first repository, else its first checkout; the agent's folder stays reachable (`--add-dir`, Codex `writable_roots`). The runner carries the Claude Code session file to the new folder's project, so a conversation keeps its session when its folder changes. The "# Your code" block (`codePrompt`, `git/repos.ts`) lists the checkouts with their paths and default branches, the branch rule and `open_pull_request`, and the granted repositories not cloned yet ("call git_clone first; it needs no approval").

**Permissions of the brain.** Outside missions the turn's branch prefix is `agentes/<handle>/` (what the proxy accepts). `git clone <https url> [dir]`, `git fetch` and `git pull` whose target is inside the agent's folders count as read-only calls (no person asked, `readOnlyCall`), unless they carry options that run programs or read other config (`-c`, `-u`, `--upload-pack`, `--config`, `--template`…) or name local paths and `ext::`/`file:` transports. The deny list is unchanged: no push to the default branch, no force push, no `gh pr merge`, no deploys.

**Machine access (ADR 0036).** The checkouts live inside the agent's own folder, which the runner always allows; no folder is widened on the server's word. The token file is in the runner's home, which agents can't read through the file tools.
