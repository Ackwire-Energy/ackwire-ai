import type { Agent, Approval, Member } from "@agenteschat/client";
import { approveAllScope, approveAlwaysOn, cardDeadline, itemOwnWords } from "@agenteschat/client/lib/approval-card";
import { approveAlwaysOffered } from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import { approvalSummary, approvalTitle, decisionOutcome } from "@agenteschat/client/lib/approval-words";
import { Button } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApproveAlways } from "@/components/ApprovalItem";
import { useOrg } from "@/components/org-context";
import {
  ApproveAll,
  ApproveButton,
  approveAllPartial,
  ConnectorMark,
  ExactAction,
  expiryText,
  RefuseBox,
} from "@/pages/ApprovalsPage";
import { RequestCard, RequestFuse } from "./RequestCard";

/** The whole time a request has (24 h when the row doesn't say): the fuse burns down over it. */
const DAY_MS = 24 * 3_600_000;

/**
 * An approval waiting in the conversation, as a request card: the agent's words, the exact action in the well
 * with the app's mark, "Ver o e-mail" / "Ver detalhes" opening it whole (with "Aprovar sempre" and where it came
 * from), then Approve (held for high risk) and "Agora não" (which asks why, kept as a lesson), and the fuse to its
 * expiry. Who can't decide sees who it waits for.
 */
