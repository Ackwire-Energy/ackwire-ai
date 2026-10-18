import { type AgentAction, ApiError, cacheMessageActions, type Message, useAgentActions } from "@agenteschat/client";
import { actionErrorKey, actionTextKey, actionTextValues } from "@agenteschat/client/lib/actions";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { CHROME_MAX_SCALE, Icon, Text, useLivePaused, useTheme, useToast } from "@/ui";
import { agoOf } from "../agents/logic";
import { agoText } from "../agents/work";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
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
 * What the agent changed with this reply (ADR 0037 round 2, FazerDesfazer.html): one change is a sunken
 * row with Desfazer and the time left (A); two or more are a group with "N mudanças · há X" and
 * Desfazer tudo (B). Undone rows are struck through with "Desfeito por …" and Refazer; past the window
 * they stay as plain history. Optimistic, rolled back with a toast when the server refuses.
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
  const role = useOrg().org?.role;
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const qc = useQueryClient();
  const toast = useToast();
  const ops = useAgentActions(orgId, m.channelId);
  const ownsAgent = Boolean(meId && m.author.id && dir.agentById.get(m.author.id)?.ownerUserId === meId);
  const viewer = { userId: meId, role, ownsAgent };

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
      <View>
        <View style={[styles.one, { backgroundColor: c.sunken }, v.struck && styles.doneRow]}>
          <IconTile kind={a} />
          <Sentence action={a} channelId={m.channelId} struck={v.struck} size="one" />
          <RowButton view={v} big onUndo={() => undo(a)} onRedo={() => redo(a)} />
        </View>
        {a.undoneAt ? <UndoneBy action={a} /> : null}
      </View>
    );
  }

  const live = rows.filter((r) => r.v.button === "undo").map((r) => r.a.id);
  const start = groupStart(list);
  return (
    <View style={[styles.group, { backgroundColor: c.sunken }]}>
      <View style={styles.hd}>
        <Text variant="small" tone="muted" style={styles.grow} numberOfLines={1}>
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
        <View key={a.id} style={[styles.it, { borderTopColor: c.line }]}>
          <Icon name={receiptIcon(a.kind)} size={14} color={c.muted} />
          <View style={styles.grow}>
            <Sentence action={a} channelId={m.channelId} struck={v.struck} size="item" />
            {a.undoneAt ? <UndoneBy action={a} /> : null}
          </View>
          <RowButton view={v} onUndo={() => undo(a)} onRedo={() => redo(a)} />
        </View>
      ))}
    </View>
  );
}

function IconTile({ kind: a }: { kind: AgentAction }) {
  const { colors, shadows } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.raised, boxShadow: shadows.e1 }]}>
      <Icon name={receiptIcon(a.kind)} size={14} color={colors.ink2} />
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
  const values = actionTextValues(a, (key, options) => t(key, options) as string, meId ?? undefined);
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
      tone={size === "one" ? "muted" : "ink2"}
      numberOfLines={1}
      style={[styles.grow, struck && styles.struck]}
      onPress={open}
      accessibilityRole={open ? "link" : undefined}
      suppressHighlighting
    >
      {runs.map((r, i) =>
        r.bold ? (
          <Text key={String(i)} variant={size === "one" ? "small" : "footnote"} tone="ink" style={styles.bold}>
            {r.text}
          </Text>
        ) : (
          r.text
        ),
      )}
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
    <Text variant="caption" tone="faint" style={styles.undoneBy} numberOfLines={1}>
      {t("agentActions.undoneBy", { name })}
    </Text>
  );
}

/** Desfazer (with the time left in Doto) or Refazer; nothing once settled or for who may not use it. */
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
  const { colors, fonts } = useTheme();
  if (!v.button) return null;
  if (v.button === "redo")
    return (
      <Pressable onPress={onRedo} accessibilityRole="button" hitSlop={8}>
        <Text variant={big ? "small" : "footnote"} tone={big ? "ink" : "muted"} style={styles.bold}>
          {t("agentActions.redo")}
        </Text>
      </Pressable>
    );
  return (
    <Pressable
      onPress={onUndo}
      accessibilityRole="button"
      accessibilityLabel={big ? `${t("agentActions.undo")}, ${v.timeLeft}` : t("agentActions.undo")}
      hitSlop={8}
      style={styles.u}
    >
      {big ? <Icon name="undo" size={14} color={colors.ink} /> : null}
      <Text variant={big ? "small" : "footnote"} tone={big ? "ink" : "muted"} style={styles.bold}>
        {t("agentActions.undo")}
      </Text>
      {big && v.timeLeft ? (
        <RNText
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={{ fontFamily: fonts.dot, fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}
        >
          {v.timeLeft}
        </RNText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  one: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingLeft: 9,
    paddingRight: 10,
    borderRadius: 14,
    maxWidth: 340,
  },
  doneRow: { opacity: 0.75 },
  tile: { width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  u: { flexDirection: "row", alignItems: "center", gap: 5 },
  undoneBy: { marginTop: 4 },
  group: { marginTop: 8, borderRadius: 16, overflow: "hidden", maxWidth: 340 },
  hd: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, paddingHorizontal: 12 },
  it: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
