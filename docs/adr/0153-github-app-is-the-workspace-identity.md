# 0153. The GitHub App is the workspace's GitHub identity

- Status: Accepted
- Date: 2026-11-07
- Amends: 0033 (the app is a connection by itself, removing an installation uninstalls it, the panel reconciles),
  0024 (the proxy's upstream permissions), 0116 (agents' commits are the app's bot's)
- Code: `packages/engine/src/git/github-app.ts` (tokens by permission sets, `installationToken`, `botIdentity`,
  `uninstallInstallation`, `installationStatus`), `github-app-installs.ts` (binding, removal, reconcile, webhook),
  `github-app-settings.ts` (the server's app: env or made with GitHub's manifest flow, the manifest, its state),
  `github-call.ts` (`githubCallAuth`, `githubListingHeaders`, `appPermissionsFor`), `signature.ts`;
  `connectors/connections.ts` (`syncGitHubAppConnection`, `GITHUB_APP_AUTH`, `revokeConnection`), `connectors/mcp.ts`,
  `connectors/catalog.ts` (`sign`); `git/machine.ts` (bot author, the turn's credit line), `git/proxy.ts`, `git/tools.ts`;
  `apps/server/src/routes/github-app.ts`; migration 0246

## Context

In a shared workspace GitHub was connected by one person (an OAuth app, or a pasted token), so every agent opened pull
requests, issues and comments as that person: a member's agents wrote with another member's account. ADR 0033 had
built a public GitHub App, but only the git proxy, direct fetches and four of our own tools used its tokens, and only
next to a person's connection. GitHub's MCP tools, which do most of the writing, always went as the person.

## Decision

1. **Where a workspace's installation of the app covers what a GitHub call names, the call goes as the app.** Every
   GitHub MCP tool call asks for its token per call (`githubCallAuth`): one repository named, a token for that
   repository alone with the permissions of the tool's scope (`appPermissionsFor`); an account, or several
   repositories of one account, the installation's token; nothing named, the workspace's connection. Our own tools,
   proxy pushes and fetches already did. Pull requests, issues, comments, reviews, merges and API commits then come
   from `<slug>[bot]`. Where no installation covers the call, the workspace's account connection is used, as before.
   Permission sets are asked most first: a push asks for `workflows: write` and falls back to contents alone on an
   installation that lacks it; `actions.run` asks for `actions: write`, which the app isn't granted, so GitHub refuses
   and the account runs it. Projects never go through the app (GitHub Apps can't reach a person's Projects).
2. **The app alone is a GitHub connection.** Binding a workspace's first installation without a GitHub connection
   makes one (`auth_type = github_app`, no secret, the installations' accounts as `account_label`), every agent's
   like any first connection, so grants, "Aprovar sempre", the proxy URL, repository lists and approvals work
   unchanged. Its tools are listed with an installation's token; Projects' are hidden. Connecting an account later
   replaces it (grants and rules move, as on Reconectar). Disconnecting an account while installations remain keeps
   the row as the app alone (same id, secret cleared, the token still revoked at GitHub); disconnecting the app alone
   unbinds every installation and uninstalls them. The last installation unbound ends it, as disconnecting does.
3. **Signature.** Every body an agent writes to GitHub ends with one line, in the workspace owner's language, naming
   the agent and the person it works for (who asked, a routine's creator, else the agent's responsável; members only):
   "Theo, agente de Ana no agentes.chat", inside `<sub>` after the marker `<!-- agentes.chat -->`, names escaped so
   they never mention or link anyone. An edit replaces everything from the marker on. It is added whichever token the
   call goes with, when the call runs: approval cards show the agent's own words. The tools that sign say so in the
   catalog (`sign`); a pull request without a body gets the line alone.
4. **Commit credit.** Commits credit the person (`Co-authored-by: Name <id+login@users.noreply.github.com>`) only when
   they linked GitHub to sign in: the id from that sign-in, the login GitHub has for it now (cached for a day). Never
   their email; no linked account or no answer, no trailer. API commits (`push_files`, `create_or_update_file`) get it
   in their message; on agents' computers each turn says it next to where the turn starts.
5. **Agents' computers.** With an installation bound, commits are authored as `{agent} (agentes.chat)` at the bot's
   noreply address, so GitHub shows them as the app's; pushes already went through the proxy with the app's token.
   Fetch tokens stay read-only. No token is handed to `gh` (below).
6. **The server's own app.** `GITHUB_APP_*` win. Without them the server's pinned owner, never on agentes.chat, creates
   the app from Settings with GitHub's manifest flow: a server page posts the manifest (the same permissions and
   addresses, from `PUBLIC_URL`; the webhook off without https) to GitHub, which creates the app under their account
   and returns a code; `POST /app-manifests/{code}/conversions` gives its id, slug, client id and secret, private key
   and webhook secret, kept sealed in `instance_secrets` (`github_app`, AAD `instance-secret|github_app`, the slug as
   hint) and read again a minute after the last read. The flow is bound to the owner's session: a leaked state with
   someone else's code can't plant their app. The owner's account deletion removes it, like the Jev key.
7. **Remove means uninstall.** Removing an installation from a workspace also uninstalls the app from that GitHub
   account (`DELETE /app/installations/{id}`, best effort; the response says when GitHub didn't).
8. **No webhook needed.** Reading the panel asks GitHub about each installation, at most once a minute per
   workspace: uninstalled there, it is unbound as `installation.deleted` does; otherwise its account, selection and
   suspension are refreshed. The webhook still works when set up.

## Consequences

- An agent's writing on GitHub says whose agent it is, on repositories the app doesn't cover too.
- One GitHub account's installation still belongs to one workspace (ADR 0033); a second one is refused with
  `other_workspace`.
- Branch protections that restrict who may push or merge must allow the app.
- Display names are public in signatures on public repositories.
- The remote MCP server must accept installation tokens (github-mcp-server#1610, fixed 2025-12-17): checked with one
  real call before the Cloud turns it on.

## Not done

- **`gh` as the bot.** It would need a token with pull requests and issues but never contents (which would let a push
  skip the proxy), one installation per turn (gh takes one token per host), a way to hand it over without an
  environment variable (the agent user's own `hosts.yml`, system mode only), an optional `gh` field in `git.sync` with
  a protocol bump, and it could never be signed. Brains already reach the signed tools through the bridge.
- Assigning the pull request to the person, and listing repositories per installation in searches.
- A `prepare-commit-msg` hook for the computer's credit, if the instruction proves unreliable.
