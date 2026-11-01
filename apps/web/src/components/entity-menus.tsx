import type { Agent, Channel } from "@agenteschat/client";
import { keys, useArchiveChannel, useDms, useMarkChannelRead } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can, managesChannel } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { requestChannelDetails } from "@/lib/channel-details";
import { copyText, type MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { useLiveStore } from "@/realtime/context";
import { useOpenAgentPanel } from "./agent-panel-context";
import { useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";
import { isStoppable, useStopRun } from "./StopRun";

/*
 * One list of actions per entity, for its right click (`entityMenu`, lib/entity-menu.ts) and, where it has one, its
 * "…": a channel, an agent, a person. Each lists only what the app does and what the viewer may do.
 */

const linkTo = (path: string) => `${window.location.origin}${path}`;

/** "Arquivar canal" with "Desfazer" in its toast; leaves the channel's page when it was open. */
export function useArchiveChannelWithUndo() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const archive = useArchiveChannel(org.id);
  const run = (channel: Pick<Channel, "id" | "name">, onDone?: () => void) =>
    archive.mutate(channel.id, {
      onSuccess: () => {
        onDone?.();
        if (router.state.location.pathname.includes(`/c/${channel.id}`))
          void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
        toast.show(t("channel.archived", { channel: channel.name }), "info", {
          label: t("channelCategories.undo"),
          run: () =>
            void api.chat.unarchive(org.id, channel.id).then(async () => {
              await qc.invalidateQueries({ queryKey: keys.channels(org.id) });
              await navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: channel.id } });
            }),
        });
      },
      onError: (e) => toast.show((e as Error).message, "error"),
    });
  return { run, pending: archive.isPending };
}

/** "Marcar como lida" for a channel or DM with unread messages (nothing otherwise). */
function useMarkRead() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const mark = useMarkChannelRead(org.id);
  return (channelId: string | undefined, unread: number): MenuEntry[] =>
    channelId && unread > 0
      ? [
          {
            kind: "item",
            id: "mark-read",
            label: t("contextMenu.markRead"),
            icon: "check",
            run: () => mark.mutate(channelId),
          },
        ]
      : [];
}

/** "Copiar @handle". */
function useCopyHandle() {
  const { t } = useTranslation();
  const toast = useToast();
  return (handle: string | undefined): MenuEntry[] =>
    handle
      ? [
          {
            kind: "item",
            id: "copy-handle",
            label: t("contextMenu.copyHandle", { handle }),
            icon: "copy",
            run: () => void copyText(`@${handle}`, () => toast.show(t("contextMenu.handleCopied"))),
          },
        ]
      : [];
}

/** "Mencionar": `@handle` in the composer, inside a conversation only. */
function useMention() {
  const { t } = useTranslation();
  const actions = useChannelActions();
  return (handle: string | undefined): MenuEntry[] =>
    actions && handle
      ? [
          {
            kind: "item",
            id: "mention",
            label: t("contextMenu.mention"),
            icon: "reply",
            run: () => actions.insertMention(handle),
          },
        ]
      : [];
}

/**
 * A channel (sidebar row, channel header): mark read, its details (edit for who manages it), `extra` (the sidebar's
 * Mover para… and Nova categoria), copy link, archive.
 */
export function useChannelMenu() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const markRead = useMarkRead();
  const archive = useArchiveChannelWithUndo();
  return (c: Channel, extra: MenuEntry[] = []): MenuEntry[] => {
    const manages = managesChannel(c, me.user.id, org);
    return [
      { kind: "header", label: `#${c.name}` },
      ...markRead(c.id, c.unreadCount ?? 0),
      {
        kind: "item",
        id: "edit",
        label: manages ? t("channelCategories.editChannel") : t("channel.details"),
        icon: manages ? "edit" : "info",
        run: () => {
          requestChannelDetails(c.id);
          void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: c.id } });
        },
      },
      ...extra,
      { kind: "separator" },
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () => void copyText(linkTo(`/org/${org.id}/c/${c.id}`), () => toast.show(t("contextMenu.linkCopied"))),
      },
      ...(manages && c.name !== "general"
        ? ([
            { kind: "separator" },
            {
              kind: "item",
              id: "archive",
              label: t("channel.archive"),
              icon: "archive",
              danger: true,
              run: () => archive.run(c),
            },
          ] satisfies MenuEntry[])
        : []),
    ];
  };
}

