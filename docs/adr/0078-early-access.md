# 0078. Early access: a live sign-up mode and invitations to sign up

- Status: Accepted (built: the server, the operator API, the email, the web's sign-up page and the shared client; the Cloud's console calls it)
- Date: 2026-10-29
- Amends: ADR 0006 (the sign-up policy), ADR 0056 (the operator API gains sign-up, the waiting list and invitations), ADR 0068 (only an email invitation opens sign-up: an early-access link does too, for the address it was sent to)
- Code: `packages/engine/src/early-access.ts`, `packages/engine/src/organizations.ts` (`signupAdmission`, `needsWorkspaceAllowance`, `canCreateWorkspace`, `createOrganization`), `packages/db/src/schema/early-access.ts`, `apps/server/src/auth.ts` (the hooks), `apps/server/src/operator/access.ts`, `apps/server/src/routes/app/account.ts`, `apps/web/src/pages/AuthPage.tsx`, `apps/web/src/routes/signup.tsx`

## Context

Who may sign up was decided by `ALLOW_SIGNUP`, an environment variable, so opening or closing sign-up meant a restart. After the first account, everyone else needed a workspace invitation, which puts a person in someone else's workspace and never gives a newcomer one of their own. The waiting list, whose addresses are also contacts at the email provider, had an `invited_at` column that nothing set.

On agentes.chat Cloud every workspace gets a computer someone pays for (ADR 0056 §10), and nothing bills yet. Letting a person in costs money, so it has to be deliberate, in batches the people who run the Cloud choose, and visible as it happens.

## Decision

### 1. A live sign-up mode

`signup_settings` (one row for the installation, no `org_id`) holds `invite` or `open`; no row reads as `invite`. The operator API changes it with no restart. `ALLOW_SIGNUP=true` still forces sign-up open whatever the mode says, and a server that is its agents' computer (`HOST_COMPUTER_TOKEN`) refuses `open` (409 `signup.host_computer`); a mode saved as `open` before the token was set opens nothing there, and `GET /signup` shows `invite`. Self-hosted servers see no change: without the operator API the mode stays `invite`.

`signupAdmission` decides a sign-up, in this order: `ALLOW_SIGNUP` with no owner link or key waiting; the first account (unless an owner link or key makes it); `ALLOW_SIGNUP`; the mode `open`; a pending workspace invitation for the address; an early-access link for the address. `isSignupAllowed` is `signupAdmission(…) !== null`. `auth-config.signupOpen` and `/api/instance` `signup` read the mode live.

### 2. Early-access invitations

`early_access_invitations` (no `org_id`): one row per address, in its stored form (`trim().toLowerCase()`, at most 254 characters, `z.email()`, the same rule as sign-up), matched exactly, so plus tags, Gmail dots and Apple's relay addresses are other addresses.

- **The link** is `/signup?email=<address>&access=<token>`: 32 random bytes (43 base64url characters). Only its SHA-256 is stored, behind a unique index. The token is only in the email and its outbox row, whose payload goes after 30 days like every job's. No API returns it and nothing logs it.
- **The email** (`early_access`, ADR 0069's layout, pt-BR or English) is queued in the same transaction as the invitation, keyed `early-access:<id>:<sends>`. Its language is the invitation's, else the waiting list entry's, else the request's, else pt-BR.
- **Expiry** is 14 days after the latest send, and limits sign-up only: an account made in time stays allowed (§4).
- **Inviting an address again** sends the same invitation a new token (the old link stops at once), one more send, 14 days from now, and clears a revocation. There is never a second row. Within 2 minutes of the previous send nothing goes out (`recent`), so a retry or a double submit mails once; one conditional upsert claims the send, so two calls at once send one email. A used invitation is never sent again (`signed_up`).
- **An address that already has an account** gets no link. Inviting it, inviting it as one of the waiting list's next, or resending its invitation allows that account instead (`allowed`): the invitation, made then if there was none, is bound to the account and used at once, and a short email (`early_access_allowed`, in the account's language, else the order above) says it can now make its own workspace, with a link to the app. One conditional upsert claims it, so two calls at once allow and mail once. The resend answers the invitation, now `signed_up`, with `sent: false`.
- **Revoking** clears the token, so an unused link stops working, and stops its account from making more workspaces (§4); the ones it made stay. It always works.
- **State**, the first that holds: `revoked`, `workspace_created` (its account made at least one), `signed_up` (its account exists: made with the link, or allowed), `expired`, else `sent`.

### 3. Who the link lets in

