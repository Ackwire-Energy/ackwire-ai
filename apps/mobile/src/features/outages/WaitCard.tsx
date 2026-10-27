import { type Message, useMachines } from "@agenteschat/client";
import { brainUnavailableOf, waitCardState } from "@agenteschat/client/lib/machine-outages";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Icon, LineIcon, ProviderLogo, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
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
  // Waiting for room on a computer that is there: the agent's own words, never a card about it coming back.
  if (!info?.machineId || info.code === "busy") return null;
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
 * The agent's one card while it waits: "Esperando o MacBook Air voltar",
 * "O Claude Code roda nele. Sigo daqui assim que ele voltar · 2 rotinas esperando" and "Trocar computador";
 * by itself it turns into "O MacBook Air voltou" (or "Troquei de computador") with no button.
 */
function WaitCard({ card }: { card: NonNullable<ReturnType<typeof useBrainWait>> }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.sunken }]}>
      <View style={styles.top} accessible accessibilityLabel={`${card.title}. ${card.body}`}>
        <Icon name={card.done ? "check" : "clock"} size={16} color={card.done ? c.ok : c.amber} />
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
      {card.done ? null : (
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
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, minWidth: 0, fontWeight: "600" },
  body: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  acts: { flexDirection: "row" },
});
