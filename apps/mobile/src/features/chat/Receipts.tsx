import {
  type AgentAction,
  ApiError,
  cacheMessageActions,
  type Message,
  useAgentActions,
  useApi,
} from "@agenteschat/client";
import {
  actionErrorKey,
  actionTextKey,
  actionTextValues,
  formatTimeLeft,
  hookToCopy,
  routineOwnActions,
} from "@agenteschat/client/lib/actions";
import { ownActionName } from "@agenteschat/client/lib/approval-words";
import { joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { LineIcon, PillButton, Text, useLivePaused, useToast } from "@/ui";
import { agoOf } from "../agents/logic";
import { agoText } from "../agents/work";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { copyText, tapHaptic } from "../shared/parts";
import {
  anyLive,
  boldRuns,
  groupStart,
  optimisticRedo,
  optimisticUndo,
  type ReceiptView,
  receiptIcon,
  receiptLayout,
  receiptView,
  targetHref,
  viewerCanUndo,
} from "./actions";

/**
 * What the agent changed with this reply (ADR 0037 round 2), on the card of the reply's tools (a hairline, the cut
 * corner): one change is a row with a raised Desfazer and the time left in it (A); two or more are a group with
 * "N mudanças · há X" and Desfazer tudo (B). The sentence wraps, whole, and a button that goes keeps its room, so it
 * never rewraps. Undone rows are struck through with "Desfeito por …" and Refazer; past the window they stay as plain
 * history. Optimistic, rolled back with a toast when the server refuses.
 */
export function Receipts({ message: m }: { message: Message }) {
  const list = m.actions ?? [];
  const layout = receiptLayout(list);
  const now = useTick(layout !== "none" && anyLive(list));
  if (layout === "none") return null;
  return <ReceiptList message={m} list={list} now={now} group={layout === "group"} />;
}

/** Now, every second while something counts down and the screen is showing (LivePause); else frozen. */
function useTick(active: boolean): number {
  const paused = useLivePaused();
  const running = active && !paused;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function ReceiptList({
  message: m,
  list,
  now,
  group,
}: {
  message: Message;
  list: AgentAction[];
  now: number;
  group: boolean;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const managesAgents = can(useOrg().org, "manage_agents");
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const qc = useQueryClient();
  const toast = useToast();
  const ops = useAgentActions(orgId, m.channelId);
  const ownsAgent = Boolean(meId && m.author.id && dir.agentById.get(m.author.id)?.ownerUserId === meId);
  const viewer = { userId: meId, managesAgents, ownsAgent };

  const fail = (err: unknown) => {
    const code = err instanceof ApiError ? err.code : "";
    const generic = t("agentActions.errors.generic");
    toast({ title: code ? t(actionErrorKey(code), { defaultValue: generic }) : generic, icon: "x" });
  };
  /** Shows `next` now, runs the call, and puts `list` back when it fails. */
  const optimistic = (next: AgentAction[], call: () => Promise<unknown>) => {
    tapHaptic();
    cacheMessageActions(qc, orgId, m.channelId, m.id, next);
    call().catch((err) => {
      cacheMessageActions(qc, orgId, m.channelId, m.id, list);
      fail(err);
    });
  };
  const undo = (a: AgentAction) =>
    optimistic(optimisticUndo(list, [a.id], meId ?? ""), () => ops.undo.mutateAsync(a.id));
  const redo = (a: AgentAction) => optimistic(optimisticRedo(list, a.id), () => ops.redo.mutateAsync(a.id));
  const undoAll = (ids: string[]) =>
    optimistic(optimisticUndo(list, ids, meId ?? ""), () =>
      ops.undoAll.mutateAsync(m.id).then((out) => {
        const first = out.failed[0];
        if (out.failed.length === 1 && first) fail(new ApiError(409, first.code, first.message));
        else if (out.failed.length > 1)
          toast({ title: t("agentActions.partial", { count: out.failed.length }), icon: "x" });
      }),
    );

  const rows = list.map((a) => ({ a, v: receiptView(a, viewerCanUndo(a, viewer), now) }));

  if (!group) {
    const { a, v } = rows[0] as { a: AgentAction; v: ReceiptView };
    return (
      <View style={[styles.one, styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        <View style={styles.oneTx}>
          <LineIcon name={receiptIcon(a.kind)} size={16} color={c.muted} variant="small" text={styles.oneText} />
        </View>
        <View style={[styles.grow, styles.oneTx]}>
          <Sentence action={a} channelId={m.channelId} struck={v.struck} size="one" />
          <OwnActions action={a} />
          {a.undoneAt ? <UndoneBy action={a} /> : <CopyHook action={a} />}
        </View>
        <RowButton view={v} big onUndo={() => undo(a)} onRedo={() => redo(a)} />
      </View>
    );
  }

  const live = rows.filter((r) => r.v.button === "undo").map((r) => r.a.id);
  const start = groupStart(list);
  return (
    <View style={[styles.group, styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      <View style={styles.hd}>
        <Text variant="small" tone="muted" style={styles.grow}>
          <Text variant="small" tone="ink" style={styles.bold}>
            {t("agentActions.changes", { count: list.length })}
          </Text>
          {start ? ` · ${agoText(t, agoOf(start, now))}` : ""}
        </Text>
        {live.length > 1 ? (
          <Pressable onPress={() => undoAll(live)} accessibilityRole="button" hitSlop={8}>
            <Text variant="small" tone="ink" style={styles.bold}>
              {t("agentActions.undoAll")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {rows.map(({ a, v }) => (
        <View key={a.id} style={[styles.it, { borderTopColor: c.line2 }]}>
          <LineIcon name={receiptIcon(a.kind)} size={16} color={c.muted} variant="footnote" />
          <View style={styles.grow}>
            <Sentence action={a} channelId={m.channelId} struck={v.struck} size="item" />
            <OwnActions action={a} />
            {a.undoneAt ? <UndoneBy action={a} /> : <CopyHook action={a} />}
          </View>
          <RowButton view={v} onUndo={() => undo(a)} onRedo={() => redo(a)} />
        </View>
      ))}
    </View>
  );
}

/** The sentence ("Criei a issue **#23** · …"); the bold part opens the target when the phone has its screen. */
function Sentence({
  action: a,
  channelId,
  struck,
  size,
}: {
  action: AgentAction;
  channelId: string;
  struck: boolean;
  size: "one" | "item";
}) {
  const { t } = useTranslation();
  const href = targetHref(a.target, channelId);
  const meId = useMeId();
  const values = actionTextValues(a, t, meId ?? undefined);
  const runs = boldRuns(t(actionTextKey(a), values) as string);
  const open = href
    ? () => {
        tapHaptic();
        router.push(href);
      }
    : undefined;
  return (
    <Text
      variant={size === "one" ? "small" : "footnote"}
      tone={struck ? "faint" : "ink2"}
      style={[size === "one" && styles.oneText, struck && styles.struck]}
      onPress={open}
      accessibilityRole={open ? "link" : undefined}
      suppressHighlighting
    >
      {runs.map((r, i) =>
        r.bold ? (
          <Text
            key={String(i)}
            variant={size === "one" ? "small" : "footnote"}
            tone={struck ? "faint" : "ink"}
            style={[size === "one" && styles.oneText, styles.bold]}
          >
            {r.text}
          </Text>
        ) : (
          r.text
        ),
      )}
    </Text>
  );
}

/**
 * A webhook routine the agent just made: its address, kept out of the message text, copied from here by who may
 * manage the routine (the person who asked, admins; the server checks again).
 */
function CopyHook({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const meId = useMeId();
  const manages = can(useOrg().org, "manage_routines");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const routineId = hookToCopy(a, { userId: meId, managesRoutines: manages });
  if (!routineId) return null;
  const copy = async () => {
    tapHaptic();
    setBusy(true);
    try {
      const hook = await api.routines.hook(orgId, routineId);
      const ok = await copyText(hook.url);
      toast({ title: t(ok ? "routines.webhookCopied" : "agentActions.errors.generic"), icon: ok ? "check" : "x" });
    } catch {
      toast({ title: t("agentActions.errors.generic"), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Pressable
      onPress={() => void copy()}
      disabled={busy}
      accessibilityRole="button"
      hitSlop={8}
      style={styles.copyHook}
    >
      <Text variant="footnote" tone="ink" style={styles.bold}>
        {t("agentActions.copyWebhook")}
      </Text>
    </Pressable>
  );
}

/** Under a created routine: what it does in connected apps without asking. */
function OwnActions({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const own = routineOwnActions(a);
  if (own.length === 0) return null;
  return (
    <Text variant="caption" tone="faint" style={styles.undoneBy}>
      {t("agentActions.routine.ownActions", {
        actions: joinNames(
          own.map((name) => ownActionName(t, name)),
          t,
        ),
      })}
    </Text>
  );
}

/** "Desfeito por você" / "Desfeito por Ana". */
function UndoneBy({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const meId = useMeId();
  const dir = useDirectory();
  const name =
    a.undoneByUserId && a.undoneByUserId === meId
      ? t("agentActions.you")
      : dir.nameOf({ type: "user", id: a.undoneByUserId }) || t("mobile.chat.someone");
  return (
    <Text variant="caption" tone="faint" style={styles.undoneBy}>
      {t("agentActions.undoneBy", { name })}
    </Text>
  );
}

/**
 * Desfazer or Refazer: a raised pill next to one change, Desfazer with the time left in it; a quiet word in a group.
 * None for who may not use it. Once it had one, its room stays when its time is up, empty: the sentence never
 * rewraps.
 */
function RowButton({
  view: v,
  big = false,
  onUndo,
  onRedo,
}: {
  view: ReceiptView;
  big?: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const { t } = useTranslation();
  const had = useRef<ReceiptView["button"]>(null);
  if (v.button) had.current = v.button;
  const shown = v.button ?? had.current;
  if (!shown) return null;
  const redo = shown === "redo";
  const label = redo ? t("agentActions.redo") : t("agentActions.undo");
  const button = big ? (
    <PillButton
      label={label}
      detail={redo ? undefined : v.timeLeft || formatTimeLeft(0)}
      onPress={redo ? onRedo : onUndo}
      accessibilityLabel={!redo && v.timeLeft ? `${label}, ${v.timeLeft}` : label}
    />
  ) : (
    <Pressable onPress={redo ? onRedo : onUndo} accessibilityRole="button" hitSlop={8}>
      <Text variant="footnote" tone="muted" style={styles.bold}>
        {label}
      </Text>
    </Pressable>
  );
  return v.button ? button : <Room>{button}</Room>;
}

/** A button gone, its room kept: not seen, not read, not tapped. */
function Room({ children }: { children: ReactNode }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.room}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  // The tool block's card (ToolCalls.tsx): a hairline and the cut corner, bottom left.
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
  },
  // The 16-point icon (as the conversation's event lines), the sentence's first line and the 32px pill share one
  // middle; the sentence wraps under it.
  one: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    minHeight: 50,
    paddingVertical: 9,
    paddingLeft: 12,
    paddingRight: 10,
  },
  oneTx: { paddingTop: 6 },
  oneText: { fontSize: 14.5, lineHeight: 19 },
  undoneBy: { marginTop: 2 },
  copyHook: { alignSelf: "flex-start", marginTop: 6, paddingVertical: 2 },
  room: { opacity: 0 },
  group: { marginTop: 12, overflow: "hidden" },
  hd: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, paddingHorizontal: 12 },
  it: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
