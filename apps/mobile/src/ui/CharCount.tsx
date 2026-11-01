import { Text } from "./Text";
import { useTheme } from "./theme";

/**
 * "6/16" beside a short field's label (the web's `CharCount`), `label` in words for VoiceOver. Past it (a value saved
 * before the limit) it turns to the danger color; the field's `maxLength` keeps new typing in.
 */
export function CharCount({ count, max, label }: { count: number; max: number; label: string }) {
  const { colors } = useTheme();
  return (
    <Text
      variant="footnote"
      accessibilityLabel={label}
      style={{ color: count > max ? colors.danger : colors.faint, fontVariant: ["tabular-nums"] }}
    >
      {count}/{max}
    </Text>
  );
}
