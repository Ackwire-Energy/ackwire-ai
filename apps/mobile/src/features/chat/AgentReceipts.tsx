import {
  type DecidedBy,
  type Message,
  type MessageReceipt,
  receiptView,
  useModelLabel,
  useSteerState,
} from "@agenteschat/client";
import { listNames } from "@agenteschat/client/lib/activity";
import { deciderOf } from "@agenteschat/client/lib/routing";
import { helpUrl } from "@agenteschat/client/lib/server";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Button, Card, Icon, type IconName, InkOrbit, ProviderLogo, Row, Text, useReducedMotion, useToast } from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { Note, OpenPage } from "../ai/parts";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheet } from "../shared/SheetHost";
import {
  markLabel,
  markOf,
  phaseKey,
  type ReceiptLine,
  receiptLine,
  receiptRows,
  receiptShows,
} from "./agent-receipts";

/**
 * Under a person's latest message, for what asks something of you (./agent-receipts.ts says what): the agents'
 * receipt as one quiet line. A tap opens the sheet with each agent and its state, and the line's action: send it
 * again after a failure, or connect an AI. The rest of a receipt is a mark beside the message (`ReceiptMark`).
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

/**
 * A person's message's receipt in a line its row already has, never one of its own (`markOf`): after the time under
 * my turn, or at the end of a turn's name line. Faces and our small marks; the words are its label, and a tap says
 * them: the agents' sheet, or a note from the top.
 */
export const ReceiptMark = memo(function ReceiptMark({
  message: m,
  mine,
  receipt,
  seenBy,
}: {
  message: Message;
  /** My own message: it also wears what became of it in a task at work. */
  mine: boolean;
  /** The agents' receipt this mark shows, if any (the latest person's message's). */
  receipt?: MessageReceipt;
  /** A DM between people: who read this message, my latest. */
  seenBy?: string;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const sheet = useSheet();
  const toast = useToast();
  const steer = useSteerState(orgId, m.channelId, mine ? m.id : "");
  const view = markOf(steer, seenBy, receipt);
  if (!view) return null;
  const label = markLabel(t, view, {
    agent: (id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"),
    person: (id) => dir.nameOf({ type: "person", id }) || t("mobile.chat.someone"),
  });
  // The agents' sheet when there are agents to list (none yet while the author's plan picks), else the words.
  const say = () =>
    view.kind === "agents" && receiptRows(receipt).length > 0
      ? sheet.open(<ReceiptsSheet receipt={receipt} action={null} onAction={() => sheet.close()} />)
      : toast({ title: label, ...(view.kind === "steer" ? { agentId: view.agentId } : {}) });
  return (
    <Animated.View
      // Each new mark swaps in.
      key={view.kind === "steer" ? view.state : view.kind === "agents" ? view.mark : view.kind}
      entering={reduced ? undefined : FadeIn.duration(200)}
      accessibilityLiveRegion="polite"
    >
      <Pressable onPress={say} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={styles.mark}>
        {view.kind === "seen" ? (
          <Face who={{ type: "person", id: view.personId }} size={16} live={false} />
        ) : view.kind === "steer" ? (
          view.state === "read" || view.state === "resolved" ? (
            <AgentFace agentId={view.agentId} size={16} live={false} framed={false} />
          ) : view.state === "now" ? (
            <Icon name="bolt" size={14} color={c.muted} />
          ) : view.state === "delivered" ? (
            <Icon name="check" size={14} color={c.muted} />
          ) : view.state === "held" ? (
            <Icon name="pause" size={14} color={c.muted} />
          ) : (
            <InkOrbit size={10} color={c.muted} />
          )
        ) : (
          <>
            {view.agentId ? <AgentFace agentId={view.agentId} size={16} live={false} framed={false} /> : null}
            <Mark mark={view.mark} color={c.muted} />
          </>
        )}
      </Pressable>
    </Animated.View>
  );
});

function Mark({ mark, color }: { mark: ReceiptLine["mark"]; color: string }) {
  switch (mark) {
    case "seen":
      return <Icon name="check" size={14} color={color} />;
    case "done":
      return <Icon name="checks" size={14} color={color} />;
    case "working":
      return <InkOrbit size={10} color={color} />;
    case "waiting":
      return <Icon name="pause" size={14} color={color} />;
    case "asking":
      return <Icon name="help" size={14} color={color} />;
    case "picking":
      return <Icon name="clock" size={14} color={color} />;
    default:
      return null;
  }
}

/** The web's icon for what a rule follows: the reply, the one person with the agent, the thread, the coordinator. */
const RULE_ICON: Record<Extract<DecidedBy, { step: "rule" }>["rule"], IconName> = {
  reply: "replyTo",
  only_agent: "person",
  follow_up: "reply",
  coordinator: "flag",
  default: "check",
};

/**
 * "Agentes": each agent the message reached and where it is with it, who picked them, and the line's action.
 * When nothing could pick, why, and how agents are picked.
 */
function ReceiptsSheet({
  receipt,
  action,
  onAction,
}: {
  receipt: MessageReceipt | undefined;
  action: "retry" | "connect" | null;
  onAction: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const meId = useMeId();
  const modelLabel = useModelLabel();
  const rows = receiptRows(receipt);
  const view = receiptView(receipt);
  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const by = deciderOf(t, view, {
    meId,
    agent: name,
    person: (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    model: modelLabel,
  });
  const mentionNeeded = view.status?.kind === "nobody" && view.status.mentionNeeded === true;
  return (
    <>
      <SheetTitle title={t("receipts.popoverTitle")} />
      <Card>
        {rows.map((r) => (
          <Row
            key={r.agentId}
            leading={<AgentFace agentId={r.agentId} size={30} live={false} />}
            title={name(r.agentId)}
            subtitle={t(phaseKey(r.phase))}
          />
        ))}
      </Card>
      {by ? (
        <Note icon={"logo" in by.mark ? <ProviderLogo id={by.mark.logo} size="xs" /> : RULE_ICON[by.mark.rule]}>
          {by.text}
        </Note>
      ) : null}
      {mentionNeeded ? (
        <>
          <Note icon="info">{t("receipts.mentionNeededHint")}</Note>
          <OpenPage href={helpUrl("who-answers", i18n.language)} label={t("routing.how")} />
        </>
      ) : null}
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
  // A face (16) and a mark (14) at most: the time's line under my turn and a name line's end hold it.
  mark: { flexDirection: "row", alignItems: "center", gap: 4, height: 16 },
});
