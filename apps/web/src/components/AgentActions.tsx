import type { AgentAction, Message } from "@agenteschat/client";
import { ApiError, useAgentActions, useApi, useIssue } from "@agenteschat/client";
import { actionCardOf } from "@agenteschat/client/lib/action-cards";
import {
  actionErrorKey,
  actionPhase,
  actionTextKey,
  actionTextValues,
  actionTimeLeft,
  canUndoAction,
  formatTimeLeft,
  hookToCopy,
  routineOwnActions,
  undoableNow,
} from "@agenteschat/client/lib/actions";
import { ownActionName } from "@agenteschat/client/lib/approval-words";
import { joinNames, relativeTime, toYmd } from "@agenteschat/client/lib/format";
import { handedTasksOf } from "@agenteschat/client/lib/issues";
import { can } from "@agenteschat/client/lib/permissions";
import { cx, Icon, type IconName, onScreenNow } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
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
 * Act with undo (ADR 0037 round 2): what an
 * agent changed with this reply, under the message. One change: a quiet
 * sunken row with Desfazer and the time left (A). Several: "3 mudanças · há
 * 1 min" with Desfazer tudo and one row each (B). Undone: struck through,
 * "Desfeito por …" and Refazer while the window lasts; after it, plain
 * history. Buttons only for who may undo (`canUndoAction`; the server checks
 * again). Optimistic, rolled back with a toast on error.
 */
export function AgentActionReceipts({ message }: { message: Message }) {
  // The right hand's settings card says what was applied and has its own Desfazer (ADR 0137).
  const onCard = actionCardOf(message.meta)?.kind === "settings_proposal";
  // A task the right hand handed on is its chip (`HandedTaskChips`): its agent is at work on it already.
  const handed = new Set(handedTasksOf(message.meta).map((h) => h.issueId));
  const list = (message.actions ?? []).filter(
    (a) => !(onCard && a.kind === "agent.settings_changed") && !(a.kind === "issue.created" && handed.has(a.target.id)),
  );
  if (message.author.type !== "agent" || list.length === 0) return null;
  return <Receipts message={message} list={list} />;
}

type Override = Pick<AgentAction, "undoneAt" | "undoneByUserId">;

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
};

/** A kind a newer server sends that this build doesn't know yet gets the plain check. */
const iconOf = (a: AgentAction): IconName =>
  a.kind === "issue.updated" && Array.isArray(a.params.fields) && a.params.fields.join() === "priority"
    ? "flag"
    : (RECEIPT_ICONS[a.kind] ?? "check");

/** The clock for the countdowns: ticks each second only while the receipts are on screen and some can still change. */
function useVisibleNow(ref: RefObject<HTMLElement | null>, live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setVisible(onScreenNow(entries) === true));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    if (!live || !visible) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live, visible]);
  return now;
}

function errorMessage(t: TFunction, error: unknown) {
  const generic = t("agentActions.errors.generic");
  return error instanceof ApiError ? t(actionErrorKey(error.code), { defaultValue: generic }) : generic;
}

