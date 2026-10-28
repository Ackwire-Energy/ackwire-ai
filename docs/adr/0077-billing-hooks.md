# 0077. Billing hooks: billing holds, limits and a signed link

- Status: Accepted
- Date: 2026-10-27
- Extends: ADR 0002 (the core knows no plans), ADR 0056 (operator API, standing, external provisioning)
- Code: `packages/engine/src/standing.ts` (`BILLING_HOLDS`, `setBillingHold`), `packages/engine/src/organizations.ts` (`createOrganization`, `manage_billing`), `packages/engine/src/billing-link.ts`, `packages/engine/src/limits.ts`, `apps/server/src/routes/app/billing.ts`, `apps/server/src/operator/limits.ts`, `packages/client/src/lib/billing.ts`, `apps/web/src/components/BillingLinkButton.tsx`, `apps/web/src/routes/org.$orgId.onboarding.tsx`

## Context

Whoever runs an instance for paying customers (agentes.chat Cloud is one) needs four things from the server: a workspace that hasn't paid has to stop its agents, what a plan includes (people, files, the platform's own AI) has to be enforced, its owners need a way to pay, and none of it may change a self-hosted server. ADR 0002 rules out plans, prices or a payment processor inside the server process: a separate billing service owns them, and the operator's own services apply its decisions through the operator API (ADR 0056 §7, pulled, never pushed).

ADR 0056 already gives every hook but one: a hold stops a workspace's agents and keeps its people reading and writing, which is exactly what an unpaid workspace needs. What it lacks is a way to tell a hold for payment apart from a hold for review (they must never undo each other, and people must read different words), numbers to enforce, and a way into the billing service that proves who is asking.

## Decision

### 1. Billing holds are standing holds with a code

- A **billing hold** is a `hold` with the notice `shown` whose reason is one of three codes: `payment` (no plan yet), `unpaid` (its payment failed) and `ended` (its plan ended). Every other hold, and every suspension, is a **trust hold**.
- They stop exactly what any hold stops (ADR 0056 §8): the Model Gateway, new computer work, the judge and the router, routines and invitations. People still read and write, and a held workspace is never a computer request (ADR 0056 §10).
- They are set and lifted only through `PUT /api/operator/v1/orgs/{orgId}/billing-hold` with `{ hold: payment | unpaid | ended | null }`, which answers `{ applied, standing }`. It never replaces nor lifts a trust hold or a suspension (`applied: false`, as when it is already so), while a hold set through `PUT …/standing` replaces a billing hold as it replaces any hold: the billing service puts its own back once the trust hold is lifted. A hold set there with one of these reasons and the notice shown reads as a billing hold, so the operator's own tools leave the codes to the billing service.
- `setBillingHold` writes through the same path as `setOrgStanding`, in one transaction on the workspace's locked row: the audit row, the dropped computer wait, the `org.standing` event, the cache and the notification to owners and admins on a move. The notification carries the code (`latest.billingHold`) in place of a reason, and every app says each code in the person's words (`standing.billing.*`), never as it comes.

### 2. Creating a workspace

- Billing holds on a person's workspaces never stop them creating another, with one exception: owning a workspace on a `payment` hold refuses a new one with `org.create_unpaid` (403, `params.orgId` the oldest such workspace), so a person has at most one workspace waiting for its first plan. The check runs in the create's transaction under a lock per person, so two creates at once start one. The web app sends them to that workspace's plan instead, and the phone app only says that workspace isn't active yet.
- A trust hold or a suspension on any workspace they are in still refuses (`org.create_refused`), and so does a blocked account.
- With `BILLING_HOLD_NEW_WORKSPACES=true` a new workspace starts on a `payment` hold, written in the row's insert: no audit row and no notification, since nothing moved. The server refuses to start with it unless `BILLING_URL`, `BILLING_LINK_SECRET` and `OPERATOR_API_TOKEN` are set, because only the billing service lifts it. The computer provisioning keeps one reason (`capacity`): a workspace waiting for payment simply isn't a request.

### 3. A signed link to the billing service

