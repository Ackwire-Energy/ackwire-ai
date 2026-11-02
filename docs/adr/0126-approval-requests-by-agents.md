# 0126. Approval requests by agents

- Status: Accepted
- Date: 2026-11-02
- Amends: 0015 (who decides an approval), 0085 (roles as approvers)
- Code: `packages/engine/src/approval-requests.ts` (`request_approval`, `resolveApprovers`), `approvals.ts` (`decides`,
  `approverIds`, `seenBy`), `tools/gateway.ts` (`ToolDefinition.approvers`), `tools/run-policy.ts`, `executor.ts`
  (who refused), `context.ts` (`REQUEST_APPROVAL_LINE`); `apps/server/src/routes/app/approvals.ts` (`approvers`);
  `packages/client/src/lib/approval-words.ts` (`approvalWaitsFor`, `requesterDecidesLine`); web `ApprovalAsk.tsx`,
  `ApprovalItem.tsx`, `ApprovalsPage.tsx`; `management.ts` (`orgOverview`); phone `chat/cards.tsx`, `approvals/ApprovalSheet.tsx`; migration `0180_approval_requests.sql`

## Context

An agent's instructions often say something needs someone's approval ("queries on the sales database need the
board's approval"). Nothing let the agent ask for that: approvals (ADR 0015) were only made by the Tool Gateway for a
sensitive tool call, and went to the agent's owner and admins. So the agent asked the only way it had, `ask_user`:
a question card to the person who made the request, who answered "Aprovo" to their own request. The agent then
(rightly) refused, but nothing ever reached the people who decide, and it couldn't see Aprovações to send one there.

## Decision

1. **`request_approval`** is a built-in tool every agent and brain has (scope `""`, listed through the gateway, so the
   runner's MCP bridge offers it too): `summary` (the card's title), `details` (exactly what it will do once
   approved), the gateway's required `why`, and optionally `role` (a workspace role, ADR 0085, by name) or `people`
   (by @handle or name, `findMember`). It is `sensitive`, so the gateway makes a real approval row like any other:
   the card in the conversation, Aprovações, the notification and push (ADR 0046), the e-mail digest, the 24-hour
   expiry, the run waiting in `waiting_approval`. The workspace has no departments apart from roles: a department is a
   role.
2. **Who decides** (`approvals.approvers`, snapshot when asked, through `ToolDefinition.approvers`): the holders of the
   role and the people named; none named, the agent's owner and admins as for every approval. Whoever may approve
   actions (admins) may still decide any of them, so nothing gets stuck, but only those asked get the inbox item,
   push and e-mail. A role nobody holds, or one that isn't there, refuses the call with the workspace's roles, so the
   agent can correct it.
3. **The requester never approves their own request**, unless they approve by role: they hold the role named, or may
   approve every action. Named alone (or as the agent's owner), they are dropped from those asked, and with nobody
   left the admins are asked. When the requester may decide, the card says so ("Asked by someone who approves it by
   role"), before and after they decide. Others who can't decide read "Waiting for <approvers>".
4. **The decision wakes the agent** with who decided and their note: approved, the tool's result is "Approved by
   <name>, with the note: … Do exactly what was approved now: <details>"; refused, "<name> refused this action. Do
   not retry it. Reason: …" (now for every approval, not only these).
5. **Prompt**: when the agent's instructions, the workspace's rules or the person say something needs someone's
   approval, it asks with `request_approval` and waits, never with `ask_user` to the person who asked.
6. **Policy**: any run may ask (a routine's request goes where the routine reports, like its other approvals). In a
   mission's thread the mission's own `request_approval` (scope `sandbox:run`, ADR 0029) wins: its source comes first.
7. **The requester of a routine's run** is the routine's creator (`routineCreatorOf`), so a routine never gets its
   creator to approve its own request. An admin's own request is marked `requesterDecides`: admins may decide any
   approval, and the card says it is their own. The sidebar's count (`approvalsWaitingForMe`) and Aprovações (the
   chip, "Aprovar tudo", who decides) use the same people as `decides`.
8. **At most 5 requests an hour per agent** (the mission's `request_approval` limit): each one notifies and pushes
   every approver, so a loop or text the agent read can't flood them. Past it, the call is refused with a line the
   agent tells the person.
9. **Rules that ask a person**: a database connection's rules (ADR 0039) never ask for approval (they allow or
   refuse); connector tools set to `approval` are sensitive calls that already go to the agent's owner and admins,
   the same default approvers. Nothing else changes for them.

## Consequences

- The owner of the reported workspace gets the board's approvals in Aprovações and on the phone, and the member who
  asked sees who it waits for.
- The approvers are a snapshot: someone given the role after the request isn't asked (an admin still may decide).
- Migration 0180 adds `approvals.approvers` (jsonb, null for every other approval).
