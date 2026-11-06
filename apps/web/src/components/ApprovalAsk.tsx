import { type Agent, type Approval, type Member, useApprovalsDeciding } from "@agenteschat/client";
import {
  approvalRuns,
  approveAllScope,
  approveAlwaysAlso,
  approveAlwaysOn,
  cardDeadline,
  itemOwnWords,
  runKeys,
} from "@agenteschat/client/lib/approval-card";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import {
  approvalGroupWaitsFor,
  approvalSummary,
  approvalTitle,
  approvalWaitsFor,
  decisionOutcome,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { nextLabel } from "@agenteschat/client/lib/format";
import { Button } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AheadLine, ApproveAlways, CancelAhead } from "@/components/ApprovalItem";
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
import { RequestCard, RequestFuse, useExpired } from "./RequestCard";

/** The whole time a request has (24 h when the row doesn't say): the fuse burns down over it. */
const DAY_MS = 24 * 3_600_000;

/**
 * An approval waiting in the conversation, as a request card: the agent's words, the exact action in the well
 * with the app's mark, "Ver o e-mail" / "Ver detalhes" opening it whole (with where it came from), then Approve
 * (held for high risk), "Aprovar sempre" where offered (what it covers on a line under the buttons) and "Agora não"
 * (which asks why, kept as a lesson), in one row under the text, and the fuse to its expiry. Who can't decide sees who it waits for.
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
  const { org } = useOrg();
  const deciding = useApprovalsDeciding(org.id, [approval.id]);
  // It stops being decidable the moment it expires, even before the server's event says so.
  const expired = useExpired(approval.expiresAt);
  const [refusing, setRefusing] = useState(false);
  const why = approvalWhy(approval);
  const origin = approvalOriginShort(approval);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const span = Math.max(1, new Date(approval.expiresAt).getTime() - new Date(approval.createdAt).getTime() || DAY_MS);
  const left = Math.max(0, new Date(approval.expiresAt).getTime() - Date.now()) / span;
  const owner = agent?.ownerUserId ? members.get(agent.ownerUserId) : undefined;
  const waits = approvalWaitsFor(approval, owner?.name);
  const requester = requesterDecidesLine(t, approval);
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
      waitingFor={waits ? t("ask.waitingFor", { name: waits }) : t("approval.waitingAdmin")}
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
          {requester && <p className="rq__origin">{requester}</p>}
        </>
      }
      body={<AheadLine approval={approval} className="ap-ask__ahead" />}
      actions={
        !approval.canDecide ? undefined : refusing ? (
          <RefuseBox approval={approval} agent={agent} onCancel={() => setRefusing(false)} />
        ) : (
          <>
            <ApproveButton approval={approval} />
            <ApproveAlways approval={approval} agent={agent} />
            <Button size="sm" onClick={() => setRefusing(true)}>
              {t("approval.notNow")}
            </Button>
          </>
        )
      }
      end={refusing ? undefined : <RequestFuse left={left} agent={agent} text={expiryText(t, approval)} />}
      what={title}
      locked={deciding || expired}
    />
  );
}

/** "3 pedidos de Ada para Executar sql": a run of requests, said as one. */
const runHead = (t: TFunction, run: Approval[], agent: Agent | undefined) =>
  t("approval.run.head", {
    count: run.length,
    name: agent?.name ?? t("channel.unknownAgent"),
    what: run[0] ? approvalTitle(t, run[0]) : "",
  });

