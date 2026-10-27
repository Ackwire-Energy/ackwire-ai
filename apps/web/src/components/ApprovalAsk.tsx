import type { Agent, Approval, Member } from "@agenteschat/client";
import { approvalOriginShort, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { Button, ExpiryFuse } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { colorOf } from "@/components/Sky";
import { ApproveButton, ConnectorMark, ExactAction, expiryText, RefuseBox } from "@/pages/ApprovalsPage";

/** The whole time a request has (24 h when the row doesn't say): the fuse burns down over it. */
const DAY_MS = 24 * 3_600_000;

/**
 * A request waiting in the conversation, as the agent asking: what it said in its own words,
 * the exact action in one line with the app's mark, "Ver o e-mail" / "Ver detalhes" opening it whole, then
 * Approve (held for high risk), "Agora não" (which asks why, kept as a lesson) and the fuse to its expiry.
 * No card: it reads as the agent's next line. Who can't decide sees who it waits for.
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const why = approvalWhy(approval);
  const origin = approvalOriginShort(approval);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const span = Math.max(1, new Date(approval.expiresAt).getTime() - new Date(approval.createdAt).getTime() || DAY_MS);
  const left = Math.max(0, new Date(approval.expiresAt).getTime() - Date.now()) / span;
  const owner = agent?.ownerUserId ? members.get(agent.ownerUserId) : undefined;
  const fuse = (
    <span className="ap-ask__fuse">
      <ExpiryFuse left={left} color={colorOf(agent)} />
      {expiryText(t, approval)}
    </span>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of the request's words and its decision
    <div className="ap-ask" role="group" aria-label={t("approval.group")}>
      <p className="ap-ask__text">{why ?? t("approval.askPlain")}</p>
      <p className="ap-ask__action">
        <ConnectorMark approval={approval} />
        <b>{approvalTitle(t, approval)}</b>
        {!approval.email && approval.detail && <span>{approval.detail}</span>}
      </p>
      {origin && <p className="ap-ask__origin">{tt(origin.key, origin.values)}</p>}
      <button type="button" className="ap-ask__more" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        {approval.email ? t("approval.seeEmail") : t("approval.seeDetails")}
      </button>
      {open && (
        <div className="ap-ask__exact">
          <ExactAction approval={approval} />
        </div>
      )}
      {!approval.canDecide ? (
        <p className="ap-ask__acts">
          <span className="ap-ask__waiting">
            {owner ? t("approval.waitingFor", { name: owner.name }) : t("approval.waitingAdmin")}
          </span>
          {fuse}
        </p>
      ) : refusing ? (
        <RefuseBox approval={approval} agent={agent} onCancel={() => setRefusing(false)} />
      ) : (
        <div className="ap-ask__acts">
          <ApproveButton approval={approval} />
          <Button size="sm" onClick={() => setRefusing(true)}>
            {t("approval.notNow")}
          </Button>
          {fuse}
        </div>
      )}
    </div>
  );
}
