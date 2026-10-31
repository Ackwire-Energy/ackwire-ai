# 0089. Bringing a teammate in: a link asks with a password, invitations keep their link

- Status: Accepted (built: the server, the shared client and the web; the phone app follows)
- Date: 2026-10-31
- Revises: ADR 0068 §4 and §5 (an approval also makes the account a proven ask chose a password for), ADR 0072 §2 and §6 (for an address with no account, the code that proved the request is what confirms the new account)
- Code: `packages/engine/src/invite-requests.ts` (`askToJoin`, `approveJoinRequest`, `claimJoinRequest`, `suggestPerson`, `listMySuggestions`, `cancelSuggestion`, `renewInviteLink`, `noticeInvitationAccepted`), `packages/engine/src/organizations.ts` (`sendInvitation`, `createInvitation`, `inviteMany`, `invitableChannelIds`, `setInvitationRoles`, `resendInvitation`, `listInvitationsWithStatus`, `previewInvitation`, `invitationState`, `acceptInvitation`, `hasWaitingInvitation`), `packages/engine/src/crypto.ts` (`invitationToken`), `packages/engine/src/email.ts` (`queueInvitationEmail`), `apps/server/src/auth.ts` (`hashPassword`, `mintUserSignIn`), `apps/server/src/routes/app/invites.ts`, `management.ts`, `account.ts`, `packages/db/migrations/0139_invitation_flow.sql`; the screens: `apps/web/src/pages/InvitePage.tsx`, `apps/web/src/pages/MembersPage.tsx`, `apps/web/src/components/invite/` (the invite dialog, the address chips shared with the onboarding, the link panel, the arrival card), `apps/web/src/components/WelcomeCard.tsx`

## Context

Bringing someone into a workspace took too many steps and had dead ends:

- Through the workspace's link (ADR 0068, 0072) a person typed a name, an email and a code on one screen, asked, waited, then got a second email ("Approved: one step left") with a new 7-day invitation, typed their name again, chose a password, and got a "confirm your email" message for an address they had proven twice. The password came last, after approval.
- An email invitation's link changed every time it was sent again, so the copy in the person's inbox stopped working, and the Members list could copy a link only right after sending it.
- Pasting addresses from a mail app (`Ana <ana@x.com>`) made invitations nobody could accept.
- A dead invitation link said "expired" whatever happened to it, and an invitation to a paused or full workspace let a person make an account before refusing them.
- Invitations added people to #general only, with no word from the inviter; the inviter never heard that someone joined; members who couldn't invite had no way to bring anyone.

## Decision

1. **A link asks with a password.** Signed out on a server that sends email, the page asks one thing per screen: the email, the code from it (on a screen of its own), the name, a password, an optional note. The ask (`POST /invitations/{token}/requests`) carries `password`; the server hashes it as Better Auth does (`hashPassword`) and keeps the hash on the request (`organization_join_requests.password_hash`). No account exists until someone approves: a link still never signs anyone up (ADR 0068 §5).
2. **Approval makes the account.** Approving a proven request for an address with no account makes it (`makeAskedAccount`): that address, confirmed, with the name and the password the person chose, written as Better Auth writes one, then the sign-up hooks' work (`onUserCreated`, `user.signed_up`). It joins at once and is told by email ("You're in", with a link that opens the workspace). The hash goes from the request into the account, and from the request when it is denied, closes, runs out (the daily tick) or its link is turned off. An address that already has an account keeps ADR 0072's path: a confirmed one joins and signs in as always, an unconfirmed one gets an email invitation. This is the one place a code confirms an account (ADR 0072 §2 keeps it from confirming an existing one): the new account is the request's, the address was proven by its mailbox, and an admin approved the person.
3. **The page that asked signs in.** The ask answers a `key` (`{requestId}.{secret}`, only the secret's sha256 kept as `claim_hash`). The page checks every 15 s (`POST …/requests/claim`): `pending`, `in` once, for an account the approval made (a one-time sign-in the page trades at `/api/auth/sign-in/one-time-token`, as the phone's, after which the key is spent), `denied` with the reason, or `closed`. An approval that made no account clears the key: no page signs in to an account that was already there.
4. **Invitations keep their link.** An email invitation's token is an HMAC of its id under `AGENTES_SECRET` (`invitationToken`, as the workspace's link, ADR 0068 §9), so the Members list copies it at any time and sending it again keeps it, only with 7 more days. An invitation sent before this gets a derived link the next time it is sent. The invitation email's key is per sending (its expiry), so sending again sends again.
5. **One dialog invites.** Addresses as chips, each with its role, read the way mail apps and spreadsheets paste them (`addressesIn`); channels they also join (`channel_ids`: the workspace's own, not archived, public or one the sender is in, else `invitation.channel`); a note in the email (`note`, made inert like any typed text; subjects keep only fixed words). The batch takes `invites` (each address with its roles), or `emails` with one set of roles as before. The roles of a pending invitation change without sending it (`PATCH …/invitations/{id}`), and a link gets 30 more days without changing (`POST …/invite-links/{id}/renew`).
6. **The invite page asks only what is missing.** The preview says how the invited address signs in (`account`: an account, a password, which social sign-ins) and whether the workspace is full (`full`), and an invitation to a paused workspace reads as closed, all before anyone makes an account. A dead email invitation says what happened (`GET /invitations/{token}/state`: accepted, with the workspace to open, or expired, with who to ask); a cancelled one says only that it doesn't work, as one that never existed. Accepting confirms the address (the token reached that mailbox), so signing up to accept one sends no "confirm your email".
7. **Members suggest.** A member who may not invite suggests someone (`POST …/join-requests/suggest`): a request with no link and no proof, from them (`suggested_by_user_id`), that the people who may invite answer as any other; approving it sends an email invitation. Its author sees their suggestions waiting and can take one back.
8. **The inviter hears who joined.** Accepting an email invitation leaves its sender a notice (`invitation_accepted`, the person as actor) that opens a conversation with them. Inbox only: no category, so no push.

## Consequences

- An account can now be made without Better Auth's sign-up endpoint, by an approval: its policy gate (`isSignupAllowed`) doesn't run, on purpose, as an invitation's doesn't.
- A guessed code (ADR 0072's limits: 5 tries a code, 10 wrong a day per address) plus an admin's approval would make an account for someone else's address. The approval is the second check: admins see the address and the note before saying yes.
- Phone builds from before this ask without a password and get ADR 0072's invitation after approval, as before; the batch still takes `emails`.
- Links already emailed before this keep working until sent again, when they change once.

## Alternatives considered

- Making the account when the person asks: the link would open sign-up again (ADR 0068 rejected it), and every leaked link would leave accounts behind.
- Keeping the password for after approval, without asking the name again: one more email and one more visit for every person, which is what this replaces.
- Signing an existing account in from the page that asked: the code would then sign in to accounts it never made.