export function ApprovalAsk({
  approval,
  agent,
  members,
}: {
  approval: Approval;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { t, i18n } = useTranslation();
  const [refusing, setRefusing] = useState(false);
  const why = approvalWhy(approval);
  const origin = approvalOriginShort(approval);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const span = Math.max(1, new Date(approval.expiresAt).getTime() - new Date(approval.createdAt).getTime() || DAY_MS);
  const left = Math.max(0, new Date(approval.expiresAt).getTime() - Date.now()) / span;
  const owner = agent?.ownerUserId ? members.get(agent.ownerUserId) : undefined;
  const title = approvalTitle(t, approval);
  const email = approval.email;
  // A connector's detail is its raw call (`tool · key=value`): its values in words instead, the call under "Ver detalhes".
  const detail = email
    ? [email.to.join(", "), email.subject].filter(Boolean).join(" · ")
    : (approval.connector ? approvalSummary(approval, i18n.language) : approval.detail) || undefined;
  return (
    <RequestCard
      id={approval.id}
      kind="approval"
      agent={agent}
      label={t("approval.group")}
      mine={approval.canDecide}
      waitingFor={owner ? t("ask.waitingFor", { name: owner.name }) : t("approval.waitingAdmin")}
      lead={why ?? t("approval.askPlain")}
      object={{
        logo: <ConnectorMark approval={approval} />,
        title,
        detail,
        more: email ? t("approval.seeEmail") : t("approval.seeDetails"),
      }}
      details={
        <>
          <ExactAction approval={approval} />
          {origin && <p className="rq__origin">{tt(origin.key, origin.values)}</p>}
          {approval.canDecide && !refusing && approveAlwaysOffered(approval) && (
            <div className="rq__always">
              <ApproveAlways approval={approval} agent={agent} />
            </div>
          )}
        </>
      }
      actions={
        !approval.canDecide ? undefined : refusing ? (
          <RefuseBox approval={approval} agent={agent} onCancel={() => setRefusing(false)} />
        ) : (
          <>
            <ApproveButton approval={approval} />
            <Button size="sm" onClick={() => setRefusing(true)}>
              {t("approval.notNow")}
            </Button>
          </>
        )
      }
      end={refusing ? undefined : <RequestFuse left={left} agent={agent} text={expiryText(t, approval)} />}
      what={title}
    />
  );
}

/**
 * Several requests of one agent in one conversation, on one card (the server joins them: `openApprovalCard`):
 * each item with its values and its own approve / "Agora não", decided ones folded into the list with how they
 * ended, "Aprovar tudo" / "Agora não para todos" over the ones listed now, and the earliest deadline's fuse.
 * Someone who may decide only some reads that "Aprovar tudo" covers only those.
 */
export function ApprovalGroupAsk({
  items,
  agent,
  members,
}: {
  items: Approval[];
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { t } = useTranslation();
  const first = items[0];
  if (!first) return null;
  const waiting = items.filter((a) => a.status === "pending");
  const mine = waiting.some((a) => a.canDecide);
  const owner = members.get(first.ownerUserId ?? agent?.ownerUserId ?? "");
  const leadItem = waiting[0] ?? first;
  const why = approvalWhy(leadItem);
  const always = approveAlwaysOn(items);
  const deadline = cardDeadline(items);
  const left = deadline ? Math.max(0, new Date(deadline).getTime() - Date.now()) / DAY_MS : 0;
  const partial = approveAllPartial(t, items, owner);
  return (
    <RequestCard
      id={first.id}
      kind="approval"
      agent={agent}
      label={t("approval.group")}
      mine={mine}
      waitingFor={owner ? t("ask.waitingFor", { name: owner.name }) : t("approval.waitingAdmin")}
      lead={why ?? t("approval.askMany", { count: waiting.length })}
      body={
        <>
          <ul className="rq__items">
            {items.map((a) => (
              <GroupItem
                key={a.id}
                approval={a}
                lead={leadItem}
                always={always.has(a.id)}
                agent={agent}
                members={members}
              />
            ))}
          </ul>
          {partial && <p className="rq__note">{partial}</p>}
        </>
      }
      actions={approveAllScope(items).ids.length > 1 ? <ApproveAll items={items} /> : undefined}
      end={
        deadline ? <RequestFuse left={left} agent={agent} text={expiryText(t, { expiresAt: deadline })} /> : undefined
      }
      what={t("approval.askMany", { count: waiting.length })}
    />
  );
}

/**
 * One request on a shared card: its values (and its own why and origin where they differ from the card's lead),
 * its own decision while it waits ("Aprovar sempre" under "Ver detalhes" on the first of its kind), how it
 * ended once decided.
 */
function GroupItem({
  approval,
  lead,
  always,
  agent,
  members,
}: {
  approval: Approval;
  lead: Approval;
  always: boolean;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const [refusing, setRefusing] = useState(false);
  const [open, setOpen] = useState(false);
  const email = approval.email;
  const detail = email
    ? [email.to.join(", "), email.subject].filter(Boolean).join(" · ")
    : (approval.connector ? approvalSummary(approval, i18n.language) : approval.detail) || undefined;
  const pending = approval.status === "pending";
  const own = itemOwnWords(approval, lead);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <li className={pending ? "rq__item" : "rq__item rq__item--done"} data-status={approval.status}>
      <div className="rq__well">
        <span className="rq__logo">
          <ConnectorMark approval={approval} />
        </span>
        <span className="rq__wt">
          <b>{approvalTitle(t, approval)}</b>
          {detail && <small>{detail}</small>}
          {own.why && <small className="rq__item-why">{own.why}</small>}
          {own.origin && <small className="rq__item-why">{tt(own.origin.key, own.origin.values)}</small>}
        </span>
        {pending ? (
          approval.canDecide &&
          !refusing && (
            <span className="rq__item-acts">
              <ApproveButton approval={approval} />
              <Button size="sm" onClick={() => setRefusing(true)}>
                {t("approval.notNow")}
              </Button>
            </span>
          )
        ) : (
          <span className="rq__item-outcome">
            {decisionOutcome(t, approval, me.user.id, (id) => members.get(id)?.name)}
          </span>
        )}
        <button type="button" className="rq__more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {email ? t("approval.seeEmail") : t("approval.seeDetails")}
        </button>
      </div>
      {open && (
        <div className="rq__details">
          <ExactAction approval={approval} />
          {always && !refusing && (
            <div className="rq__always">
              <ApproveAlways approval={approval} agent={agent} />
            </div>
          )}
        </div>
      )}
      {refusing && <RefuseBox approval={approval} agent={agent} onCancel={() => setRefusing(false)} />}
    </li>
  );
}