/**
 * An agent (sidebar row, its face or name in a message): talk, its profile, mention, copy @, mark its DM read, edit
 * (its owner and admins), its link, and stop while it works.
 */
export function useAgentMenu() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const openPanel = useOpenAgentPanel();
  const live = useLiveStore();
  const runs = useStopRun();
  const dms = useDms(org.id).data;
  const markRead = useMarkRead();
  const copyHandle = useCopyHandle();
  const mention = useMention();
  return (a: Pick<Agent, "id" | "name" | "handle" | "ownerUserId">): MenuEntry[] => {
    const dm = dms?.find((d) => d.with.id === a.id);
    const edits = can(org, "manage_agents") || a.ownerUserId === me.user.id;
    const working = Object.values(live.get().streams.runs).filter(
      (r) => r.agentId === a.id && isStoppable(r) && runs.canStop(r),
    );
    const page = (tab?: "settings") =>
      void navigate({
        to: "/org/$orgId/agents/$agentId",
        params: { orgId: org.id, agentId: a.id },
        search: tab ? { tab } : {},
      });
    return [
      { kind: "header", label: a.name },
      {
        kind: "item",
        id: "dm",
        label: t("profile.dm"),
        icon: "message",
        run: () => void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: a.id } }),
      },
      {
        kind: "item",
        id: "profile",
        label: t("profile.viewProfile"),
        icon: "agent",
        run: () => (openPanel ? openPanel(a.id) : page()),
      },
      ...mention(a.handle),
      ...copyHandle(a.handle),
      ...markRead(dm?.channelId, dm?.unread ?? 0),
      { kind: "separator" },
      ...(edits
        ? ([
            { kind: "item", id: "edit", label: t("contextMenu.editAgent"), icon: "edit", run: () => page("settings") },
          ] satisfies MenuEntry[])
        : []),
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () =>
          void copyText(linkTo(`/org/${org.id}/dm/agent/${a.id}`), () => toast.show(t("contextMenu.linkCopied"))),
      },
      ...(working.length
        ? ([
            { kind: "separator" },
            {
              kind: "item",
              id: "stop",
              label: t("run.stopAgent", agentGrammar(t, a.name)),
              icon: "stop",
              danger: true,
              run: () => {
                for (const r of working) runs.stop(r);
              },
            },
          ] satisfies MenuEntry[])
        : []),
    ];
  };
}

/** A person (sidebar row, their face or name in a message): DM, their card (`openCard`), mention, copy @, mark read. */
export function usePersonMenu() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const dms = useDms(org.id).data;
  const markRead = useMarkRead();
  const copyHandle = useCopyHandle();
  const mention = useMention();
  return (p: { userId: string; name: string; handle?: string | null }, openCard?: () => void): MenuEntry[] => {
    const dm = dms?.find((d) => d.with.id === p.userId);
    const handle = p.handle ?? undefined;
    return [
      { kind: "header", label: p.name },
      ...(p.userId !== me.user.id
        ? ([
            {
              kind: "item",
              id: "dm",
              label: t("profile.dm"),
              icon: "message",
              run: () =>
                void navigate({ to: "/org/$orgId/dm/person/$userId", params: { orgId: org.id, userId: p.userId } }),
            },
          ] satisfies MenuEntry[])
        : []),
      ...(openCard
        ? ([
            { kind: "item", id: "profile", label: t("profile.viewProfile"), icon: "person", run: openCard },
          ] satisfies MenuEntry[])
        : []),
      ...mention(handle),
      ...copyHandle(handle),
      ...markRead(dm?.channelId, dm?.unread ?? 0),
    ];
  };
}
