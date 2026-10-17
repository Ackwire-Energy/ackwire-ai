import { Pressable, Text as RNText, View } from "react-native";
import { useTheme } from "../theme";

/** "No account yet? Create account": a quiet line with one link. */
export function AuthLink({ lead, label, onPress }: { lead?: string; label: string; onPress: () => void }) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
      {lead ? <RNText style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.muted }}>{lead}</RNText> : null}
      <Pressable onPress={onPress} accessibilityRole="link" hitSlop={8}>
        <RNText style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.ink }}>{label}</RNText>
      </Pressable>
    </View>
  );
}

/** A thin "or" between the main answer and the social buttons. */
export function OrDivider({ label }: { label: string }) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <RNText style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.faint }}>{label}</RNText>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
