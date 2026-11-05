import {
  keys,
  type Message,
  type MessageConsultation,
  type RunConsultation,
  useConsultationConversation,
  useConsultations,
} from "@agenteschat/client";
import {
  type ConsultLineState,
  type ConsultPairItem,
  consultLineKey,
  consultPair,
  firstOfRun,
  groupsByRun,
  openableConsultation,
  pairItemOf,
} from "@agenteschat/client/lib/consult-group";
import { namesText } from "@agenteschat/client/lib/format";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatLineTime } from "@agenteschat/client/lib/work";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { consultationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";

/** A question's state in words, on the conversation's screen ("A Iris espera uma aprovação"). */
export const consultLineLabel = (
  t: TFunction,
  state: ConsultLineState,
  c: Pick<RunConsultation, "waiting" | "kind">,
  to: ReturnType<typeof agentGrammar>,
) => t(consultLineKey(state, c), { name: to.name, context: to.context });

/** A clock for the open questions' times; still once none is out. */
function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const NO_ITEMS: ConsultPairItem[] = [];
const NO_CONSULTED: MessageConsultation[] = [];

const NO_REACHED: ReadonlySet<string> = new Set();

/**
 * The questions a pair row stands for: those of run `runId` on the run's first message here (`messageId`; null: its
 * live turn, which shows them until the run posts), and those a reply's `meta.consulted` names that the list
 * doesn't have. `reached`: hand-offs the message's reach lines show (`reachHandoffs`), left out here.
 */
export function useRunConsults(
  runId: string | null | undefined,
  where: Pick<Message, "channelId" | "threadId">,
  messageId: string | null,
  consulted: readonly MessageConsultation[] = NO_CONSULTED,
  reached: ReadonlySet<string> = NO_REACHED,
): ConsultPairItem[] {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const list = useConsultations(orgId, where.channelId, Boolean(runId));
  const group = useMemo(() => (runId ? groupsByRun(list.data ?? []).get(runId) : undefined), [list.data, runId]);
  const loaded =
    group && runId
      ? [
          ...(qc.getQueryData<Message[]>(keys.messages(orgId, where.channelId)) ?? []),
          ...((where.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, where.channelId, where.threadId))) ||
            []),
        ]
      : [];
  const first = group && runId ? firstOfRun(loaded, runId) : null;
  const draws = group !== undefined && (messageId === null ? first === null : !first || first === messageId);
  return useMemo(() => {
    const run = group ?? NO_ITEMS;
    const extra = consulted.filter((c) => !run.some((r) => r.id === c.consultationId)).map(pairItemOf);
    const mine = !draws ? NO_ITEMS : reached.size === 0 ? run : run.filter((c) => !reached.has(c.id));
    return extra.length === 0 ? mine : [...mine, ...extra];
  }, [group, consulted, draws, reached]);
}

/**
 * The conversation's question with this id (a hand-off a reach line shows): from its list, or, older than the list
 * goes back, on its own.
 */
export function useConsultById(channelId: string, id: string | undefined): RunConsultation | null {
  const orgId = useOrgId();
  const list = useConsultations(orgId, channelId, Boolean(id));
  const listed = useMemo(() => (id && list.data?.find((c) => c.id === id)) || null, [list.data, id]);
  const alone = useConsultationConversation(orgId, channelId, id && list.isSuccess && !listed ? id : null);
  return listed ?? alone.data?.consultation ?? null;
}

/**
 * The slim row right before a reply whose agent asked other agents first, as on the web (`ConsultGroup.tsx`): the
 * asker's face and name, ⇄, the consulted agent's (several fold into stacked faces, "Atlas e mais 2"), then how long
 * it took, or while it runs "perguntando 42 s", or "não respondeu". Never what they said: a tap opens the two agents'
 * conversation on a screen of its own, read only (`ConsultationScreen`). The same row stands for an answer whose
 * reply is farther up or not here, and for a hand-off by direct message on a reach line (`inline`).
 */
export function ConsultPairRow({
  askerId,
  channelId,
  items,
  inline = false,
}: {
  askerId: string;
  /** The conversation that asked: the screen opens from it. */
  channelId: string;
  items: readonly ConsultPairItem[];
  /** Inside a message (its reach lines): no reply face to line up with. */
  inline?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const live = items.some((x) => x.status === "open");
  const now = useTick(live);
  const pair = consultPair(items, now);
  if (!pair) return null;
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("mobile.chat.someone");
  const from = nameOf(askerId);
  const names = pair.faces.map((f) => nameOf(f.agentId));
  const to = names.length === 1 ? (names[0] ?? "") : namesText(t, names, 1);
  // An old reply's question with no id of its own has no conversation to open.
  const opens = openableConsultation(pair.opens);
  return (
    <View style={inline ? styles.inline : styles.slot}>
      <Pressable
        onPress={() => {
          if (!opens) return;
          tapHaptic();
          router.push(consultationHref(opens, channelId));
        }}
        disabled={!opens}
        accessibilityRole="button"
        // A 28-point row: 8 above and below gives it the 44-point target.
        hitSlop={{ top: 8, bottom: 8 }}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.plate }]}
      >
        <AgentFace agentId={askerId} size={18} live={false} />
        <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1} ellipsizeMode="clip">
          {from}
        </Text>
        <Icon name="swap" size={15} color={pair.tone === "live" ? c.agent : c.faint} />
        <View style={styles.faces}>
          {pair.faces.slice(0, 3).map((f, i) => (
            <View key={f.agentId} style={[i > 0 && [styles.stacked, { borderColor: c.bg }], f.off && styles.off]}>
              <AgentFace agentId={f.agentId} size={18} live={false} />
            </View>
          ))}
        </View>
        <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1} ellipsizeMode="clip">
          {to}
        </Text>
        {pair.word || pair.seconds !== null ? (
          <Text variant="footnote" tone="faint">
            ·
          </Text>
        ) : null}
        {pair.word ? (
          <Text
            variant="footnote"
            style={[styles.word, { color: pair.tone === "bad" ? c.warn : c.agent }]}
            numberOfLines={1}
            ellipsizeMode="clip"
          >
            {t(pair.word.key, pair.word.values)}
          </Text>
        ) : null}
        {pair.seconds !== null ? (
          <Text variant="footnote" tone="faint" style={styles.time}>
            {formatLineTime(i18n.language, pair.seconds * 1000)}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // The first face centred over the reply's 34pt face column (MessageRow): 14 padding + 8 inset + 9 = 14 + 17.
  slot: { flexDirection: "row", paddingLeft: 14, paddingRight: 16, marginTop: 6, marginBottom: -6 },
  // On a reach line the row's own 8pt inset lines its first face up with the line's text.
  inline: { flexDirection: "row", marginLeft: -8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 8,
    borderRadius: 8,
    flexShrink: 1,
  },
  name: { fontWeight: "600", flexShrink: 1 },
  faces: { flexDirection: "row", alignItems: "center" },
  stacked: { marginLeft: -5, borderLeftWidth: 1.5, borderRadius: 6 },
  off: { opacity: 0.45 },
  word: { fontWeight: "600", flexShrink: 1 },
  time: { fontVariant: ["tabular-nums"] },
});