/**
 * Several requests of one agent in one conversation, on one card (the server joins them: `openApprovalCard`).
 * Waiting requests of one kind in a row fold into one run (`approvalRuns`) with "Aprovar todos" and "Ver cada um";
 * a card that is one run is that run, its buttons in the footer. Otherwise each item (or run) has its values and its
 * own buttons in a row under them, decided ones folded into the list with how they ended, and "Aprovar tudo" /
 * "Agora não para todos" over the ones listed now in the footer, with the earliest deadline's fuse. Someone who may
 * decide only some reads that "Aprovar tudo" covers only those.
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
  const { org } = useOrg();
  const deciding = useApprovalsDeciding(
    org.id,
    items.map((a) => a.id),
  );
  // Which runs are unfolded, by `runKeys`: one stays open while its requests are decided, the card reshaping or not.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const first = items[0];
  if (!first) return null;
  const waiting = items.filter((a) => a.status === "pending");
  const mine = waiting.some((a) => a.canDecide);
  const owner = members.get(first.ownerUserId ?? agent?.ownerUserId ?? "");
  const waits = approvalGroupWaitsFor(items, owner?.name);
  const leadItem = waiting[0] ?? first;
  const why = approvalWhy(leadItem);
  const always = approveAlwaysOn(items);
  const deadline = cardDeadline(items);
  const left = deadline ? Math.max(0, new Date(deadline).getTime() - Date.now()) / DAY_MS : 0;
  const partial = approveAllPartial(t, items, waits);
  const runs = approvalRuns(items);
  const keys = runKeys(runs);
  const [only] = runs;
  const one = runs.length === 1 && only && only.length > 1 ? only : null;
  const isOpen = (key = "") => opened.has(key);
  const setOpen = (key = "", open: boolean) =>
    setOpened((o) => {
      const next = new Set(o);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  const item = (a: Approval, inRun: boolean) => (
    <GroupItem
      key={a.id}
      approval={a}
      lead={leadItem}
      always={!inRun && always.has(a.id)}
      also={approveAlwaysAlso(items, a)}
      agent={agent}
      members={members}
    />
  );
  return (
    <RequestCard
      id={first.id}
      kind="approval"
      agent={agent}
      label={t("approval.group")}
      mine={mine}
      waitingFor={waits ? t("ask.waitingFor", { name: waits }) : t("approval.waitingAdmin")}
      lead={why ?? t("approval.askMany", { count: waiting.length })}
      object={
        one
          ? { logo: <ConnectorMark approval={first} />, title: runHead(t, one, agent), more: t("approval.run.show") }
          : undefined
      }
      open={one ? isOpen(keys[0]) : undefined}
      onOpenChange={one ? (open) => setOpen(keys[0], open) : undefined}
      body={
        <>
          {one ? (
            isOpen(keys[0]) && <ul className="rq__items">{one.map((a) => item(a, true))}</ul>
          ) : (
            <ul className="rq__items">
              {runs.map((run, i) =>
                run.length > 1 && run[0] ? (
                  <RunItem
                    key={keys[i]}
                    run={run}
                    items={items}
                    always={always}
                    agent={agent}
                    open={isOpen(keys[i])}
                    onOpenChange={(open) => setOpen(keys[i], open)}
                  >
                    {run.map((a) => item(a, true))}
                  </RunItem>
                ) : (
                  run[0] && item(run[0], false)
                ),
              )}
            </ul>
          )}
          {partial && <p className="rq__note">{partial}</p>}
        </>
      }
      actions={
        one ? (
          <RunActions run={one} items={items} always={always} agent={agent} />
        ) : approveAllScope(items).ids.length > 1 ? (
          <ApproveAll items={items} />
        ) : undefined
      }
      end={
        deadline ? <RequestFuse left={left} agent={agent} text={expiryText(t, { expiresAt: deadline })} /> : undefined
      }
      what={one ? runHead(t, one, agent) : t("approval.askMany", { count: waiting.length })}
      locked={deciding}
    />
  );
}

/** A run's decision: "Aprovar todos", "Aprovar sempre" where its kind offers it, "Agora não para todos". */
function RunActions({
  run,
  items,
  always,
  agent,
}: {
  run: Approval[];
  items: Approval[];
  always: Set<string>;
  agent: Agent | undefined;
}) {
  const { t } = useTranslation();
  const lead = run.find((a) => always.has(a.id) && a.canDecide);
  return (
    <ApproveAll items={run} label={t("approval.run.approve")}>
      {lead && <ApproveAlways approval={lead} agent={agent} also={approveAlwaysAlso(items, lead)} />}
    </ApproveAll>
  );
}

/** A run among other requests on a card: said as one, its buttons under it, "Ver cada um" unfolding its requests. */
function RunItem({
  run,
  items,
  always,
  agent,
  open,
  onOpenChange,
  children,
}: {
  run: Approval[];
  items: Approval[];
  always: Set<string>;
  agent: Agent | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const first = run[0];
  if (!first) return null;
  return (
    <li className="rq__item rq__run" data-status="pending">
      <div className="rq__well">
        <span className="rq__logo">
          <ConnectorMark approval={first} />
        </span>
        <span className="rq__wt">
          <b>{runHead(t, run, agent)}</b>
        </span>
        <button type="button" className="rq__more" aria-expanded={open} onClick={() => onOpenChange(!open)}>
          {t("approval.run.show")}
        </button>
      </div>
      <div className="rq__item-acts">
        <RunActions run={run} items={items} always={always} agent={agent} />
      </div>
      {open && <ul className="rq__items">{children}</ul>}
    </li>
  );
}

/**
 * One request on a shared card: its values (and its own why and origin where they differ from the card's lead) across
 * the item, then its own decision in a row under them while it waits ("Aprovar sempre" on the first of its kind), or
 * how it ended once decided.
 */
function GroupItem({
  approval,
  lead,
  always,
  also,
  agent,
  members,
}: {
  approval: Approval;
  lead: Approval;
  always: boolean;
  also: string[];
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
  const ahead = aheadPhase(approval);
  const runAt = approval.runAt ? nextLabel(i18n.language, approval.runAt) : "";
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
          {runAt && (ahead === "asking" || ahead === "scheduled") && (
            <small className="rq__item-why">
              {t(ahead === "asking" ? "approval.ahead.line" : "approval.ahead.scheduled", { when: runAt })}
            </small>
          )}
        </span>
        <button type="button" className="rq__more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {email ? t("approval.seeEmail") : t("approval.seeDetails")}
        </button>
      </div>
      {pending ? (
        approval.canDecide &&
        !refusing && (
          <div className="rq__item-acts">
            <ApproveButton approval={approval} />
            {always && <ApproveAlways approval={approval} agent={agent} also={also} />}
            <Button size="sm" onClick={() => setRefusing(true)}>
              {t("approval.notNow")}
            </Button>
          </div>
        )
      ) : (
        <p className="rq__item-outcome">
          {decisionOutcome(t, approval, me.user.id, (id) => members.get(id)?.name)}
          {ahead === "scheduled" && approval.canCancel && <CancelAhead id={approval.id} />}
        </p>
      )}
      {open && (
        <div className="rq__details">
          <ExactAction approval={approval} />
        </div>
      )}
      {refusing && <RefuseBox approval={approval} agent={agent} onCancel={() => setRefusing(false)} />}
    </li>
  );
}
