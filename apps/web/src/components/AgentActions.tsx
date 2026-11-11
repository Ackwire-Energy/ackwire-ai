import type { AgentAction, Message } from "@agenteschat/client";
import { ApiError, useApi, useIssue } from "@agenteschat/client";
import { actionCardOf } from "@agenteschat/client/lib/action-cards";
import {
  actionErrorKey,
  actionTextKey,
  actionTextValues,
  hookToCopy,
  receiptFiles,
  routineOwnActions,
} from "@agenteschat/client/lib/actions";
import { ownActionName } from "@agenteschat/client/lib/approval-words";
import { joinNames, relativeTime, toYmd } from "@agenteschat/client/lib/format";
import { handedTasksOf } from "@agenteschat/client/lib/issues";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { cx, Icon, type IconName } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { useChannelActions } from "@/components/channel-actions";
import { useInPlace } from "@/components/InPlace";
import { useDirectory } from "@/hooks/useDirectory";
import { copyText } from "@/lib/context-menu";
import { inPlaceClick } from "@/lib/navigate";
import { fromApiRule, ruleSentence } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import { DetailsLink } from "./details-link";
import { useOrg } from "./org-context";
import { IssueWhoSeesDialog } from "./WhoSees";
import "./agent-actions.css";

/**
 * What an agent changed with this reply (ADR 0037 round 2), under the message. One change: a quiet row (A). Several:
 * "3 mudanças · há 1 min" and one row each (B). The bold target opens the thing itself, where it is fixed or removed.
 * One undone elsewhere stays as history: struck through, "Desfeito por …".
 */
export function AgentActionReceipts({ message }: { message: Message }) {
  // The right hand's settings card says what was applied and has its own Desfazer (ADR 0137).
  const cardKind = actionCardOf(message.meta)?.kind;
  const onCard = cardKind === "settings_proposal";
  // A task the right hand handed on is its chip (`HandedTaskChips`): its agent is at work on it already.
  const handed = new Set(handedTasksOf(message.meta).map((h) => h.issueId));
  const list = (message.actions ?? []).filter(
    (a) =>
      !(onCard && a.kind === "agent.settings_changed") &&
      // A workspace change's card says what was applied and has its own Desfazer, as a settings card does.
      !(cardKind === "workspace_action" && a.kind === "workspace.changed") &&
      !(a.kind === "issue.created" && handed.has(a.target.id)),
  );
  if (message.author.type !== "agent" || list.length === 0) return null;
  return <Receipts message={message} list={list} />;
}

export const RECEIPT_ICONS: Record<AgentAction["kind"], IconName> = {
  "issue.created": "issues",
  "issue.updated": "issues",
  "issue.assigned": "person",
  "memory.saved": "book",
  "memory.updated": "book",
  "memory.forgotten": "book",
  "routine.created": "routines",
  "routine.updated": "routines",
  "routine.deleted": "routines",
  "channel.agent_added": "channel",
  "channel.created": "channel",
  "wiki.page_created": "page",
  "wiki.page_edited": "page",
  "thread.renamed": "thread",
  "thread.closed": "thread",
  "skill.created": "book",
  "skill.updated": "book",
  "agent.settings_changed": "settings",
  "pr.merged": "repo",
  "workspace.changed": "settings",
};

/** A kind a newer server sends that this build doesn't know yet gets the plain check. */
const iconOf = (a: AgentAction): IconName =>
  a.kind === "issue.updated" && Array.isArray(a.params.fields) && a.params.fields.join() === "priority"
    ? "flag"
    : (RECEIPT_ICONS[a.kind] ?? "check");

function errorMessage(t: TFunction, error: unknown) {
  const generic = t("agentActions.errors.generic");
  return error instanceof ApiError ? t(actionErrorKey(error.code), { defaultValue: generic }) : generic;
}

