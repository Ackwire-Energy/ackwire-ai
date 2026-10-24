import type { Agent, Approval, Member } from "@agenteschat/client";
import { useDecideApproval } from "@agenteschat/client";
import { approvalOriginWords, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import { timeLeft, whenAt } from "@agenteschat/client/lib/format";
import { ApprovalCard, Button } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { CardSky, colorOf, prepareBurst } from "@/components/Sky";
import { useOrg } from "./org-context";

export type ApprovalAction = "merge" | "deploy" | "rollback" | "publish" | "delete" | "send" | "other";

/** The verb of the primary button ("Aprovar merge"), from the tool and scope the agent asked for. */
export function approvalAction(approval: Pick<Approval, "tool" | "scope">): ApprovalAction {
  const text = `${approval.tool} ${approval.scope}`.toLowerCase();
  if (text.includes("merge")) return "merge";
  if (text.includes("rollback")) return "rollback";
  if (text.includes("deploy") || text.includes("workflow") || text.includes("actions.run")) return "deploy";
  if (/delete|remove|destroy|drop|purge/.test(text)) return "delete";
  if (/send|email|mail\b|sms/.test(text) && !text.includes("post_message")) return "send";
  if (text.includes("share") || text.includes("publish")) return "publish";
  return "other";
}

/**
 * High risk (production, can't be undone, leaves the company): approving
 * takes a hold, not a click (telas/Aprovacoes.html).
 */
export function approvalRisk(approval: Pick<Approval, "tool" | "scope">): "high" | "normal" {
  const action = approvalAction(approval);
  return action === "deploy" || action === "rollback" || action === "delete" || action === "send" ? "high" : "normal";
}

/** What the action touches, said as neutral chips (icon + word): production, can't be undone, can be undone. */
export function approvalTraits(approval: Pick<Approval, "tool" | "scope" | "params">) {
  const action = approvalAction(approval);
  const values = Object.values(approval.params ?? {})
    .filter((v) => typeof v === "string")
    .join(" ")
    .toLowerCase();
  const traits: ("production" | "irreversible" | "reversible" | "external")[] = [];
  if (action === "deploy" || action === "rollback" || /\bprod(uction)?\b/.test(values)) traits.push("production");
  if (action === "delete" || action === "send") traits.push("irreversible");
  else if (action === "merge" || action === "deploy") traits.push("reversible");
  if (action === "send" || action === "publish") traits.push("external");
  return traits;
}

/** The app's own tools whose approval title it says in the person's language (`approval.titles.*`). */
const OWN_TITLES = new Set(["run_code", "upload_file", "run_skill_script", "post_message", "request_permission"]);

/** The approval's title: in the person's language for the app's own tools, else the server's (connector) title. */
export function approvalTitle(t: TFunction, approval: Pick<Approval, "tool" | "title" | "params">): string {
  if (!OWN_TITLES.has(approval.tool)) return approval.title;
  const p = approval.params ?? {};
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  return t(`approval.titles.${approval.tool}`, {
    language: s(p.language),
    path: s(p.path),
    skill: s(p.skill),
    channel: s(p.channel).replace(/^#/, ""),
    permission: permissionLabel(t, s(p.permission), approval.title),
    defaultValue: approval.title,
  });
}

/** What `request_permission` asks to turn on: a built-in scope in the person's language, a connector by its name. */
function permissionLabel(t: TFunction, permission: string, title: string) {
  const fromServer = title.replace(/^Turn on: /, "");
  if (!permission || permission.startsWith("connector:")) return fromServer;
  const tt = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return tt(`scopes.${permission.replace(/[^a-zA-Z0-9]/g, "_")}.label`, { defaultValue: fromServer });
}

/** "Aprovado por você · agora" / "Recusado por João · ontem 18:02" / "Expirou · ontem". */
export function decisionLabel(
  t: TFunction,
  locale: string,
  approval: Approval,
  meId: string,
  members: Map<string, Member>,
  now = new Date(),
) {
  const when = approval.decidedAt ? whenAt(t, locale, approval.decidedAt, now) : t("common.now");
  if (approval.status === "expired") return t("approval.expiredChip", { when });
  const mine = approval.decidedByUserId === meId;
  const name = members.get(approval.decidedByUserId ?? "")?.name ?? "";
  if (approval.status === "approved")
    return mine ? t("approval.approvedByYou", { when }) : t("approval.approvedBy", { name, when });
  return mine ? t("approval.refusedByYou", { when }) : t("approval.refusedBy", { name, when });
}

/** Chip of a pending approval you can't decide: who it waits for. */
function waitingFor(t: TFunction, agent: Agent | undefined, members: Map<string, Member>) {
  const owner = agent?.ownerUserId ? members.get(agent.ownerUserId) : undefined;
  return owner ? t("approval.waitingFor", { name: owner.name }) : t("approval.waitingAdmin");
}

function Actions({ approval, secondary }: { approval: Approval; secondary?: React.ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "approve"}
        onClick={(e) => {
          // Approved: a burst of the agent's pixels from its avatar.
          const burst = prepareBurst(e.currentTarget);
          decide.mutate({ id: approval.id, decision: "approve" }, { onSuccess: burst });
        }}
      >
        {t(`approval.approve.${approvalAction(approval)}`)}
      </Button>
      <Button
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ id: approval.id, decision: "refuse" })}
      >
        {t("approval.refuse")}
      </Button>
      {secondary}
    </>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The approval card inside the channel (telas/Main): full while waiting, one line once decided. */
export function InlineApproval({
  approval,
  agent,
  members,
}: {
  approval: Approval;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const name = agent?.name ?? t("channel.unknownAgent");

  if (approval.status !== "pending") {
    return (
      <ApprovalCard
        compact
        status={approval.status === "approved" ? "approved" : "refused"}
        aria-label={approval.status === "approved" ? t("approval.groupDone") : t("approval.groupRefused")}
        who={
          <Trans
            i18nKey="approval.doneWho"
            values={{ agent: name, title: lowerFirst(approvalTitle(t, approval)) }}
            components={{ b: <b /> }}
          />
        }
        statusLabel={decisionLabel(t, i18n.language, approval, me.user.id, members)}
        detail={approval.reason ? t("approval.reasonLine", { reason: approval.reason }) : undefined}
      />
    );
  }
  const left = timeLeft(t, approval.expiresAt);
  const origin = approvalOriginWords(approval);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <ApprovalCard
      status="waiting"
      aria-label={t("approval.group")}
      sky={<CardSky color={colorOf(agent)} />}
      who={<Trans i18nKey="approval.asks" values={{ agent: name }} components={{ b: <b /> }} />}
      statusLabel={approval.canDecide ? t("approval.waitingYou") : waitingFor(t, agent, members)}
      origin={origin ? tt(origin.key, origin.values) : undefined}
      why={approvalWhy(approval) ?? undefined}
      title={approvalTitle(t, approval)}
      detail={`${approval.detail}${left ? ` · ${t("approval.expiresDetail", { time: left })}` : ""}`}
      actions={approval.canDecide && <Actions approval={approval} />}
    />
  );
}
