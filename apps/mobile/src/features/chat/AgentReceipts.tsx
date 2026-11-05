import {
  type DecidedBy,
  type Message,
  type MessageReceipt,
  receiptView,
  useReactions,
  useSteerState,
} from "@agenteschat/client";
import { listNames } from "@agenteschat/client/lib/activity";
import { failedRunFix, runFailureLine } from "@agenteschat/client/lib/errors";
import { mayConnectAi } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { deciderOf } from "@agenteschat/client/lib/routing";
import { helpUrl } from "@agenteschat/client/lib/server";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  Card,
  Icon,
  type IconName,
  InkOrbit,
  Row,
  SectionHeader,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { Note, OpenPage } from "../ai/parts";
import { QueueWaitRows } from "../queue/parts";
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
import { requestComposerText } from "./composer-request";

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
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
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
  // One agent failed: why, in place of only saying that it did (the web's line on its failed run).
  const failedAgent =
    line.words?.key === "receipts.failed" && line.words.agents.length === 1 ? line.words.agents[0] : null;
  const failure = failedAgent ? receipt?.failures?.[failedAgent] : undefined;
  const why = failedAgent && failure ? runFailureLine(t, name(failedAgent), failure, i18n.language) : null;
  const fix =
    failedAgent && failure
      ? failedRunFix(failure.code, {
          keys: can(org, "manage_credentials"),
          admin: can(org, "manage_agents"),
          owner: meId !== null && dir.agentById.get(failedAgent)?.ownerUserId === meId,
        })
      : null;
  const only = line.faces.length === 1 && line.more === 0 ? line.faces[0] : undefined;
  // Retry sends my words again: only under my own message. Connect: for who can connect one.
  const action =
    line.action === "retry"
      ? mine
        ? "retry"
        : null
      : line.action === "connect" && !mayConnectAi(only ? dir.agentById.get(only) : null, meId, org)
        ? null
        : line.action;
  const connect = () => {
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
        message={m}
        receipt={receipt}
        action={action}
        onAction={() => {
          sheet.close();
          act?.();
        }}
      />,
    );
  const plain = (
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
        // A 20-point line: 12 above and below gives it the 44-point target.
        hitSlop={{ top: 12, bottom: 12, left: 6, right: 6 }}
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
          <Text
            variant="caption"
            tone={line.alert ? "danger" : "muted"}
            numberOfLines={why ? undefined : 2}
            style={styles.words}
          >
            {why ?? say(line.words)}
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
      {fix && failedAgent ? (
        <Button
          variant="secondary"
          size="sm"
          label={t(fix === "useKey" ? "noAi.rightHand.useKey" : "usageCard.changeModel")}
          onPress={() =>
            fix === "useKey" ? openConnectAi({ agentId: failedAgent, intent: "api_key" }) : openAgentAi(failedAgent)
          }
        />
      ) : null}
    </Animated.View>
  );
  // In line for the computer: the agent's waiting row says where, once the line knows its turn.
  return line.words?.key === "receipts.queued" ? (
    <QueueWaitRows channelId={m.channelId} receipt={receipt} agents={line.words.agents} fallback={plain} />
  ) : (
    plain
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
      ? sheet.open(<ReceiptsSheet message={m} receipt={receipt} action={null} onAction={() => sheet.close()} />)
      : toast({ title: label, ...(view.kind === "steer" ? { agentId: view.agentId } : {}) });
  return (
    <Animated.View
      // Each new mark swaps in.
      key={view.kind === "steer" ? view.state : view.kind === "agents" ? view.mark : view.kind}
      entering={reduced ? undefined : FadeIn.duration(200)}
      accessibilityLiveRegion="polite"
    >
      <Pressable onPress={say} accessibilityRole="button" accessibilityLabel={label} hitSlop={14} style={styles.mark}>
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
  if (mark === "none") return null;
  return <Icon name={mark} size={14} color={color} />;
}

/** The web's icon for what a rule follows: the reply, the one person with the agent, the thread. */
const RULE_ICON: Record<Exclude<Extract<DecidedBy, { step: "rule" }>["rule"], "coordinator" | "alone">, IconName> = {
  reply: "replyTo",
  only_agent: "person",
  follow_up: "reply",
  default: "check",
};

/**
 * "Agentes": each agent the message reached and where it is with it (an agent's reaction is its answer), the rule
 * that picked them, and the line's action. When no agent will answer, or every one it was for passed, it says so and offers "Chamar um agente": a tap puts its
 * @handle in the box. When nothing could pick, why, and how agents are picked.
 */
function ReceiptsSheet({
  message: m,
  receipt,
  action,
  onAction,
}: {
  message: Message;
  receipt: MessageReceipt | undefined;
  action: "retry" | "connect" | null;
  onAction: () => void;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const sheet = useSheet();
  const reactions = useReactions(orgId, m.id, false).data ?? m.reactions;
  const rows = receiptRows(
    receipt,
    (reactions ?? []).flatMap((r) => r.agentIds ?? []),
  );
  const view = receiptView(receipt);
  // Nobody will answer, or every agent it was for ended without answering: a person can call one.
  const nobody = view.status?.kind === "nobody" || view.status?.kind === "passed";
  const callable = nobody
    ? rows.flatMap(({ agentId }) => {
        const handle = dir.agentById.get(agentId)?.handle;
        return handle ? [{ agentId, handle }] : [];
      })
    : [];
  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const by = deciderOf(t, view, { agent: name });
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
      {by ? <Note icon={RULE_ICON[by.rule]}>{by.text}</Note> : null}
      {nobody ? (
        <Note icon="checks">
          {view.status?.kind === "passed"
            ? t("receipts.passed", { count: rows.length })
            : t(mentionNeeded ? "receipts.mentionNeeded" : "receipts.nobody")}
        </Note>
      ) : null}
      {callable.length > 0 ? (
        <>
          <SectionHeader title={t("channel.callAgent")} />
          <Card>
            {callable.map((c) => (
              <Row
                key={c.agentId}
                leading={<AgentFace agentId={c.agentId} size={30} live={false} />}
                title={name(c.agentId)}
                subtitle={`@${c.handle}`}
                onPress={() => {
                  requestComposerText(m.channelId, `@${c.handle} `);
                  sheet.close();
                }}
              />
            ))}
          </Card>
        </>
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