- `POST /api/app/organizations/{orgId}/billing-link` with `{ from }` answers `{ url, expiresAt }` for owners and admins (`manage_billing`); a suspended workspace refuses it (`org.suspended`), a held one doesn't, since paying is how a billing hold ends. Without `BILLING_URL` it answers 404 `billing.off`, and `GET /api/app/auth-config` says `billingUrl: null`.
- The URL is `BILLING_URL/link?t=<token>`, with `token = "v1." + payload + "." + signature`: the payload is the claims as UTF-8 JSON in base64url, the signature the base64url HMAC-SHA256 of `"v1." + payload` keyed with `BILLING_LINK_SECRET`. The billing service checks the HMAC over the payload exactly as received (constant time) before it parses anything.
- The claims: `aud: "agentes-billing"`, a random `jti`, `iat` and `exp` (seconds, `exp = iat + 300`), the workspace's id and name, the person's id, email, name, role (`owner` or `admin`) and language, `from` (`settings`, `hold`, `onboarding`, `new_workspace`, `invite_full`, `upload_full`, `storage`: the billing service opens on what it came for), `return` (the path on this server it sends the person back to) and `usage`: people, agents, stored bytes (null on the workspace's own bucket), `messages` (in every conversation a person can read, agent-only rooms left out), `channels` (named and not archived), `files` (Drive's, the trash left out), `wikiPages`, `issues` (not canceled) and `since` (when the workspace was created, in seconds). Counts only: never a name or a word of content, never per channel or per person. Messages are counted per conversation on an index without reading one (ADR 0009), so a thread's first message deleted before any reply still counts.
- `return` is always an app path under the workspace, `/org/{orgId}` or one of its pages: `/settings/billing` for `settings`, `/settings/storage` for `storage`, `/members` for `invite_full`, and `/onboarding` for `onboarding`, the onboarding's computer step. That one opens the onboarding again at its AI step, the one after the computer: the web app reads the workspace, its context and its agents back from the server (the tab keeps only which agents the import made, and their models), and says the plan is active once the workspace's `payment` hold is gone. The person can land before the billing service lifts it, so the page asks again every few seconds until then. A workspace it can't read back opens as it is. The billing service sends people to `return` after Checkout, adding `?paid=1` when the payment went through: until the hold lifts, the app says the payment arrived, in the onboarding's line and in the hold banner, which asks again every few seconds too. The billing service accepts only such paths, on this server.
- The billing service accepts 30 seconds of clock skew, refuses a link that claims more than 10 minutes, and accepts each `jti` once. The web app mints the link on the click and only ever navigates to it, so it lands in no history or log of ours.
- `BILLING_LINK_SECRET` (at least 32 characters) is shared with the billing service. Rotating it means setting the new value on both sides together: links minted just before fail once and are minted again.

### 4. Four limits, null meaning none

`PUT /api/operator/v1/orgs/{orgId}/limits` sets `{ members, storageBytes, uploadBytesPerDay, platformUsdPerMonth }`, each a number or null (no limit); `GET /orgs/{orgId}` answers them with `updatedAt`, and the meters. A change (never the same limits set again) sends the workspace's apps `org.limits`, with no payload, and they read their limits again, so a new plan shows within seconds. A self-hosted server never sets any, so nothing is enforced there.

| Limit | Counts | Enforced |
| --- | --- | --- |
| `members` | every membership row, blocked accounts included; never agents, invitations or requests to join | when someone joins (accepting an invitation, an approved request), under the workspace's `org-members` lock, so it holds exactly; and before an invitation is sent, resent or a request approved, so a full workspace sends none that can't be accepted (`org.members_full`, 409) |
| `storageBytes` | the bytes of the files a workspace keeps on this server's storage, files in the trash left out | before any file is written (chat and Drive uploads, a computer's uploads, mail attachments, every version, skill files), as `used + incoming > limit` (`storage.full`, 409); skipped for a workspace on its own bucket. Also before a file comes back from the trash and before files are copied back from the workspace's own bucket, which would otherwise bring back more than the limit |
| `uploadBytesPerDay` | the bytes written to that storage in the last 24 hours, rolling | where files are written (`storage.daily_full`, 409); never for files that come back, which keep the day they were first written |
| `platformUsdPerMonth` | usage billed to the platform this UTC calendar month | §5 |

Bytes count in GiB (1024³), the unit the apps print. The storage check takes no lock: uploads at the same moment may pass the line by at most their own sizes, where a lock would serialize every upload of a workspace. The refusals tell agents in plain English what happened and what a person can do.

### 5. The platform's own AI, capped per month

- Over `platformUsdPerMonth`, the platform's judge (Jev) is skipped and the workspace's own cheap model answers in its place, the path a Jev outage already takes; what only Jev does (images and boxes for computer use) fails like an outage. The router starts no run (`platform_cap`, stored like `no_ai`, before any step of the chain of ADR 0074), and the app says to mention an agent with @, which still starts it.
- The spend is read from usage records with a 60-second cache, so it may run up to a minute of calls past the cap.
- The operator's events feed gets `platform_ai.threshold` (`{ month, percent: 50 | 100, spentUsd, limitUsd }`) the first time a month's spend reaches each threshold, once per workspace, month and threshold.

### 6. What people see

- The server's words name no plan, price or currency. A billing hold says its code's words, and owners and admins get the button that fixes it on the billing service; other members read that whoever runs the workspace can. Settings gets "Plan and billing" for owners and admins only where `billingUrl` is set.
- The phone app shows the words and never a button or a link to pay: the stores allow paying only through their own purchase flow. The desktop app loads the site and gets the site's buttons.

## Consequences

- A self-hosted server changes nothing: without `BILLING_URL` there is no billing anywhere, and without limits nothing is enforced.
- A trust hold put over a billing hold, then lifted, leaves the workspace active until the billing service sets its hold again, so the operator's services re-sync billing whenever they lift a hold.
- The link is a credential for five minutes. It is minted only on a click, carried only in the address bar, and used once by the billing service.
- One secret signs every link, with no overlap when it changes.
- Billing's numbers reach the server only through the operator API: when the billing service is down, workspaces keep their last holds and limits.