function Receipts({ message, list }: { message: Message; list: AgentAction[] }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);

  const byName = (a: AgentAction) =>
    a.undoneByUserId === me.user.id
      ? t("agentActions.you")
      : (dir.memberById.get(a.undoneByUserId ?? "")?.name ?? t("agentActions.someone"));
  const row = (a: AgentAction, single: boolean) => (
    <Receipt key={a.id} action={a} single={single} undoneBy={a.undoneAt ? byName(a) : null} />
  );

  const agentName = dir.agentById.get(message.author.id ?? "")?.name ?? dir.authorName(message.author);
  if (list.length === 1) {
    const only = list[0] as AgentAction;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
      <div className="ag-rcs" role="group" aria-label={t("agentActions.group", { name: agentName })}>
        {row(only, true)}
      </div>
    );
  }
  const first = list.reduce((min, a) => (a.createdAt < min ? a.createdAt : min), list[0]?.createdAt ?? "");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ag-rcg" role="group" aria-label={t("agentActions.group", { name: agentName })}>
      <div className="ag-rcg__hd">
        <span>
          <b>{t("agentActions.changes", { count: list.length })}</b> · {relativeTime(t, i18n.language, first)}
        </span>
      </div>
      {list.map((a) => row(a, false))}
    </div>
  );
}

function Receipt({ action: a, single, undoneBy }: { action: AgentAction; single: boolean; undoneBy: string | null }) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  // A routine's schedule from its rule, in the person's language (the server's words are English).
  const { context, ...values } = actionTextValues(a, t, me.user.id, {
    schedule: (rule) => ruleSentence(t, i18n.language, fromApiRule(rule, toYmd(new Date())), new Date()),
  });
  const struck = Boolean(a.undoneAt);
  const ownActions = routineOwnActions(a);
  const files = struck ? [] : receiptFiles(a);
  return (
    <div className={cx(single ? "ag-rc" : "ag-rcg__it", struck && "is-undone")}>
      {single ? (
        <span className="ag-rc__ic" aria-hidden="true">
          <Icon name={iconOf(a)} size={16} />
        </span>
      ) : (
        <Icon name={iconOf(a)} size={14} className="ag-rcg__ic" />
      )}
      <span className="ag-rc__tx">
        <span className="ag-rc__sentence">
          <Trans
            // i18next contexts: `issue.assigned_self`, `routine.updated_paused`…
            i18nKey={`${actionTextKey(a)}${context ? `_${context}` : ""}` as "agentActions.issue.created"}
            values={values}
            components={{ b: <ReceiptTarget action={a} /> }}
          />
        </span>
        {ownActions.length > 0 && (
          <span className="ag-rc__by">
            {t("agentActions.routine.ownActions", {
              actions: joinNames(
                ownActions.map((name) => ownActionName(t, name)),
                t,
              ),
            })}
          </span>
        )}
        {files.length > 0 && (
          <span className="ag-rc__by ag-rc__files">
            {t("agentActions.issue.files", { names: joinNames(files, t) })}
          </span>
        )}
        {undoneBy && <span className="ag-rc__by">{t("agentActions.undoneBy", { name: undoneBy })}</span>}
        {a.kind === "issue.created" && !struck && <ReceiptWhoSees action={a} />}
        <CopyHookButton action={a} />
      </span>
    </div>
  );
}

