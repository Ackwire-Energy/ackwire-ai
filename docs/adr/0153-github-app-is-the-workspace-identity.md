# 0153. The GitHub App is the workspace's GitHub identity

- Status: Accepted
- Date: 2026-11-07
- Amends: 0033 (the app is a connection by itself, removing an installation uninstalls it, the panel reconciles, only
  an installation made from agentes.chat links),
  0024 (the proxy's upstream permissions), 0116 (agents' commits are the app's bot's)
- Code: `packages/engine/src/git/github-app.ts` (tokens by permission sets, `installationToken`, `botIdentity`,
  `uninstallInstallation`, `installationStatus`, `installationOrigin`), `github-app-installs.ts` (binding, removal,
  reconcile, webhook),
  `github-app-settings.ts` (the server's app: env or made with GitHub's manifest flow, the manifest, its state),
  `github-call.ts` (`githubCallAuth`, `githubListingHeaders`, `appPermissionsFor`), `signature.ts`;
  `connectors/connections.ts` (`syncGitHubAppConnection`, `GITHUB_APP_AUTH`, `revokeConnection`), `connectors/mcp.ts`,
  `connectors/catalog.ts` (`sign`); `git/machine.ts` (bot author, the turn's credit line), `git/proxy.ts`, `git/tools.ts`;
  `apps/server/src/routes/github-app.ts`; migration 0246; screens: `packages/client/src/lib/github-app.ts` (what the
  panel shows, shared by the web and the phone), `apps/web/src/components/GitHubAppPanel.tsx` (the panel and the
  server's app card), `ConnectFlow.tsx`, `Connectors.tsx`, `apps/mobile/src/features/connectors/GitHubApp.tsx`

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
   installation that lacks it; `actions.run` asks for `actions: write`, which an installation that hasn't accepted it
   yet refuses, and the account runs it. Projects never go through the app (GitHub Apps can't reach a person's
   Projects).
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
   they never mention or link anyone. An edit takes our earlier line out (the marker on a line of its own and the
   line under it), nothing else: a signed comment quoted in a reply stays the reply's text. It is added whichever
   token the call goes with, when the call runs: approval cards show the agent's own words. The tools that sign say so in the
   catalog (`sign`); a pull request without a body gets the line alone.
4. **Commit credit.** Commits credit the person (`Co-authored-by: Name <id+login@users.noreply.github.com>`) only when
   they linked GitHub to sign in: the id from that sign-in, the login GitHub has for it now (cached for a day). Never
   their email; no linked account or no answer, no trailer. API commits (`push_files`, `create_or_update_file`) get it
   in their message; on agents' computers each turn says it next to where the turn starts, for the person behind the
   turn's run as the signature names them.
5. **Agents' computers.** With an installation bound, commits are authored as `{agent} (agentes.chat)` at the bot's
   noreply address, so GitHub shows them as the app's; pushes already went through the proxy with the app's token.
   Fetch tokens stay read-only. No token is handed to `gh` (below).
6. **The server's own app.** `GITHUB_APP_*` win. Without them the server's pinned owner, never on agentes.chat, creates
   the app from Settings with GitHub's manifest flow: a server page posts the manifest (agentes.chat's own app's
   permissions, write on actions, checks, contents, issues, pull requests, commit statuses and workflows and metadata
   read; its addresses from `PUBLIC_URL`; the webhook off without https) to GitHub, which creates the app under their
   account and returns a code; `POST /app-manifests/{code}/conversions` gives its id, slug, client id and secret,
   private key and webhook secret, kept sealed in `instance_secrets` (`github_app`, AAD `instance-secret|github_app`,
   the slug as hint) and read again a minute after the last read. The flow is bound to the owner's session: a leaked
   state with someone else's code can't plant their app. The owner's account deletion removes it, like the Jev key.
7. **Remove means uninstall.** Removing an installation from a workspace also uninstalls the app from that GitHub
   account (`DELETE /app/installations/{id}`, best effort; the response says when GitHub didn't). Deleting the
   workspace uninstalls its installations with its other outside grants (`org.delete` retries one GitHub refused).
   A personal account's installation binds only for that account itself: collaborators on its repositories see it in
   `GET /user/installations` too.
8. **No webhook needed.** Reading the panel asks GitHub about each installation, at most once a minute per
   workspace: uninstalled there, it is unbound as `installation.deleted` does; otherwise its account, selection and
   suspension are refreshed. The webhook still works when set up; a suspension event follows what GitHub says of the
   installation then, so a delivery sent again later changes nothing. A repository change made on GitHub's own page
   comes back without our state and lands on the web app with nothing to finish.

9. **The app first, in every place GitHub is connected.** Where the server has the app, connecting GitHub (Settings ›
   Conectores, an agent's connect card, the phone's sheet) offers **O app agentes.chat** (recommended) before **Uma
   conta do GitHub**, which stays for what the app can't reach (GitHub Projects). **Repositórios do GitHub** lists each
   account the app is installed on with its reach, **Gerenciar no GitHub** (GitHub's page of the installation, where
   its repositories are picked) and **Remover** (asked first, it uninstalls, and says when GitHub didn't confirm,
   with its page as the way out); a workspace using an account sees who agents act as today. GitHub through the app
   alone has no Reconectar and offers **Conectar uma conta do GitHub**; Desconectar says what happens to the app. The
   phone does the same: the install opens GitHub in the browser and comes back to the app, which finishes it. The
   server's own app is a card for its pinned owner (`setup`), made in the web's browser session; the other admins
   are told the owner can make it (`ownerCreates`, false on agentes.chat).

10. **Only an installation made from agentes.chat links.** Seeing an installation proves little:
    `GET /user/installations` shows an organization's installation to every member who can read one of its
    repositories, so a read-only member could link one made on GitHub itself (or kept there when its uninstall was
    refused) to their own workspace and write to every repository it covers. A new link therefore also needs GitHub's
    own word on the installation (`GET /app/installations/{id}`, signed as the app, `installationOrigin`): made at or
    after the install's state was issued (`oauth_states.created_at`, two minutes allowed for the clocks and GitHub's
    whole seconds), on the account the person sees. `setup_action=update` (an existing installation whose
    repositories changed) only refreshes one already linked to this workspace, never links one. Anything else is
    refused as `github_app.installed_outside` (`github_app_error=installed_outside`), whose words give the way out:
    remove the app on GitHub and install it again from Conectores › GitHub. An install that comes back without a
    state of ours (started on GitHub's own page, or approved there) is told the same. The phone's return doesn't carry
    `setup_action`, so there the creation time alone decides, which already refuses every installation older than
    the state.
    - **Why not Members: read.** The other way was to ask GitHub for the organization permission Members (read) and
      link only for an owner of the organization. Every installation would have to accept a new permission before it
      linked, and a role says who may install, not that this installation was meant for this workspace. The state,
      issued to this person in this workspace minutes before GitHub made the installation, says exactly that, with no
      new permission, and it covers personal accounts and refused uninstalls the same way.
    - **The request flow.** A member without rights on the account asks its owner (`setup_action=request`). The owner
      approves later on GitHub, after the member's state expired, so that installation is older than every state and
      never links: an owner starting the install from agentes.chat is shown the existing installation and refused. The
      account's owner installs from Conectores › GitHub in the workspace instead (as one of its admins), after
      removing an installation already approved on GitHub. The member's notice says who installs it and where.

## Consequences

- An agent's writing on GitHub says whose agent it is, on repositories the app doesn't cover too.
- One GitHub account's installation still belongs to one workspace (ADR 0033); a second one is refused with
  `other_workspace`.
- An installation made on GitHub itself never links, configured from agentes.chat or not (ADR 0033 bound it then): it
  is removed on GitHub and installed again from agentes.chat. So is one whose uninstall GitHub refused, or one approved
  from a request.
- The server's clock must stay within two minutes of GitHub's, or fresh installations are refused as made outside.
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
