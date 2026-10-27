import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { Button, Icon, InfoHint, Text, useReducedMotion } from "@/ui";
import { openConnectAi } from "../ai/NoAiCard";
import { useColors, useDirectory } from "../shared/hooks";
import type { NoAiBannerView } from "./no-ai-banner";

/**
 * Above the box, as on the web (ADR 0061): an agent's DM whose agent has no AI says so, and a conversation
 * with agents in a workspace with no AI at all says the agents don't have one yet, each with Conectar
 * (./no-ai-banner.ts decides which, and when the agent's no-AI card right above says it already).
 */
export function NoAiBanner({ banner }: { banner: NoAiBannerView }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const name = banner.kind === "agent" ? (dir.agentById.get(banner.agentId)?.name ?? t("channel.unknownAgent")) : "";
  const action = banner.kind === "agent" ? t("noAi.action") : t("noAi.banner.orgAction");
  const connect = () => openConnectAi(banner.agentId ? { agentId: banner.agentId } : {});
  return (
    <Animated.View
      entering={reduced ? undefined : FadeInDown.duration(220)}
      exiting={reduced ? undefined : FadeOut.duration(160)}
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: c.sunken }]}
    >
      <Icon name="bolt" size={15} color={c.ink2} />
      <View style={styles.text}>
        {banner.kind === "agent" ? (
          <Text variant="small" tone="ink2" style={styles.strong}>
            {t("noAi.agent", { name })}
          </Text>
        ) : (
          <InfoHint name={t("common.about", { label: action })} text={t("noAi.banner.orgHint")} variant="small">
            <Text variant="small" tone="ink2" style={styles.strong}>
              {t("noAi.banner.org")}
            </Text>
          </InfoHint>
        )}
      </View>
      <Button variant="secondary" size="sm" label={action} onPress={connect} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // The connection line's shape ("tato com canto"), in the quiet fill.
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 4,
    marginBottom: 6,
    paddingVertical: 6,
    paddingLeft: 10,
    paddingRight: 6,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderBottomLeftRadius: 3,
  },
  text: { flex: 1, minWidth: 0 },
  strong: { fontWeight: "600" },
});
