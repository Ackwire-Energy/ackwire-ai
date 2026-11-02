import type { Issue, Message, WorkView } from "@agenteschat/client";
import { blockedText, workLine, workPlanProgress } from "@agenteschat/client/lib/long-work";
import { can } from "@agenteschat/client/lib/permissions";
import { WorkLine, WorkLineAction, WorkPlan } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** Redraws a live work's minutes every half minute. */
function useNow(live: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/** The line of a long work (ADR 0121) and its actions, the same under the anchor and on the card. */
function useWorkLine(work: WorkView) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const live = work.status === "live" || work.status === "queued";
  const now = useNow(live);
  const agent = dir.agentById.get(work.agentId);
  const canStop =
    can(org, "manage_agents") || agent?.ownerUserId === me.user.id || work.requestedByUserId === me.user.id;
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(org.id, runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["org", org.id, "channel", work.channelId] }),
  });
  const view = workLine(t, work, {
    locale: i18n.language,
    now,
    meId: me.user.id,
    agentName: agent?.name ?? t("channel.unknownAgent"),
    nameOf: (id) => dir.memberById.get(id)?.name ?? null,
    canStop,
  });
  return { view, stop, t };
}

/** Under the agent's "Vou cuidar disso": how the work stands, its last update, Tarefa #, Parar, Ver resultado. */
export function MessageWorkLine({ message }: { message: Message }) {
  const work = message.longWork;
  if (!work) return null;
  return <AnchorLine work={work} />;
}

function AnchorLine({ work }: { work: WorkView }) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const actions = useChannelActions();
  const { view, stop, t } = useWorkLine(work);
  return (
    <WorkLine
      tone={view.tone}
      text={view.text}
      update={view.update}
      actions={
        <>
          {view.threadId && actions?.openThread && (
            <WorkLineAction onClick={() => actions.openThread?.(view.threadId as string)}>
              {t("work.openThread")}
            </WorkLineAction>
          )}
          {view.task && (
            <WorkLineAction
              onClick={() =>
                void navigate({
                  to: "/org/$orgId/issues/$number",
                  params: { orgId: org.id, number: String(view.task?.number) },
                })
              }
            >
              {view.task.label}
            </WorkLineAction>
          )}
          {view.result && (
            <WorkLineAction onClick={() => actions?.jumpTo?.(view.result?.messageId as string)}>
              {view.result.label}
            </WorkLineAction>
          )}
          {view.stop && (
            <WorkLineAction danger disabled={stop.isPending} onClick={() => stop.mutate(view.stop?.runId as string)}>
              {t("work.stop")}
            </WorkLineAction>
          )}
        </>
      }
    />
  );
}

/** On a card that tracks background work: its line, the agent's plan, Abrir conversa, Parar, Mostrar para todos. */
export function IssueWorkBlock({ issue }: { issue: Issue }) {
  const work = issue.backgroundWork;
  if (!work) return null;
  return <CardBlock issue={issue} work={work} />;
}

function CardBlock({ issue, work }: { issue: Issue; work: WorkView }) {
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { view, stop, t } = useWorkLine(work);
  const progress = workPlanProgress(work);
  const share = useMutation({
    mutationFn: () => api.issues.share(org.id, issue.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["org", org.id, "issues"] }),
  });
  const openConversation = () =>
    view.threadId
      ? void navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId: org.id, threadId: view.threadId } })
      : void navigate({
          to: "/org/$orgId/c/$channelId",
          params: { orgId: org.id, channelId: work.channelId },
          search: { m: work.anchorMessageId },
        });
  return (
    <div className="issue-work-block">
      <WorkLine
        tone={view.tone}
        text={view.text}
        update={view.update ? `${t("work.lastUpdate")}: ${view.update}` : null}
        actions={
          <>
            <WorkLineAction onClick={openConversation}>{t("work.openThread")}</WorkLineAction>
            {view.stop && (
              <WorkLineAction danger disabled={stop.isPending} onClick={() => stop.mutate(view.stop?.runId as string)}>
                {t("work.stop")}
              </WorkLineAction>
            )}
            {issue.channelId && (
              <WorkLineAction disabled={share.isPending} onClick={() => share.mutate()}>
                {t("work.shareEveryone")}
              </WorkLineAction>
            )}
          </>
        }
      />
      {work.plan.length > 0 && (
        <WorkPlan
          label={t("work.plan")}
          progress={progress ? t("work.planProgress", progress) : undefined}
          items={work.plan.map((p) => ({ key: p.id, text: p.text, state: p.state }))}
        />
      )}
    </div>
  );
}

/** On a board card: the blocked badge, the agent's plan (its steps, the one it is on) and its last update. */
export function IssueCardWork({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const work = issue.backgroundWork;
  const blocked = blockedText(t, issue.blocked);
  if (!work && !blocked) return null;
  const progress = work ? workPlanProgress(work) : null;
  const live = work && (work.status === "live" || work.status === "queued");
  return (
    <span className="issue-card__work">
      {blocked && <span className="issue-card__blocked">{blocked}</span>}
      {live && progress && (
        <span className="issue-card__plan">
          <span className="issue-card__plan-head">
            {t("work.plan")} · {t("work.planProgress", progress)}
          </span>
          {work.plan.map((p) => (
            <span key={p.id} className="issue-card__step" data-state={p.state}>
              <span className="issue-card__step-mark" aria-hidden="true" />
              {p.text}
            </span>
          ))}
        </span>
      )}
      {live && work.lastUpdate && (
        <span className="issue-card__update">
          <b>{t("work.lastUpdate")}:</b> {work.lastUpdate.text}
        </span>
      )}
    </span>
  );
}