/** Who sees the task the agent just made, and the way to change it in place (ADR 0151). */
function ReceiptWhoSees({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const number = typeof a.params.number === "number" ? a.params.number : 0;
  const issue = useIssue(org.id, number, open);
  const mode = a.params.audience;
  if (mode !== "everyone" && mode !== "people") return null;
  return (
    <span className="ag-rc__by">
      <button type="button" className="ac-link" onClick={() => setOpen(true)}>
        {t("whoSees.receipt", { who: t(mode === "everyone" ? "whoSees.everyone" : "whoSees.some") })}
      </button>
      {open && issue.data && <IssueWhoSeesDialog issue={issue.data} onClose={() => setOpen(false)} />}
    </span>
  );
}

/**
 * A webhook routine the agent just made: its address, a secret kept out of the message text, is copied from here by
 * who may manage the routine (the person who asked, admins; the server checks again).
 */
function CopyHookButton({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const routineId = hookToCopy(a, { userId: me.user.id, managesRoutines: can(org, "manage_routines") });
  if (!routineId) return null;
  const copy = async () => {
    setBusy(true);
    try {
      const hook = await api.routines.hook(org.id, routineId);
      await copyText(hook.url, () => toast.show(t("routines.webhookCopied")));
    } catch (error) {
      toast.show(errorMessage(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ag-rc__extra">
      <button type="button" className="ag-rc__btn" disabled={busy} onClick={() => void copy()}>
        <Icon name="copy" size={14} />
        {t("agentActions.copyWebhook")}
      </button>
    </span>
  );
}

/**
 * The bold target in the sentence opens the thing itself, where it is fixed or removed: the issue, the routine, the
 * wiki page, the channel, the thread, the memory, the skill. In a conversation the task and the routine open in their
 * dialog over it, the thread and the memory in the panel beside it; the link still goes to their page (a new tab, a
 * middle click).
 */
function ReceiptTarget({ action: a, children }: { action: AgentAction; children?: ReactNode }) {
  const { org } = useOrg();
  const orgId = org.id;
  const managesAgents = can(org, "manage_agents");
  const inPlace = useInPlace();
  // The right hand's page has no Memória: its memory opens as its own page.
  const rightHand = isRightHand(useDirectory(orgId).agentById.get(a.agentId));
  const openPanel = useOpenAgentPanel();
  const openThread = useChannelActions()?.openThread;
  const tg = a.target;
  if (tg.type === "issue" && tg.number != null) {
    const number = tg.number;
    return (
      <Link
        to="/org/$orgId/issues/$number"
        params={{ orgId, number: String(number) }}
        className="ag-rc__target"
        onClick={inPlace ? (e) => inPlaceClick(e, () => inPlace.issue(number)) : undefined}
      >
        {children}
      </Link>
    );
  }
  if (tg.type === "routine")
    return (
      <DetailsLink item={{ kind: "routine", id: tg.id }} className="ag-rc__target">
        {children}
      </DetailsLink>
    );
  if (tg.type === "wiki_page" && (tg.slug || typeof a.params.slug === "string"))
    return (
      <Link
        to="/org/$orgId/wiki/$slug"
        params={{ orgId, slug: tg.slug ?? String(a.params.slug) }}
        className="ag-rc__target"
      >
        {children}
      </Link>
    );
  if (tg.type === "channel")
    return (
      <Link to="/org/$orgId/c/$channelId" params={{ orgId, channelId: tg.id }} className="ag-rc__target">
        {children}
      </Link>
    );
  if (tg.type === "thread")
    return (
      <Link
        to="/org/$orgId/threads/$threadId"
        params={{ orgId, threadId: tg.id }}
        className="ag-rc__target"
        onClick={openThread ? (e) => inPlaceClick(e, () => openThread(tg.id)) : undefined}
      >
        {children}
      </Link>
    );
  // A skill has its own view in Skills, for who manages agents; anyone else finds it in the agent's Memória.
  if (tg.type === "skill" && managesAgents)
    return (
      <Link
        to="/org/$orgId/settings/$section"
        params={{ orgId, section: "skills" }}
        search={{ skill: tg.id }}
        className="ag-rc__target"
      >
        {children}
      </Link>
    );
  if (tg.type === "memory" || tg.type === "skill")
    return (
      <Link
        to="/org/$orgId/agents/$agentId/memory"
        params={{ orgId, agentId: a.agentId }}
        search={{ item: tg.id }}
        className="ag-rc__target"
        onClick={
          openPanel && !rightHand ? (e) => inPlaceClick(e, () => openPanel(a.agentId, "memory", tg.id)) : undefined
        }
      >
        {children}
      </Link>
    );
  return <b>{children}</b>;
}
