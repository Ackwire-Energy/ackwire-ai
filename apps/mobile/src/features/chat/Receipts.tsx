import {
  type AgentAction,
  ApiError,
  cacheMessageActions,
  type Message,
  useAgentActions,
  useApi,
} from "@agenteschat/client";
import { actionCardOf } from "@agenteschat/client/lib/action-cards";
import {
  actionErrorKey,
  actionTextKey,
  actionTextValues,
  formatTimeLeft,
  hookToCopy,
  receiptFiles,
  routineOwnActions,
} from "@agenteschat/client/lib/actions";
import { ownActionName } from "@agenteschat/client/lib/approval-words";
import { joinNames } from "@agenteschat/client/lib/format";
import { handedTasksOf } from "@agenteschat/client/lib/issues";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { LineIcon, Text, useLivePaused, useReducedMotion, useToast } from "@/ui";
import { router } from "@/ui/navigation";
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
import { useCardTop } from "./look";

/**
 * What the agent changed with this reply (ADR 0037 round 2), on the card of the reply's tools (a hairline, the cut
 * corner): one change is a row whose sentence ends in Desfazer and the time left (A); two or more are a group with
 * "N mudanças · há X" and Desfazer tudo (B). Desfazer wraps with the sentence's words, never a column beside them, and
 * once it goes its room stays, so nothing under it moves. Undone rows are struck through with "Desfeito por …" and
 * Refazer; past the window they stay as plain history. Optimistic, rolled back with a toast when the server refuses.
 */
