import { useChannelCard, useChannels } from "@agenteschat/client";
import { resolveChannelRef } from "@agenteschat/client/lib/channel-refs";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet } from "react-native";
import { useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { useColors, useOrgId } from "../shared/hooks";

/**
 * `#name` in a message (the web's `ChannelRef`): a tap opens the channel it means. A channel the viewer can't see
 * stays the text as written; an archived one is struck through and says so.
 */
export function ChannelRefText({ name, text, refs }: { name: string; text: string; refs?: Record<string, string> }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const orgId = useOrgId();
  const channels = useChannels(orgId).data ?? [];
  const ref = resolveChannelRef(name, refs, channels);
  const lookup = useChannelCard(orgId, ref?.id ?? "", Boolean(ref && !ref.known));
  if (!ref || (!ref.known && !lookup.data)) return <RNText>{text}</RNText>;
  const shown = ref.known?.name ?? lookup.data?.name ?? name;
  if (!ref.known && lookup.data?.archived) {
    return (
      <RNText
        accessibilityRole="button"
        accessibilityLabel={t("mobile.channelRef.archivedA11y", { name: shown })}
        onPress={() => toast({ title: t("mobile.channelRef.archived", { name: shown }), icon: "archive" })}
        style={[styles.ref, styles.archived, { color: c.muted }]}
      >
        #{shown}
      </RNText>
    );
  }
  const id = ref.id;
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={t("mobile.channelRef.a11y", { name: shown })}
      onPress={() => router.push(chatHref(id))}
      style={[styles.ref, { color: c.ink }]}
    >
      #{shown}
    </RNText>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "700" },
  archived: { textDecorationLine: "line-through" },
});
