import { type Message, type MessageReceipt, useSteerState } from "@agenteschat/client";
import { listNames } from "@agenteschat/client/lib/activity";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Button, Card, Icon, InkOrbit, Row, Text, useReducedMotion } from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheet } from "../shared/SheetHost";
import { phaseKey, type ReceiptLine, receiptLine, receiptRows, receiptShows } from "./agent-receipts";

/**
 * Under a person's latest message: the agents' receipt as one quiet line (./agent-receipts.ts says what it
 * shows). A tap opens the sheet with each agent and its state, and the line's action: send it again after a
 * failure, or connect an AI.
 */
export const AgentReceiptLine = memo(function AgentReceiptLine({
  message: m,
  receipt,
  mine,
  connectInline,
  onRetry,
}: {
  message: Message;
  receipt: MessageReceipt | undefined;
  mine: boolean;
  /** "Conectar" on the line itself (not while the banner above the box offers it already). */
  connectInline: boolean;
  onRetry: (m: Message) => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const sheet = useSheet();
  const steer = useSteerState(orgId, m.channelId, m.id);
  const line = receiptLine(receipt);
  if (!receiptShows(line, Boolean(steer))) return null;
  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const say = (w: ReceiptLine["label"]) =>
    t(w.key, { count: w.agents.length, names: listNames(t, w.agents.map(name)) });
  const label = say(line.label);
  // Retry sends my words again: only under my own message.
  const action = line.action === "retry" ? (mine ? "retry" : null) : line.action;
  const connect = () => {
    const only = line.faces.length === 1 && line.more === 0 ? line.faces[0] : undefined;
    openConnectAi({
      from: m.id,
      ...(receipt?.noAi?.intent ? { intent: receipt.noAi.intent } : {}),
      ...(receipt?.noAi?.provider ? { provider: receipt.noAi.provider } : {}),
      ...(only ? { agentId: only } : {}),
    });
  };
  const act = action === "retry" ? () => onRetry(m) : action === "connect" ? connect : null;
  const hasAgents = receiptRows(receipt).length > 0;
  const openSheet = () =>
    sheet.open(
      <ReceiptsSheet
        receipt={receipt}
        action={action}
        onAction={() => {
          sheet.close();
          act?.();
        }}
      />,
    );
  return (
    <Animated.View
      key={line.mark}
      entering={reduced ? undefined : FadeIn.duration(200)}
      style={[styles.line, mine ? styles.end : styles.start]}
      accessibilityLiveRegion="polite"
    >
      <Pressable
        onPress={hasAgents ? openSheet : undefined}
        disabled={!hasAgents}
        accessibilityRole={hasAgents ? "button" : "text"}
        accessibilityLabel={label}
        hitSlop={6}
        style={styles.row}
      >
        {line.faces.length > 0 ? (
          <View style={styles.faces}>
            {line.faces.map((id) => (
              <AgentFace key={id} agentId={id} size={16} live={false} framed={false} />
            ))}
            {line.more > 0 ? (
              <Text variant="caption" tone="faint">
                +{line.more}
              </Text>
            ) : null}
          </View>
        ) : null}
        <Mark mark={line.mark} color={c.muted} />
        {line.words ? (
          <Text variant="caption" tone={line.alert ? "danger" : "muted"} numberOfLines={2} style={styles.words}>
            {say(line.words)}
          </Text>
        ) : null}
      </Pressable>
      {act && (action !== "connect" || connectInline) ? (
        <Button
          variant="ghost"
          size="sm"
          label={action === "retry" ? t("receipts.retry") : t("noAi.action")}
          onPress={act}
        />
      ) : null}
    </Animated.View>
  );
});

function Mark({ mark, color }: { mark: ReceiptLine["mark"]; color: string }) {
  switch (mark) {
    case "seen":
    case "done":
      return <Icon name="check" size={12} color={color} />;
    case "working":
      return <InkOrbit size={10} color={color} />;
    case "waiting":
      return <Icon name="pause" size={12} color={color} />;
    case "asking":
      return <Icon name="help" size={12} color={color} />;
    default:
      return null;
  }
}

/** "Agentes": each agent the message reached and where it is with it, and the line's action. */
function ReceiptsSheet({
  receipt,
  action,
  onAction,
}: {
  receipt: MessageReceipt | undefined;
  action: "retry" | "connect" | null;
  onAction: () => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const rows = receiptRows(receipt);
  return (
    <>
      <SheetTitle title={t("receipts.popoverTitle")} />
      <Card>
        {rows.map((r) => (
          <Row
            key={r.agentId}
            leading={<AgentFace agentId={r.agentId} size={30} live={false} />}
            title={dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent")}
            subtitle={t(phaseKey(r.phase))}
          />
        ))}
      </Card>
      {action ? (
        <Button
          variant={action === "connect" ? "primary" : "secondary"}
          wide
          label={action === "retry" ? t("receipts.retry") : t("noAi.action")}
          onPress={onAction}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  // Right under the message, on its side: mine at the right edge (as "Visto"), anyone else's under the text
  // (MessageRow: 14 + 34 avatar + 11 gap).
  line: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -4, marginBottom: 4, minHeight: 20 },
  end: { alignSelf: "flex-end", paddingRight: 16, paddingLeft: 64 },
  start: { alignSelf: "flex-start", paddingLeft: 59, paddingRight: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  faces: { flexDirection: "row", alignItems: "center", gap: 2 },
  words: { flexShrink: 1 },
});