function Receipts({ message, list: server }: { message: Message; list: AgentAction[] }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const mutations = useAgentActions(org.id, message.channelId);
  const ref = useRef<HTMLDivElement>(null);
  // Optimistic undo/redo until the server answers (an error rolls back).
  const [pending, setPending] = useState<Record<string, Override>>({});
  const list = server.map((a) => (pending[a.id] ? { ...a, ...pending[a.id] } : a));
  const live = server.some((a) => actionPhase(a) !== "settled");
  const now = useVisibleNow(ref, live);
  const agent = dir.agentById.get(message.author.id ?? "");
  const viewer = {
    userId: me.user.id,
    managesAgents: can(org, "manage_agents"),
    ownsAgent: agent?.ownerUserId === me.user.id,
  };

  const hold = (ids: string[], o: Override | null) =>
    setPending((p) => {
      const next = { ...p };
      for (const id of ids) {
        if (o) next[id] = o;
        else delete next[id];
      }
      return next;
    });
  const undone: Override = { undoneAt: new Date().toISOString(), undoneByUserId: me.user.id };
  const undo = (a: AgentAction) => {
    hold([a.id], undone);
    mutations.undo.mutate(a.id, {
      onSettled: () => hold([a.id], null),
      onError: (error) => toast.show(errorMessage(t, error), "error"),
    });
  };
  const redo = (a: AgentAction) => {
    hold([a.id], { undoneAt: null, undoneByUserId: null });
    mutations.redo.mutate(a.id, {
      onSettled: () => hold([a.id], null),
      onError: (error) => toast.show(errorMessage(t, error), "error"),
    });
  };
  const undoAll = () => {
    const ids = undoableNow(list, now).map((a) => a.id);
    hold(ids, undone);
    mutations.undoAll.mutate(message.id, {
      onSettled: () => hold(ids, null),
      onSuccess: (result) => {
        if (result.failed.length) toast.show(t("agentActions.partial", { count: result.failed.length }), "error");
      },
      onError: (error) => toast.show(errorMessage(t, error), "error"),
    });
  };

  const byName = (a: AgentAction) =>
    a.undoneByUserId === me.user.id
      ? t("agentActions.you")
      : (dir.memberById.get(a.undoneByUserId ?? "")?.name ?? t("agentActions.someone"));

  const row = (a: AgentAction, single: boolean) => {
    const phase = actionPhase(a, now);
    const canAct = phase !== "settled" && canUndoAction(a, viewer);
    const busy = Boolean(pending[a.id]);
    return (
      <Receipt
        key={a.id}
        action={a}
        single={single}
        phase={phase}
        undoneBy={a.undoneAt ? byName(a) : null}
        button={
          !canAct ? null : phase === "undo" ? (
            <button type="button" className="ag-rc__btn" disabled={busy} onClick={() => undo(a)}>
              {single && <Icon name="undo" size={14} />}
              {t("agentActions.undo")}
              {single && (
                <span
                  className="ag-rc__time ac-num"
                  title={t("agentActions.timeLeft", { time: formatTimeLeft(actionTimeLeft(a, now)) })}
                >
                  {formatTimeLeft(actionTimeLeft(a, now))}
                </span>
              )}
            </button>
          ) : (
            <button type="button" className="ag-rc__btn" disabled={busy} onClick={() => redo(a)}>
              {t("agentActions.redo")}
            </button>
          )
        }
      />
    );
  };

  const agentName = agent?.name ?? dir.authorName(message.author);
  if (list.length === 1) {
    const only = list[0] as AgentAction;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
      <div ref={ref} className="ag-rcs" role="group" aria-label={t("agentActions.group", { name: agentName })}>
        {row(only, true)}
      </div>
    );
  }
  const first = list.reduce((min, a) => (a.createdAt < min ? a.createdAt : min), list[0]?.createdAt ?? "");
  const canUndoAll = undoableNow(list, now).some((a) => canUndoAction(a, viewer));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div ref={ref} className="ag-rcg" role="group" aria-label={t("agentActions.group", { name: agentName })}>
      <div className="ag-rcg__hd">
        <span>
          <b>{t("agentActions.changes", { count: list.length })}</b> ·{" "}
          {relativeTime(t, i18n.language, first, new Date(now))}
        </span>
        <span className="ag-rcg__grow" />
        {canUndoAll && (
          <button type="button" className="ag-rc__btn" disabled={mutations.undoAll.isPending} onClick={undoAll}>
            {t("agentActions.undoAll")}
          </button>
        )}
      </div>
      {list.map((a) => row(a, false))}
    </div>
  );
}

function Receipt({
  action: a,
  single,
  phase,
  undoneBy,
  button,
}: {
  action: AgentAction;
  single: boolean;
  phase: ReturnType<typeof actionPhase>;
  undoneBy: string | null;
  button: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  // A routine's schedule from its rule, in the person's language (the server's words are English).
  const { context, ...values } = actionTextValues(a, t, me.user.id, {
    schedule: (rule) => ruleSentence(t, i18n.language, fromApiRule(rule, toYmd(new Date())), new Date()),
  });
  const struck = Boolean(a.undoneAt);
  const ownActions = routineOwnActions(a);
  // Once it had a button, its room stays: Desfazer turning into Refazer, or leaving when its time is up, never
  // rewraps the sentence.
  const hadButton = useRef(false);
  if (button) hadButton.current = true;
  return (
    <div className={cx(single ? "ag-rc" : "ag-rcg__it", struck && "is-undone")} data-phase={phase}>
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
        {undoneBy && <span className="ag-rc__by">{t("agentActions.undoneBy", { name: undoneBy })}</span>}
        {a.kind === "issue.created" && !struck && <ReceiptWhoSees action={a} />}
        <CopyHookButton action={a} />
      </span>
      {hadButton.current && (
        <span className="ag-rc__act">
          {button}
          <span className="ag-rc__room" aria-hidden="true">
            <span className="ag-rc__btn">
              {single && <Icon name="undo" size={14} />}
              {t("agentActions.undo")}
              {single && <span className="ag-rc__time ac-num">{formatTimeLeft(0)}</span>}
            </span>
            <span className="ag-rc__btn">{t("agentActions.redo")}</span>
          </span>
        </span>
      )}
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
 * The bold target in the sentence opens it: the issue, the routine, the wiki page, the channel, the thread, the memory.
 * In a conversation the task and the routine open in their dialog over it, the thread and the memory in the panel
 * beside it; the link still goes to their page (a new tab, a middle click).
 */
function ReceiptTarget({ action: a, children }: { action: AgentAction; children?: ReactNode }) {
  const { org } = useOrg();
  const orgId = org.id;
  const inPlace = useInPlace();
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
  if (tg.type === "memory")
    return (
      <Link
        to="/org/$orgId/agents/$agentId/memory"
        params={{ orgId, agentId: a.agentId }}
        className="ag-rc__target"
        onClick={openPanel ? (e) => inPlaceClick(e, () => openPanel(a.agentId, "memory")) : undefined}
      >
        {children}
      </Link>
    );
  return <b>{children}</b>;
}
