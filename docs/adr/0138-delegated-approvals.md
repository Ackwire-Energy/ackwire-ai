# 0138. Delegated approvals: who approves for me

- Status: Accepted for both parts; built: part 1, a person covers (engine, server, the shared client, the web and the phone app). Part 2, the right hand decides, is next.
- Date: 2026-11-03
- Amends: ADR 0015 (who decides an approval), ADR 0126 (the people a `request_approval` names may be covered)
- Extends: ADR 0084 §14 (out of office now routes approvals), ADR 0053 (the person behind a run, stored on the approval), ADR 0085 §7 (nobody gives what they can't do)
- Code: db `packages/db/src/schema/runtime.ts` (`approval_covers`, `approvals.requested_by_user_id`, `high_risk`, `decided_for_user_id`, migration `approval_covers`); engine `approval-covers.ts` (`activeCoversTo`, `activeCoversFrom`, `getMyCovers`, `setMyCover`, `endCover`), `approvals.ts` (`coveredFor`, `coveredBySql` in `decidableBySql`, `approverIds`, `decideApproval`, `decideApprovals`, `deciderName`), `tools/gateway.ts` (`highRisk`), `notification-producers.ts` (`rerouteApprovals`), `member-status.ts`; server `routes/app/approvals.ts`; client `lib/approval-words.ts` (`decisionOutcome`, `coveringLine`), `lib/format.ts` (`endOfDay`); web `components/ApprovalCover.tsx`; phone `features/me/ApprovalsPage.tsx`

## Context

A customer asked whether a team manager could approve everything for them. A role with `approve_actions` already makes someone approve every agent action in the workspace, but there was no "only mine", no "while I'm away" and no "on behalf of" in the record. And the agent version (the right hand approves for me) went against ADR 0081, 0129 and 0137 §4 as written.

## Decision

### 1. A person covers ("Quem aprova por mim")

- One cover per person in a workspace (`approval_covers`, unique per `org_id` and `from_user_id`): one other member, `always` or `while_out` (only while the person's status says out of office, ADR 0084 §14, read live with its end), until an optional `ends_at`, and `risky` (merge, deploy and other high-risk actions), off by default. Both people must be members: the row goes with either one (composite foreign keys, cascade).
- **What it reaches:** only what is asked of the person personally: as the agent's owner, or named by `request_approval` (a person named, or a role they hold, resolved when it was asked). What someone decides only through a workspace-wide key (`approve_actions`) isn't theirs to pass on: other admins already decide it, and a workspace that wants a human approver for everything gives a role.
- **Never, whatever the settings (code):** the cover's own request (`approvals.requested_by_user_id`, the person behind the run as the Tool Gateway saw it, and `approvers.requestedBy`), an action in someone's own mailbox (`approvers.required`, only its owner decides), access for good (`request_permission`, admins), approving for good ("Aprovar sempre", 409 `approval.always_unavailable`: a standing rule outlives the cover and changes the agent for everyone). High-risk actions only with `risky`: `approvals.high_risk`, set when asked from the tool's name and scope (`highRisk`: what "Aprovar sempre" never covers by name, plus deploy, rollback, delete, send and the like, mirroring the client's `approvalRisk`); rows from before count as high risk. Money, roles, keys, invitations, archiving and deleting aren't approvals at all and stay with the person.
- **No re-delegation:** a cover reaches only what is asked of the covered person, never what reaches them as someone's cover, so A→B never passes to C.
- **The delegate never decides more than the delegator could:** the cover's reach is computed from what the covered person is asked now (owner, named, still a member), live at each decision, not from a snapshot.
- **Deciding:** the same `decideApproval` and "Aprovar tudo" as any decider; the row keeps `decided_by_user_id` (the cover) and `decided_for_user_id` (the person), the audit row `on_behalf_of_user_id`, and the run reads "Approved by Bruno (covering Ana)". Someone who may decide by their own right (an admin, the owner) never decides "covering".
- **Routing (`approverIds`):** whoever covers someone asked personally is asked too: card badge, inbox, push and the reminder email. While the person is out, only the cover is asked; the person still decides from Aprovações (`decidableBySql`), without a push. Setting, changing or ending a cover, and going out or coming back, move what waits (`rerouteApprovals`): it reaches whoever is asked now and leaves whoever isn't.
- **Hearing it:** the cover gets an inbox entry when chosen (`approval_cover`, inbox only); the person hears when the cover says "Não quero cobrir" or an admin ends it. Ending a cover: the person, the cover, or who manages members (`DELETE …/approval-covers/{userId}`).
- **Screens:** Configurações › Você › Aprovações on the web, Perfil › Aprovações on the phone: Pessoa, Quando, Até, the risky switch, the line of what always stays with you, and Você aprova por with Não quero cobrir. A decided card reads "Aprovado por Bruno, cobrindo Ana" ("cobrindo você" for Ana).

### 2. The right hand decides ("O Gerente aprova por você"), next

Only the workspace's right hand (ADR 0137, under its workspace name) ever decides, for two kinds: creating an agent another agent proposed (no apps, only open channels) and model, budget or open-channel changes on an existing agent within the same AI account. Only for requests that started from the person's own message (the provenance chain, in code); it approves or passes to the person, never refuses; caps in code (US$ 20 per agent a month, 2 new agents and 10 decisions a day, US$ 50 a month); one decision call per item on the workspace's AI through the Model Gateway; Desfazer for 24 h; three undos in a week pause it. Its own section of this ADR comes with that build.

## Consequences

- One more reason someone can decide an approval: Aprovações, the card and the audit row say "cobrindo".
- An approval asked while its person was in reaches the cover the moment they go out, and comes back when they return. An out-of-office status that ends by its own time (no write) moves nothing until the next change, though deciding follows it at once.
- Skipped until someone asks: several covers in order, per-agent routing, an admin's view of a member's cover on the member's page (an admin may already end it through the API).