export function Receipts({ message: m }: { message: Message }) {
  // A task the right hand handed on is its chip (`HandedTaskChips`): its agent is at work on it already.
  const handed = new Set(handedTasksOf(m.meta).map((h) => h.issueId));
  // A workspace change's card says what was applied and has its own Undo.
  const onCard = actionCardOf(m.meta)?.kind === "workspace_action";
  const list = (m.actions ?? []).filter(
    (a) => !(a.kind === "issue.created" && handed.has(a.target.id)) && !(onCard && a.kind === "workspace.changed"),
  );
  const layout = receiptLayout(list);
  const now = useTick(layout !== "none" && anyLive(list));
  // A card under the message's words: the body's card gap above it, as every card in a message.
  const cardTop = useCardTop();
  if (layout === "none") return null;
  // What changes while it shows (undone, Redo) fades in; what is there when it mounts just shows.
  return (
    <View style={cardTop}>
      <LayoutAnimationConfig skipEntering>
        <ReceiptList message={m} list={list} now={now} group={layout === "group"} />
      </LayoutAnimationConfig>
    </View>
  );
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
        <LineIcon name={receiptIcon(a.kind)} size={15} color={c.muted} variant="small" />
        <View style={styles.grow}>
          <Sentence
            action={a}
            channelId={m.channelId}
            struck={v.struck}
            size="one"
            undo={{ view: v, onUndo: () => undo(a), onRedo: () => redo(a) }}
          />
          <OwnActions action={a} />
          {a.undoneAt ? <UndoneBy action={a} /> : <HandyLines action={a} />}
        </View>
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
          <Pressable
            onPress={() => undoAll(live)}
            accessibilityRole="button"
            hitSlop={12}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text variant="small" tone="ink" style={styles.bold}>
              {t("agentActions.undoAll")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {rows.map(({ a, v }) => (
        <View key={a.id} style={[styles.it, { borderTopColor: c.line2 }]}>
          <LineIcon name={receiptIcon(a.kind)} size={13} color={c.muted} variant="footnote" />
          <View style={styles.grow}>
            <Sentence
              action={a}
              channelId={m.channelId}
              struck={v.struck}
              size="item"
              undo={{ view: v, onUndo: () => undo(a), onRedo: () => redo(a) }}
            />
            <OwnActions action={a} />
            {a.undoneAt ? <UndoneBy action={a} /> : <HandyLines action={a} />}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Desfazer or Refazer at the end of a sentence; none for who may not use it. */
interface UndoProps {
  view: ReceiptView;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * The sentence ("Criei a issue **#23** · …"); the bold part opens the target when the phone has its screen. `undo`
 * ends it: Desfazer and the time left on one change, the word alone in a group, wrapping with the words. Once it had
 * one its room stays when its time is up, unseen and untouchable, so the card never shrinks under a reader.
 */
function Sentence({
  action: a,
  channelId,
  struck,
  size,
  undo,
}: {
  action: AgentAction;
  channelId: string;
  struck: boolean;
  size: "one" | "item";
  undo?: UndoProps;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const href = targetHref(a.target, channelId);
  const meId = useMeId();
  const values = actionTextValues(a, t, meId ?? undefined);
  const runs = boldRuns(t(actionTextKey(a), values) as string);
  const open = href ? () => router.push(href) : undefined;
  const variant = size === "one" ? "small" : "footnote";
  const had = useRef<ReceiptView["button"]>(null);
  if (undo?.view.button) had.current = undo.view.button;
  const shown = undo ? (undo.view.button ?? had.current) : null;
  const unseen = Boolean(shown && !undo?.view.button);
  const redo = shown === "redo";
  const label = redo ? t("agentActions.redo") : t("agentActions.undo");
  // One change shows the time left; past it, its room keeps the last second's width.
  const time = shown && !redo && size === "one" ? undo?.view.timeLeft || formatTimeLeft(0) : null;
  return (
    <Text
      variant={variant}
      tone={struck ? "faint" : "ink2"}
      style={struck && styles.struck}
      onPress={open}
      accessibilityRole={open ? "link" : undefined}
      // Its room unseen: read the words alone.
      accessibilityLabel={unseen ? runs.map((r) => r.text).join("") : undefined}
      suppressHighlighting
      // Greedy breaks: what ends the sentence never moves the words before it.
      textBreakStrategy="simple"
      lineBreakStrategyIOS="none"
    >
      {runs.map((r, i) =>
        r.bold ? (
          <Text key={String(i)} variant={variant} tone={struck ? "faint" : "ink"} style={styles.bold}>
            {r.text}
          </Text>
        ) : (
          r.text
        ),
      )}
      {shown && undo ? (
        <>
          {" "}
          <Text
            key={shown}
            variant={variant}
            tone="muted"
            onPress={unseen ? undefined : redo ? undo.onRedo : undo.onUndo}
            accessibilityRole={unseen ? undefined : "button"}
            accessibilityLabel={time && !unseen ? `${label}, ${time}` : label}
            suppressHighlighting
            style={[styles.link, size === "one" && { color: c.agent }, unseen && styles.unseen]}
          >
            {label}
            {/* No-break spaces: the word and its time wrap as one. */}
            {time ? (
              <Text variant={variant} tone="faint" style={[styles.time, unseen && styles.unseen]}>
                {`\u00a0·\u00a0${time}`}
              </Text>
            ) : null}
          </Text>
        </>
      ) : null}
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
      hitSlop={12}
      style={({ pressed }) => [styles.copyHook, pressed && styles.pressed]}
    >
      <Text variant="footnote" tone="ink" style={styles.bold}>
        {t("agentActions.copyWebhook")}
      </Text>
    </Pressable>
  );
}

/** What a receipt offers under its sentence. */
const HandyLines = ({ action }: { action: AgentAction }) => (
  <>
    <FilesLine action={action} />
    <WhoSeesLine action={action} />
    <CopyHook action={action} />
  </>
);

/** Under a task change that brought files: which ones went with it. */
function FilesLine({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const files = receiptFiles(a);
  if (files.length === 0) return null;
  return (
    <Text variant="footnote" tone="muted" style={styles.undoneBy}>
      {t("agentActions.issue.files", { names: joinNames(files, t) })}
    </Text>
  );
}

/** Under a task the agent made: who sees it, and the way to change it (ADR 0151). */
function WhoSeesLine({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const mode = a.params.audience;
  if (a.kind !== "issue.created" || a.undoneAt || (mode !== "everyone" && mode !== "people")) return null;
  const number = Number(a.params.number);
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        router.push({ pathname: "/who-sees", params: { number } });
      }}
      accessibilityRole="button"
      hitSlop={12}
      style={({ pressed }) => [styles.copyHook, pressed && styles.pressed]}
    >
      <Text variant="footnote" tone="muted">
        {t("whoSees.receipt", { who: t(mode === "everyone" ? "whoSees.everyone" : "whoSees.some") })}
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
  const reduced = useReducedMotion();
  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
      <Text variant="caption" tone="faint" style={styles.undoneBy}>
        {t("agentActions.undoneBy", { name })}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  // The tool block's card (ToolCalls.tsx): a hairline and the cut corner, bottom left.
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
  },
  // The icon on the sentence's first line (as the conversation's event lines), the sentence wrapping under it: a
  // list row's 12 above and below, one line 44.
  one: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 12, paddingHorizontal: 12 },
  pressed: { opacity: 0.6 },
  // Desfazer: the action's weight, never the strike of an undone sentence it ends.
  link: { fontWeight: "600", textDecorationLine: "none" },
  time: { fontVariant: ["tabular-nums"] },
  unseen: { color: "transparent" },
  undoneBy: { marginTop: 2 },
  copyHook: { alignSelf: "flex-start", marginTop: 6, paddingVertical: 2 },
  group: { overflow: "hidden" },
  hd: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 12 },
  it: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
