import { type Message, useMachines } from "@agenteschat/client";
import { awayText } from "@agenteschat/client/lib/computer-queue";
import { brainUnavailableOf, waitCardState, waitsForComputer } from "@agenteschat/client/lib/machine-outages";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, LineIcon, ProviderLogo, Text } from "@/ui";
import { useColors, useEdition, useNow, useOrgId } from "../shared/hooks";
import { waitCardText } from "./logic";
import { openSwitchComputer } from "./OutageNotice";
import { useMachineOutages } from "./queries";

/**
 * A `brain_unavailable` message as its waiting card, or null when it stays a plain message (it doesn't say
 * which computer, or the outages can't be read: only who manages the agents can).
 */
function useBrainWait(m: Pick<Message, "meta" | "author">) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const info = brainUnavailableOf(m.meta);
  const outages = useMachineOutages();
  const machines = useMachines(orgId);
  if (!info?.machineId || !waitsForComputer(info)) return null;
  const state = waitCardState(info, outages.data?.outages, m.author.type === "agent" ? m.author.id : null);
  const name = machines.data?.find((x) => x.id === info.machineId)?.name ?? null;
  const text = waitCardText(t, state, info.brain, name);
  if (!text) return null;
  return { ...text, machineId: info.machineId, brain: info.brain };
}

/**
 * In a message whose meta says `brain_unavailable` with its computer: the waiting card when it can be told,
 * else `fallback` (the message's text). Mounted only for those messages, so other chats never ask.
 */
export function BrainWait({ message, fallback }: { message: Pick<Message, "meta" | "author">; fallback: ReactNode }) {
  const card = useBrainWait(message);
  return card ? <WaitCard card={card} /> : fallback;
}

/**
 * "Away 3 min" on the waiting card's name line, beside its time, while its computer is still away and the agent
 * still waits for it (never in the card's own words).
 */
export function AwayPill({ message: m }: { message: Pick<Message, "meta" | "author"> }) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow(30_000);
  const outages = useMachineOutages();
  const info = brainUnavailableOf(m.meta);
  if (!info?.machineId) return null;
  const state = waitCardState(info, outages.data?.outages, m.author.type === "agent" ? m.author.id : null);
  const o = state.kind === "waiting" ? outages.data?.outages.find((x) => x.machineId === state.machineId) : undefined;
  if (!o) return null;
  return (
    <View style={[styles.pill, { backgroundColor: `${c.amber}22` }]}>
      <Text variant="caption" numberOfLines={1} style={[styles.pillText, { color: c.amber }]}>
        {awayText(t, o.offlineSince, now)}
      </Text>
    </View>
  );
}

/**
 * The agent's one card while it waits: "Esperando o MacBook Air voltar",
 * "O Claude Code roda nele. Sigo daqui assim que ele voltar · 2 rotinas esperando" and, on a self-host,
 * "Trocar computador"; by itself it turns into "O MacBook Air voltou" (or "Troquei de computador") with no button.
 */
function WaitCard({ card }: { card: NonNullable<ReturnType<typeof useBrainWait>> }) {
  const { t } = useTranslation();
  const c = useColors();
  // Only where people connect their own computers: a Cloud workspace has one, and nothing while that isn't known.
  const switches = useEdition() === "selfhost";
  return (
    <View style={[styles.card, { backgroundColor: c.sunken }]}>
      <View style={styles.top} accessible accessibilityLabel={`${card.title}. ${card.body}`}>
        <LineIcon name={card.done ? "check" : "clock"} variant="callout" size={16} color={card.done ? c.ok : c.amber} />
        <Text variant="callout" tone="ink" style={styles.title} numberOfLines={2}>
          {card.title}
        </Text>
      </View>
      <View style={styles.body}>
        {/* Waiting, the line names the brain that runs there. */}
        {card.done ? null : (
          <LineIcon variant="small" size={14}>
            <ProviderLogo id={card.brain} size="xs" />
          </LineIcon>
        )}
        <Text variant="small" tone="muted" importantForAccessibility="no" style={styles.grow}>
          {card.body}
        </Text>
      </View>
      {card.done || !switches ? null : (
        <View style={styles.acts}>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.outage.switch")}
            onPress={() => openSwitchComputer(card.machineId)}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 16, marginTop: 4, maxWidth: 520 },
  // A title on two lines keeps the icon on its first.
  top: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, minWidth: 0, fontWeight: "600" },
  body: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  acts: { flexDirection: "row" },
  // Never wraps: on a full name line it moves whole to the next.
  pill: { flexShrink: 0, alignSelf: "center", paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999 },
  pillText: { fontWeight: "600" },
});
