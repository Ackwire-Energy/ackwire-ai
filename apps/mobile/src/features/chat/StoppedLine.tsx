import { type Message, useStopReason } from "@agenteschat/client";
import type { StoppedNotice } from "@agenteschat/client/lib/notices";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, LineIcon, Text, useToast } from "@/ui";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { ReasonField } from "../task-manager/parts";

/**
 * A person stopped one of the agent's tasks (ADR 0125): one calm line where the task was, "Você parou esta tarefa ·
 * 14:09 · Dev recebeu o aviso e só retoma se alguém pedir.", with the reason when there is one. Who stopped it, while
 * it has none, gets "Dizer por quê": a short field the agent reads.
 */
export function StoppedLine({ message, notice }: { message: Message; notice: StoppedNotice }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const meId = useMeId();
  const orgId = useOrgId();
  const toast = useToast();
  const say = useStopReason(orgId);
  const [writing, setWriting] = useState(false);
  const [why, setWhy] = useState("");
  // Sent from here: shown at once, before the notice itself comes back with it.
  const [sent, setSent] = useState<string | null>(null);
  const reason = notice.reason ?? sent;
  const mine = notice.byUserId === meId;
  const agent = dir.nameOf(message.author) || t("channel.unknownAgent");
  const by = notice.byName || dir.nameOf({ type: "person", id: notice.byUserId });
  const who = mine ? t("taskManager.stopped.line") : t("taskManager.stopped.lineBy", { name: by });
  const send = () => {
    const text = why.trim();
    if (!text) return;
    say.mutate(
      { runId: notice.runId, reason: text },
      {
        onSuccess: () => {
          setSent(text);
          setWriting(false);
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };
  return (
    <View style={styles.line}>
      <View style={styles.head}>
        <LineIcon name="stop" size={13} color={c.faint} variant="caption" />
        <Text variant="caption" tone="faint" style={styles.grow}>
          <Text variant="caption" tone="muted" style={styles.bold}>
            {who}
          </Text>
          {` · ${when.time(message.createdAt)}`}
          {reason ? ` · ${t("taskManager.stopped.reason", { reason })}` : null}
          {` · ${t("taskManager.stopped.told", { agent })}`}
          {mine && !reason && !writing ? (
            <>
              {" · "}
              <Text
                variant="caption"
                tone="muted"
                style={styles.bold}
                onPress={() => setWriting(true)}
                accessibilityRole="button"
                suppressHighlighting
              >
                {t("taskManager.stopped.sayWhy")}
              </Text>
            </>
          ) : null}
        </Text>
      </View>
      {writing && !reason ? (
        <View style={styles.form}>
          <View style={styles.grow}>
            <ReasonField
              value={why}
              onChange={setWhy}
              placeholder={t("taskManager.stopped.whyPlaceholder")}
              autoFocus
            />
          </View>
          <Button
            variant="secondary"
            size="sm"
            label={t("taskManager.stopped.send")}
            loading={say.isPending}
            disabled={!why.trim()}
            onPress={send}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Aligned with the messages' words, as the other automatic lines (`EventLine`).
  line: { marginVertical: 4, paddingLeft: 56, paddingRight: 16 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  form: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, marginLeft: 19 },
});
