import { cachePinned, type MessagePin, usePinMessage, usePins } from "@agenteschat/client";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { can } from "@agenteschat/client/lib/permissions";
import { pinsIn } from "@agenteschat/client/lib/pins";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Card, Count, Icon, IconButton, Row, Text, useToast, weights } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { Tile } from "../shared/parts";
import { orderPins } from "./logic";

/** A conversation's pins (in a thread, the thread's), the latest pin first. */
function usePinsHere(channelId: string, threadId: string | null) {
  const pins = usePins(useOrgId(), channelId);
  const list = useMemo(() => pinsIn(orderPins(pins.data ?? []), threadId), [pins.data, threadId]);
  return { pins, list };
}

/**
 * The pinned bar under the conversation's header, only while something is pinned here: the latest pin (who wrote it,
 * its first line) and how many; a tap opens "Fixadas".
 */
export function PinnedBar({
  channelId,
  threadId,
  onOpen,
}: {
  channelId: string;
  threadId: string | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const { list } = usePinsHere(channelId, threadId);
  const latest = list[0];
  if (!latest) return null;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.pins.bar", { count: list.length })}
      // A 36-point bar: the slop reaches 44 into the conversation under it, never into the header above.
      hitSlop={{ bottom: 8 }}
      style={({ pressed }) => [styles.bar, { borderBottomColor: c.line2, backgroundColor: pressed ? c.sunken : c.bg }]}
    >
      <Icon name="pin" size={13} color={c.faint} />
      <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.grow}>
        <Text variant="footnote" tone="ink" style={styles.bold}>
          {dir.nameOf(latest.message.author) || t("mobile.chat.someone")}
        </Text>{" "}
        {previewOf(textOrMedia(t, latest.message.body, latest.message.meta))}
      </Text>
      {list.length > 1 ? <Count value={list.length} size={13} /> : null}
    </Pressable>
  );
}

/** "Fixadas": a conversation's pinned messages, the latest pin first; tap goes to the message, × unpins it. */
export function PinsSheet({
  channelId,
  threadId,
  onPick,
}: {
  channelId: string;
  threadId: string | null;
  onPick: (pin: MessagePin) => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  // As on the web: unpinning needs "post" (the server answers 403 otherwise).
  const mayUnpin = can(org, "post");
  const toast = useToast();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const qc = useQueryClient();
  const pin = usePinMessage(orgId);
  const { pins, list } = usePinsHere(channelId, threadId);
  const unpin = (p: MessagePin) => {
    cachePinned(qc, orgId, channelId, p.messageId, false);
    pin.mutate(
      { channelId, messageId: p.messageId, pinned: false },
      {
        onError: () => {
          cachePinned(qc, orgId, channelId, p.messageId, true);
          toast({ title: t("mobile.app.failed"), icon: "x" });
        },
      },
    );
  };
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
          {list.map((p) => {
            const name = dir.nameOf(p.message.author) || t("mobile.chat.someone");
            return (
              <Row
                key={p.messageId}
                leading={<Face who={p.message.author} size={30} live={false} />}
                title={name}
                // A pinned GIF or sticker says which (ADR 0091).
                subtitle={previewOf(textOrMedia(t, p.message.body, p.message.meta)) || t("mobile.chat.approvalPreview")}
                meta={
                  <View style={styles.meta}>
                    <Text variant="caption" tone="faint">
                      {when.short(p.message.createdAt)}
                    </Text>
                    {mayUnpin ? (
                      <IconButton icon="x" label={t("mobile.pins.unpinOf", { name })} onPress={() => unpin(p)} />
                    ) : null}
                  </View>
                }
                onPress={() => onPick(p)}
              />
            );
          })}
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  grow: { flex: 1 },
  bold: { fontWeight: weights.semibold },
  meta: { flexDirection: "row", alignItems: "center", gap: 2 },
});
