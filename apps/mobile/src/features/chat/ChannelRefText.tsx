import { useChannelCard, useChannels, useJoinChannel } from "@agenteschat/client";
import { channelCardFacts, resolveChannelRef } from "@agenteschat/client/lib/channel-refs";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text as RNText, StyleSheet, View } from "react-native";
import { Button, Icon, Text, useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { useColors, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheetIfAny } from "../shared/SheetHost";

/**
 * `#name` in a message (the web's `ChannelRef`): a tap opens the channel it means, a long press shows its card
 * (topic, counts, Join or Open). A channel the viewer can't see stays the text as written; an archived one is
 * struck through and says so.
 */
export function ChannelRefText({ name, text, refs }: { name: string; text: string; refs?: Record<string, string> }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const orgId = useOrgId();
  const sheet = useSheetIfAny();
  const channels = useChannels(orgId).data ?? [];
  const ref = resolveChannelRef(name, refs, channels);
  const lookup = useChannelCard(orgId, ref?.id ?? "", Boolean(ref && !ref.known));
  if (!ref || (!ref.known && !lookup.data)) return <RNText>{text}</RNText>;
  const shown = ref.known?.name ?? lookup.data?.name ?? name;
  const id = ref.id;
  const card = sheet
    ? {
        onLongPress: () => sheet.open(<ChannelCardSheet channelId={id} onDone={sheet.close} />),
        accessibilityActions: [{ name: "longpress", label: t("channelRefs.card", { name: shown }) }],
        onAccessibilityAction: () => sheet.open(<ChannelCardSheet channelId={id} onDone={sheet.close} />),
      }
    : {};
  if (!ref.known && lookup.data?.archived) {
    return (
      <RNText
        accessibilityRole="button"
        accessibilityLabel={t("mobile.channelRef.archivedA11y", { name: shown })}
        onPress={() => toast({ title: t("mobile.channelRef.archived", { name: shown }), icon: "archive" })}
        {...card}
        style={[styles.ref, styles.archived, { color: c.muted }]}
      >
        #{shown}
      </RNText>
    );
  }
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={t("mobile.channelRef.a11y", { name: shown })}
      onPress={() => router.push(chatHref(id))}
      {...card}
      style={[styles.ref, { color: c.ink }]}
    >
      #{shown}
    </RNText>
  );
}

/** A channel's card in a sheet: what it is, who is in it, and Join or Open (the web's hover card). */
function ChannelCardSheet({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const card = useChannelCard(orgId, channelId);
  const join = useJoinChannel(orgId, channelId);
  const c = card.data;
  if (!c) {
    return card.isError ? (
      <Text variant="body" tone="muted">
        {t("channelRefs.gone")}
      </Text>
    ) : (
      <ActivityIndicator accessibilityLabel={t("channelRefs.loading")} />
    );
  }
  const openIt = () => {
    onDone();
    router.push(chatHref(channelId));
  };
  return (
    <>
      <SheetTitle
        leading={<Icon name={c.archived ? "archive" : c.visibility === "private" ? "lock" : "hash"} size={20} />}
        title={`#${c.name}`}
        subtitle={c.archived ? `${t("channelRefs.archived")} · ${channelCardFacts(t, c)}` : channelCardFacts(t, c)}
      />
      {c.topic ? <Text variant="body">{c.topic}</Text> : null}
      {c.archived ? null : (
        <View style={styles.actions}>
          {!c.isMember && c.visibility === "public" ? (
            <Button
              variant="primary"
              wide
              label={t("channelRefs.join")}
              loading={join.isPending}
              onPress={() => join.mutate(undefined, { onSuccess: openIt })}
            />
          ) : null}
          <Button variant="secondary" wide label={t("channelRefs.open")} onPress={openIt} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "700" },
  archived: { textDecorationLine: "line-through" },
  actions: { gap: 8 },
});
