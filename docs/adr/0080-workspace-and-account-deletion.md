# 0080. Deleting a workspace, and deleting an account

- Status: Accepted (built: the server; the web, desktop and phone screens and the Cloud's own services follow)
- Date: 2026-10-30
- Amends: ADR 0009 (author indexes on `messages`), ADR 0019 (the purge job, a deleted account's photos), ADR 0035 §5 (account deletion needs proof, and has a web page), ADR 0056 §4, §5, §8, §9, §10 (the deletion's fields, events and hold; a workspace being deleted is no computer request), ADR 0059 §1 (a deleted workspace's AI accounts), ADR 0073 §7 (what follows the pin), ADR 0079 §2 (`org.create_unpaid` and a workspace being deleted)
- Code: `packages/engine/src/workspace-deletion.ts`, `packages/engine/src/standing.ts` (`closedRefusal`, `workRefusal`, `openOrg`, `OrgDeletingError`), `packages/engine/src/organizations.ts` (`deleteAccount`, `removeMember`, `createOrganization`, `lockOrgMembers`), `packages/engine/src/machines.ts` (`personalMachines`), `apps/server/src/auth.ts` (`deletionProof`, `signInFreshUntil`), `apps/server/src/desktop-sign-in.ts`, `apps/server/src/routes/app/account.ts`, `apps/server/src/operator/standing.ts`, `apps/server/src/workers.ts`, `packages/db/migrations/0125_workspace_deletion.sql`

## Context

Nobody could delete a workspace. Deleting an account deleted the workspaces where the person was the only member at once, inside the request, with only a session cookie as proof: a stolen or unattended session wiped an account and its workspaces, machine included, in one call. The web app had no way to delete an account, though the Terms and the Privacy Policy point to Settings. Two ways around a stronger proof were open: a session could mint a fresh session (the phone's one-time token, the desktop app's redeem), and it could add a password to an account that had none and then present it.

A deleted workspace also left rows behind: tables with no foreign key to it (reactions, routing decisions, reflections, context usage), usage rows with no agent, and wiki links. "Closed" was a check on `suspended` repeated at a dozen entry points. Deleting a person or an agent scanned every partition of `messages`.

## Decision

### 1. Owners delete a workspace: it closes now and goes 7 days later

- **Who.** Any owner, never an admin. From Settings › General on the web and the desktop app, and from the onboarding, which is the way out of a workspace made by mistake. The phone's row opens that web page. The dialog asks for the workspace's name, typed or pasted, compared after NFKC normalization with Unicode format characters removed, trimmed and in any case, so a co-owner can't make it untypeable with invisible characters. The server doesn't take the name: the proof (§2) is its guard.
- **The route.** `POST /api/app/organizations/{orgId}/deletion` with `{ password? }` answers 202 `{ deletion: { dueAt } }`. It refuses anyone but a member (404 once the workspace is gone), then a suspended workspace (`org.suspended`), then anyone but an owner (`forbidden`). One already being deleted answers 202 with its date, before the proof and the daily limit, and nobody is told again. Then the proof, then at most 3 deletions of a workspace a day (`org-deletion:{orgId}`, 429), counted only once the proof passed.
- **At once, in one transaction** under the workspace's `org-members` lock, the role read again: a conditional update sets `deletion_due_at` to now plus 7 days (`WORKSPACE_DELETION_DAYS`), `deletion_requested_at` and `deletion_requested_by`, only while none is set, so two owners at once or a double click keep one date. A computer wait that isn't ready is dropped, as for a hold. The workspace's audit log gets `organization.deletion_scheduled` (`dueAt`, `via`), the operator's feed `organization.deletion_requested`, each member an email (§7), and the outbox `org.delete` at the date (no `org_id`, so the workspace's cascade leaves it; deduplicated per workspace and date).
- **After the commit:** the cached standing goes, members' apps hear `org.deleting` (`orgId`, `dueAt`, `by: { id, name }`) and the workspace's sockets close (4403), and its work stops (`stopOrgWork`): runs and computer tasks are canceled, its agents' desktops end, and a routine's run closes as `org_deleting`.
- **Every deletion takes the 7 days,** the onboarding's and an account's own workspaces (§10) included. There is no "delete now".

### 2. Proof that it's you

- Deleting a workspace or an account takes one of two proofs, for every account: **a sign-in in the last 10 minutes** (`DELETION_PROOF_FRESH_MS`), read from the database, since a cached cookie can't vouch for it; or **the password**, checked by Better Auth, at most 5 tries in 15 minutes per account (`deletion-proof:{userId}`, 429), counted before the check so a guess past the limit learns nothing. Without either: 403 `reauth.sign_in`; a wrong password: 403 `reauth.password`. An account without a password signs in again and comes back.
- **A session minted from another keeps that one's sign-in time:** the phone's one-time token when a session mints it, and the desktop app's redeem. One minted for the owner key (ADR 0066) starts fresh, since the key is a credential. The desktop hand-off's own 10-minute check now also means a real sign-in.
- **Adding a password** (`POST /api/app/me/password`) needs a sign-in in the last 10 minutes (403 `reauth.sign_in`), checked before `password_set`, so a session alone can't add a password and then present it.
- No emailed codes: a self-hosted server may send no email. Restoring needs no proof: it destroys nothing.

### 3. Closed is one predicate

- `closedRefusal(standing)` (`standing.ts`) is why a workspace is closed to its people: suspended (`org.suspended`, the operator's, which comes first), else being deleted (`OrgDeletingError`: 403 `org.deleting`, not retryable, `params.dueAt` while the date is ahead), else null. `workRefusal` adds holds; `closedOrg` and `openOrg` say the same in SQL for queries over `organizations`.
- It closes every permission check and channel access (every read and post), the socket's upgrade, subscriptions and close, desktop and terminal streams (closed with the reason `deleting`), browser hand-offs, brain settings, context tools, usage, the machine device check, invitations (sending, links, the logo on an invitation's page, and joining, which reads the row again under the `org-members` lock, so nobody gets in once a deletion committed), sign-ups through an invitation to it, and the work gate (`standingRefusal`: the Model Gateway, the hub, the executor, the judge and the router; a routine's slot is skipped as `org_deleting`). A refused run reads `run.org_deleting`, with nothing to contest. The onboarding doesn't resume it (`unfinishedWorkspaces`) and starts a new workspace, and a server's first account doesn't become its owner (`onUserCreated`).
- Only `GET /me`, restoring and leaving stay open.
- A test fails when code outside `standing.ts` compares a workspace's standing to a state.
- **A deletion is never a standing.** It lives in its own columns: setting a standing neither reads nor clears it, and the standing in `GET /me`, `org.standing` and the operator API doesn't carry it.

### 4. Restore, before the date only

- `DELETE /api/app/organizations/{orgId}/deletion` (204): any owner, with no proof. 409 `org.not_restorable` when it isn't being deleted or its date passed; `org.suspended` while suspended; `org.create_unpaid` (`params.orgId`) when it waits for its first plan and the person restoring owns another that does, under the same lock as creating a workspace (ADR 0079 §2); 404 once it is gone.
- Under the `org-members` lock it clears the three columns, writes `organization.deletion_canceled` in the audit log and the feed, and tells every member by email (§7). The operator's deletion hold (§5) is never touched. There is no broadcast: the closing screens ask `GET /me` again. Work canceled while it was closed stays canceled, and routines fire again at their next time.
- **The date is the point of no return,** by the database's clock: restoring works only before it and the purge only after it, so neither can undo the other.

### 5. Holds make the purge wait, and never refuse a deletion

- A workspace past its date is **kept** (`keptFromDeletion`) while it is suspended, on a hold that isn't billing's, or under the operator's **deletion hold**. Billing holds (ADR 0079) never keep one, `ended` included.
- Kept never refuses: an owner deletes a workspace under a trust hold or a deletion hold, it closes at once, and its purge waits until the hold lifts. Nothing the workspace reads says why: past its date `GET /me` gives `dueAt: null`, and the apps say only that it is being deleted.
- **The deletion hold** is `PUT /api/operator/v1/orgs/{orgId}/deletion-hold` with `{ held, reason? }` (ADR 0056 §9), set with a legal hold. It refuses nothing and tells the workspace nothing, and restoring never lifts it, so a workspace deleted again later still waits.

### 6. The purge: the `org.delete` job

1. It reads the workspace past its date that nothing keeps, and does nothing when it was restored, is kept or is gone.
2. **AI accounts leave its computers** (ADR 0059 §1): every one becomes a tombstone, and the purge waits up to 60 seconds for its online computers whose runner removes accounts. An offline computer keeps them, and its token dies with the workspace.
3. **Outside grants are revoked while their sealed copies still exist:** Composio forgets its mailboxes (their triggers, and the connected accounts, which revokes them at Google or Microsoft), and GitHub its OAuth grants, where the GitHub OAuth app is configured. A 404 counts as done, and each is marked as it goes, so a retry skips it. A failure fails the job, which retries; its final attempt goes on and logs the ids it couldn't revoke, never a token. GitHub App installations stay installed, as unbinding leaves them, and their cached tokens are forgotten. Other connectors' tokens, keys, IMAP passwords and database credentials go with their rows, since their providers can't be told.
4. **One transaction:** the `org-members` lock, the row `for update`, and the check again, so a hold that committed first wins. It deletes the workspace's rows from the tables nothing cascades to (`PURGED_BY_HAND`: `message_reactions`, `routing_decisions`, `thread_reflections`, `usage_records`, `wiki_links`, and `context_usage` through its runs), records `organization.deleted` (`userId`: who asked, null once their account is gone; `requestedAt`, and `via` from the workspace's own `organization.deletion_scheduled` row), queues the files' purge (ADR 0019), and deletes the row, which cascades.
5. **After the commit:** each of its computers gets `machine.revoke`, and the server logs `workspace deleted` (`orgId`, `requestedBy`, `via`), the only trace on a server without the operator API.

- **No orphans.** A test reads the migrated schema: every table with `org_id` cascades from its workspace (directly, or through a chain of cascading keys on columns never null), is in `PURGED_BY_HAND`, or is kept on purpose (`operator_events`, ADR 0056 §5; `organization_join_code_events`, gone after a day, ADR 0072). A new table that is none of these fails it.
- **The hourly sweep.** The workers' `deletions` tick, hourly and at boot, queues `org.delete` for every workspace past its date that nothing keeps, at most once an hour each: a hold lifted after the date, a job that failed for good, one a deploy lost.

### 7. What people see and are told

- `GET /me` adds, while a workspace is being deleted, `organizations[].deletion: { dueAt, requestedAt, requestedBy: { id, name } | null }`, with `dueAt` null once the date passed.
- The apps show a closing screen in place of the workspace, after the suspended one, which is the stronger fact: who deleted it and when, when it goes for good, Restore for owners before the date (members read that only an owner can restore it), their other workspaces and Sign out. The socket is closed, so the screen asks `GET /me` again every 30 seconds and on focus: a restored workspace opens again, and a deleted one leaves the list.
- **Emails,** only where the server sends email, each queued with no `org_id` so the cascade leaves it (ADR 0069: our words in the subject and the buttons, the workspace's and the deleter's names inert in the body):
  - `workspace_deleting`, one per member (blocked accounts aside), with the date and time in the member's time zone, else the workspace's. Owners get a button to restore it, the others read to ask an owner. Never for an account's own workspaces, which `account_deleted` names.
  - `workspace_restored`, one per member.
  - No email at the purge, and no notification or push: the workspace is closed, and the screen and the email carry it. People with pending invitations or requests to join aren't written to: an invitation link reads as closed and accepting an invitation is refused, and after the purge neither is found.

### 8. The workspace's computers

- **Self-hosted**, at the purge: AI sign-ins leave online computers first, then every computer gets `machine.revoke`, and its runner stops for good and says it was removed. The agents' folders and OS users stay until the runner is uninstalled, as when a computer is removed. The server's own computer loses that workspace's row, and its next sync drops it.
- **External provisioning** (ADR 0056 §10): a workspace being deleted is no computer request. On agentes.chat Cloud the operator's services read the feed: they hold the machine during the 7 days as they hold one whose plan ended (its runner and agents stopped, its network cut, its disk kept), so a restore is whole; they release at once a machine still being prepared; they bring it back at a restore; and they release it at `organization.deleted`.

### 9. Files, search, early access, billing and audit

- **Files:** platform storage through `org.files.purge`, two passes (ADR 0019); files in the database cascade. A workspace's own bucket is left alone, and the dialog says so. Photos are per person and stay.
- **Search** is Postgres only, so it cascades. A search backend that keeps text outside Postgres must drop the workspace in the purge, before its row goes.
- **Early access:** the invitation's workspace goes null at the purge, and the allowance stays, so the person can make a new workspace.
- **Billing:** the server keeps no billing state. A billing service reads the three events: on agentes.chat Cloud the plan stops renewing at the request, renews again at a restore, and is canceled after `organization.deleted`. Nothing is refunded, and the dialog says so where `billingUrl` is set.
- **Audit:** the workspace's log keeps `organization.deletion_scheduled` and `organization.deletion_canceled` until it goes; the operator's feed keeps the three events for 90 days; the server's log keeps the line of the purge.

### 10. Deleting an account

- **Where.** "Delete account" in the account menu on the web and the desktop app, and on the phone's account page, native, as the stores require. Both read the preflight, `GET /api/app/account/deletion`: `{ password, freshUntil, closes, leaves, soleOwner, computers, staysBehind, serverOwner }`, which the page shows before anyone confirms: blockers with the way out of each, or what closes, what they leave, the computers removed, what stays behind, that their messages stay without their name, and the proof.
- **`DELETE /api/app/account`** takes an optional `{ password }` and answers 204 with the session cookies expired. It refuses, in order: the only owner of a workspace with others in it that isn't being deleted (409 `sole_owner`, `params.organizations` with the names and `orgIds`; checked again under the locks), the proof (§2), and a blocked account (403). Make someone else an owner, or delete that workspace, and it no longer blocks.
- **In one transaction**, under every workspace's `org-members` lock in a fixed order, writing every workspace row before the user row, as the purge does (`accountDeletionPlan` reads what follows):
  - workspaces only they are in close as in §1 (`via: "account"`), whatever their standing: a hold makes their purge wait, never the account. One already being deleted keeps its date;
  - their AI accounts on every computer become tombstones before the user row goes (ADR 0059 §1), and every workspace's computers hear it, left and closing;
  - each workspace they leave records `member.left` with `accountDeleted: true`;
  - their personal computers in the workspaces they leave are removed (§11);
  - the `account_deleted` email, queued before the user row because it needs their address, language and time zone: the workspaces it closed and their date, and whom to write to if it wasn't them (`SUPPORT_EMAIL`, else the people who run the server);
  - the user row, and with it their sessions on every device, sign-in methods, phones, memberships, channel memberships, notifications and requests to join;
  - the pinned owner's Jev key, and the pin once no account is left (ADR 0073 §7), `user.deleted` in the feed, and `user.files.purge` for their photos (ADR 0019).
- **After the commit:** `membership.revoked` in every workspace closes their sockets, each workspace that closed is announced and its work stops, the removed computers are told, and Apple's tokens are revoked (ADR 0035).
- **Stays:** messages and records they wrote, without an author (Privacy Policy §4); audit rows that name them; agents they were responsible for, with no responsible person; routines they made, which pause at their next firing (`creator_left`); the keys, connections and mailboxes they added, which are the workspace's, listed in the preflight so they can disconnect one first; the feed (90 days); the waiting-list entry and the early-access invitation, whose row keeps the address out of the next batch of invitations.
- **Their other tabs and devices.** A cached session cookie outlives the account for up to 5 minutes: `GET /me` answers 401 and expires the cookies once the user row is gone, and creating a workspace locks the user row and answers 401 for a missing one.
- **The pinned owner may delete their account** (ADR 0073 §7). The preflight says the server's own settings will then have no owner here, only in its environment (`serverOwner`). Until no account is left, the owner key signs in nobody and the server's own computer serves no workspace.

### 11. A person's own computers leave with them

When a person leaves a workspace, is removed from it or deletes their account, the computers they connected there go with them (`personalMachines`: `connected` computers they paired, not in system mode), removed as any computer is: their agents are left with no computer, the runner hears `machine.revoke`, and the audit row names who left or who removed them. Every agent there runs as that person's OS user (ADR 0058), so nobody else's agents may go on running as a former member. A system-mode computer is the team's server and stays, and the server's own computer and a managed one are nobody's. Their AI accounts become tombstones first (ADR 0059 §1).

### 12. Limits

3 deletions of a workspace a day, 5 password tries in 15 minutes per account, and 10 new workspaces a day per person (`POST /api/app/organizations`, 429, every request counted), so a loop of deleting and restoring can't email everyone all day, and one of creating and deleting can't churn the Cloud's computers.

### 13. Data

One migration, `0125_workspace_deletion`: `organizations.deletion_due_at`, `deletion_requested_at`, `deletion_requested_by` (a user, set null when that account goes), `deletion_hold_at` and `deletion_hold_reason` (the operator's own, never shown), with no backfill and no index, since the sweep reads a small table; and the two author indexes on `messages` (ADR 0009).

## Consequences

- Every deletion can be undone for 7 days by any owner, and evidence outlives a deletion for as long as an operator holds it. Nobody gets a "delete now".
- People lose a deleted workspace at once, and nothing in it keeps working or spending meanwhile.
- A stolen session proves nothing by itself: it can't delete, mint a fresher session or add a password.
- Old phone builds send no password. They still delete within 10 minutes of a sign-in and otherwise show their generic failure, so the phone build that asks for the proof ships with this server.
- A hold that lands after the purge removed sign-ins and revoked grants keeps a workspace that lost them: its date had passed.
- A workspace goes in one cascading delete, under the job's renewed lease. Batch it by table if a very large one ever outlives the lease.
- Rolling the server back during a grace reopens closing workspaces (older code ignores the columns), and older workers fail `org.delete`, `user.files.purge` and the new emails for good. After the next deploy the hourly sweep finishes the purges; the emails queued meanwhile are lost.
- A workspace made in another tab at the very moment its owner's account is deleted is left with no member, and isn't closing.
- Support cases have no operator route: a blocked account, the only owner of a suspended workspace with others in it, and erasure requests are handled by hand.

## Alternatives considered

- **Deleting at once, or a shorter window for an empty or unfinished workspace.** No runs doesn't mean no content, and people delete the wrong workspace alone too. One rule and one constant keep trust's window everywhere.
- **Readable during the 7 days.** Closed reuses the suspension's enforcement, needs no read-only mode, and stops all work and spending.
- **A grace for accounts too.** With the proof a stolen session can't delete an account, Apple prefers an account deleted at once, and the account's own workspaces get the grace anyway.
- **An emailed code as proof.** A self-hosted server may send no email; the password or a fresh sign-in works everywhere.
- **A column for the last real sign-in.** Keeping the source's sign-in time on a minted session gives the same guarantee, without a column or a hook on every sign-in.
- **A hold that refuses the deletion.** It would tell the workspace about a silent hold. Making the purge wait keeps the evidence and says nothing.
- **A column for "being purged".** Making the date the point of no return gives the same guarantee.
- **Disconnecting what a person added when they go.** Keys, connections and mailboxes are the workspace's, and removing them would break the team's agents.
- **Deleting a person's messages with their account.** They are the workspace's record; the dialog says they stay without the name.
- **A hand-over of the server's ownership, or refusing the pinned owner.** ADR 0073 §7 lets the owner go with the environment keeping control; a hand-over waits until self-hosters ask for one.
- **Operator routes to delete or restore workspaces and delete accounts.** By hand until the first real request.
- **Deleting abandoned onboardings after a while.** Not now: where new workspaces wait for their first plan, one waiting is no computer request (ADR 0079 §2), so one left behind costs little.
- **Checking the typed name on the server.** The proof guards the server; the name only stops a wrong pick in the one app that deletes.
