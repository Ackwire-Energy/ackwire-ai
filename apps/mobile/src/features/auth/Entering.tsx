import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Sky } from "@/sky/Sky";
import { AgentAvatar, Text, useTheme } from "@/ui";

/**
 * The passage into the app after signing in: the sky rises, the
 * agent smiles, and the screen becomes the conversations (or the first run when there is no workspace yet).
 */
export function Entering({ org }: { org: string | null }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(260)}
      style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}
      accessibilityLiveRegion="polite"
    >
      <Sky color="sky" depth={1} fade={0.9} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <AgentAvatar agent={{ color: "sky", eyes: "round", id: "agentes" }} size={88} expression="happy" />
        <Text variant="display" style={styles.text}>
          {org ? t("mobile.entering.title", { org }) : t("mobile.entering.titleNew")}
        </Text>
        <Text variant="callout" tone="muted" style={styles.text}>
          {t("mobile.entering.lead")}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  text: { textAlign: "center" },
});
