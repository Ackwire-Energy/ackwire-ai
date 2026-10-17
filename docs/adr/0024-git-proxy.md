# 0024. Git in the agents' computers through our proxy (the token never enters the machine)

- Status: Accepted
- Date: 2026-10-15
- Planning: D35

## Decision

Agents use real `git clone/commit/push` against private repositories from their computer (D30), but GitHub's credential stays on our server. The computer talks smart-HTTP git to **our** endpoint, which checks policy and forwards to GitHub with the org's token added server-side.

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
- Optional repository list (`agent_repositories`, D48): `owner/name` or `owner/*`, in order. When an agent has any, only those repositories work, here and in the Tool Gateway for every GitHub tool (reads included). It replaced the `github:git.repo:…` grants (migration 0063).
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