The token travels as `access` on `POST /api/app/sign-in-options`, as the `x-early-access` header on `POST /api/auth/sign-up/email`, and in a provider sign-in's state as `additionalData.earlyAccess` (read back on the callback with `getOAuthState()`). It is untrusted input in every case: only the token's shape is kept, and the rule checks the rest. The phone's native sign-in and the Mac app's borrowed browser don't carry it: the email's link opens the web.

An invitation is looked up only by its token's hash, never by address. Without a token no query reads the table, so an invited address answers, and takes the same time, like any other. `sign-in-options` says `accessExpired` only for the link's own address.

The refusals: a link for another address is 403 `EARLY_ACCESS_OTHER_EMAIL` (naming no address); a provider that hasn't verified the address is 403 `EARLY_ACCESS_EMAIL_UNVERIFIED` (Google's and Apple's `email_verified`, GitHub's verified primary address); anything else is 403 `SIGNUP_CLOSED`, the same answer for an invited address without its link as for any other. A provider's refusal comes back to `/login?error=<code>`, which it does only for a refusal with a code.

After the account is committed, a sign-up that carried the token uses the invitation while its link hasn't expired: `used_at`, `user_id`, and the token is cleared, for the invited address only, and never for a provider's unverified address. An account let in another way (open mode, a workspace invitation) with an expired link takes nothing from it. A failure is logged and never fails the sign-up. An account made without the token (open mode, a workspace invitation) never uses one, until its address is allowed (§2). Deleting the account keeps `used_at` and nulls `user_id`, so neither the link nor the allowance comes back.

### 4. Who makes workspaces on agentes.chat Cloud

On agentes.chat Cloud, where every workspace gets a paid computer (`MACHINE_PROVISIONING=external` at an agentes.chat `PUBLIC_URL`), while sign-up is by invitation (no `ALLOW_SIGNUP`, the mode `invite`), only an allowed account makes workspaces: one an early-access invitation is bound to (used, not revoked), or the installation's pinned owner (ADR 0073). There is no count: an allowed account makes as many as it likes. An account that isn't allowed, such as someone who joined a teammate's workspace through a workspace invitation, makes none until its address is allowed (§2) or sign-up opens; `createOrganization` refuses it with 403 `org.create_invite_only` before anything is made. `/api/app/me` says `user.canCreateWorkspace` by the same rule; the web hides New workspace and the onboarding says why when it is false. Revoking the invitation stops further workspaces and leaves the ones made.

An allowed account's first workspace is recorded on its invitation (`workspace_created_at`, `workspace_id`) in the workspace's own transaction, set only while still empty, so two creations at once both go ahead and the first recorded stays. Everywhere else the record still runs, so the console sees which workspace an invitation led to. Open mode, `ALLOW_SIGNUP` and a self-hosted server, with a provisioner of its own or none, aren't held to the rule.

### 5. The waiting list

The operator API imports addresses as confirmed entries (`source = 'import'`, deduplicated, up to 5,000 a call, `joinedAt` kept or else the list's own order), counts the list against invitations, and reads the next confirmed entries still waiting (no invitation in any state), oldest first. An address that has an account waits like any other: inviting it allows the account (§2). "Invite the next N" is that read followed by inviting exactly those addresses, so a retry of either never invites more than was shown, and it answers the same outcomes as any invitation. The first invitation sets `waitlist_entries.invited_at`. Imported entries never go to the email provider's contacts (at import, at boot or in `waitlist.contact`): they came from there, and a sync would overwrite their properties.

### 6. The operator API

Under `/api/operator/v1`, behind `OPERATOR_API_TOKEN` like the rest (ADR 0056): `GET`/`PUT /signup`, `GET /waitlist`, `GET /waitlist/next`, `POST /waitlist/import`, `POST`/`GET /early-access/invitations`, `POST /early-access/invitations/{id}/resend` and `/revoke`. Every call is safe to repeat. A server that sends no email refuses invitations (409 `early_access.no_email`).

## Consequences

- Opening sign-up on agentes.chat Cloud is a switch in the console. Invitation-only bounds who makes workspaces, not how many: the provisioner's pool, not the invitation, bounds new computers, and a workspace waits (`capacity`) once the pool is full (ADR 0056 §10).
- The waiting list moves to production as a CSV, without touching its contacts.
- On a new database whoever signs up first is the installation's owner, exempt from §4: set `OWNER_CLAIM_SHA256`, or sign up before the address is public.
- A member who needs their own workspace before sign-up opens gets it by allowing their address from the console (`allowed`). Early-access sign-up in the phone and Mac apps, and treating plus or dot variants as one person, are left out until they are needed.
