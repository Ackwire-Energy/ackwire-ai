# 0072. Asking to join proves the address

- Status: Accepted (built: server, web and the shared client; the phone app follows)
- Date: 2026-10-27
- Revises: ADR 0068 §2, §4, §7 and §8
- Code: `packages/engine/src/invite-requests.ts` (`sendJoinCode`, `checkJoinCode`, `askToJoin`, approval, prune), `packages/engine/src/jobs.ts` (`email.send`), `packages/engine/src/email/` (`join_code`, the `code` block), `apps/server/src/routes/app/invites.ts`, `apps/web/src/pages/InvitePage.tsx` (`EmailProof`), `apps/web/src/pages/MembersPage.tsx`

## Context

With ADR 0068, whoever holds an invitation link types a name and an address and asks. The address was never proven: approving a typed request could only send an invitation, the admin's card had to say so on every request, and anyone could file requests in other people's names. A code emailed to the address and typed back on the page proves it before the request goes in.

## Decision

1. **Verify sits beside the email field** on the link's page. It emails a 6-digit code, typed back in place, and "Ask to join" stays off until the address is verified. A code and a proof belong to the address they were for: editing it starts over. A signed-in account with a confirmed email needs no code. One whose email isn't confirmed verifies its own address the same way. A server that sends no email keeps ADR 0068's form and its unproven path.
2. **The code proves the request, never the account.** `users.email_verified` changes only through Better Auth's own confirmation link, so a guessed code can't confirm someone else's account.
3. **The code.** 10 minutes to type it and 5 wrong tries, then 30 minutes from typing it right to asking with it. A new code replaces one still waiting to be typed, never one already typed right. The ask carries the code (`POST …/requests` with `code`, checked first or not), and the server checks it, files the request with `verified_at` and deletes the code in one transaction. A proven ask hears where its address stands (`join.member`, `join.denied`, `join.full`), and those answers leave its code good. With no code sent, a check answers `join.code_wrong`, so nobody learns whether one went out.
4. **Limits, all counted in the database**, so a restart or a second process resets none. 60 s between two codes for one workspace and address (`join.code_wait` with `retryIn`). Per workspace and mailbox: 5 codes an hour, 10 a day, and after 10 wrong tries in a day no new code and no check (`join.code_limit`, `join.code_tries`). Per mailbox across workspaces: 20 codes a day. The whole server: 500 code emails an hour (`rate_limited`). The mailbox is the address in lower case, without a `+tag`, and without dots for Gmail (`mailboxOf`). Code sends and checks take one advisory lock, so every count holds. Per IP and per link, in memory like every rate limit here: 10 codes an hour per IP and 40 per link, 30 checks an hour per IP.
5. **What is kept.** `organization_join_codes`, one row per workspace and address, holds only sha256 hashes of `{orgId}:{email}:{code}`: the code waiting to be typed, and the one typed right. `organization_join_code_events` holds the sha256 of the mailbox, the kind (`sent` or `wrong`) and the time. The code's email (`join_code`: the code first in the subject, large in a well, no button, since the page is already open) gets 3 tries within its first minute, and the `email.send` job deletes its outbox row once it is sent or failed for good. The daily tick deletes code rows a day after both their times pass, events after a day, and any code email a worker left behind.
6. **Approval.** A request joins at once when a confirmed, unblocked account has its address and the address was proven (a code, or that account asking). Anyone else gets ADR 0068's email invitation, an unconfirmed account with that address included.
7. **The admins' card** keeps who asks, the address, the note and the answer. The proof line and "Closes {date}" go: a request still closes after 14 days. `GET …/join-requests` gains `verified` (a code proved the address, or a confirmed account with it asked), and "Not verified" shows beside "Asked …" only where nobody proved it: a server without email, or a request typed before codes. `confirmed` stays, deprecated, meaning what approving does, for phone builds that read it.
8. **Words.** The answer emails lose "If you didn't ask to join, ignore this email": the address asked.

## Consequences

- A phone build from before this can't ask to join a server that sends email (`join.code_needed`) until it updates. On a server without email it asks as before. The requests it shows read `confirmed`.
- Requests typed before this stay unproven until they close: approving one sends an invitation.
- Every other email still keeps its address and content in the outbox. Only the code's email is deleted.

## Alternatives considered

- Confirming the account with the same code: a lucky guess would confirm someone else's account.
- Limits in memory: every restart and every replica would reset them.
- A second token after the check: the code itself is the proof, and one tries counter covers checking and asking.
- A link to click instead of a code: the page is already open, and mail scanners open every link.
