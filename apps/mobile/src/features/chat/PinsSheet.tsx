import { type MessagePin, usePins } from "@agenteschat/client";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet } from "react-native";
import { Card, Row, Text } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { Tile } from "../shared/parts";
import { orderPins } from "./logic";

/** "Fixadas": a conversation's pinned messages, the latest pin first; tap goes to the message. */
export function PinsSheet({ channelId, onPick }: { channelId: string; onPick: (pin: MessagePin) => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const pins = usePins(orgId, channelId);
  const list = useMemo(() => orderPins(pins.data ?? []), [pins.data]);
  return (
    <>
      <SheetTitle leading={<Tile icon="pin" />} title={t("mobile.pins.title")} />
      {pins.isLoading ? (
        <ActivityIndicator color={c.muted} />
      ) : pins.isError ? (
        <Text tone="muted">{t("mobile.app.failed")}</Text>
      ) : list.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {t("mobile.pins.empty")}
        </Text>
      ) : (
        <Card>
          {list.map((p) => (
            <Row
              key={p.messageId}
              leading={<Face who={p.message.author} size={30} live={false} />}
              title={dir.nameOf(p.message.author) || t("mobile.chat.someone")}
              subtitle={previewOf(p.message.body) || t("mobile.chat.approvalPreview")}
              meta={
                <Text variant="caption" tone="faint">
                  {when.short(p.message.createdAt)}
                </Text>
              }
              onPress={() => onPick(p)}
            />
          ))}
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 8 },
});
