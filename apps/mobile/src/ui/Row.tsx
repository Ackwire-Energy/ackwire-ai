import type { ReactNode } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import { Icon } from "./Icon";
import { Text, textLineOf } from "./Text";
import { useTheme } from "./theme";
import { leadBox } from "./type-scale";

export interface RowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Lines the subtitle may take (default 1). */
  subtitleLines?: number;
  /** Right side: a time, a badge (`<Count inverted />`)… */
  meta?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  /** A hairline above (Card adds it between rows). */
  divider?: boolean;
  /** Under the text, in its column (a plan's meter, a note). */
  below?: ReactNode;
}

/** A list row: leading avatar or tile, title in ink, a muted line, meta on the right. */
export function Row({
  leading,
  title,
  subtitle,
  subtitleLines = 1,
  meta,
  chevron = false,
  onPress,
  divider = false,
  below,
}: RowProps) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  // A subtitle that wraps or something under it: the leading sits at the top and the meta and chevron on the
  // title's line (centred on the whole row they floated between lines). Short rows keep everything centred.
  const tall = subtitleLines > 1 || Boolean(below);
  const line = tall ? textLineOf("title", fontScale) : null;
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: tall ? "flex-start" : "center",
        gap: 12,
        padding: 14,
        minHeight: 60,
        backgroundColor: pressed ? "rgba(127, 127, 127, 0.08)" : "transparent",
      }}
    >
      {divider ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: leading ? 58 : 14,
            right: 0,
            height: 1,
            backgroundColor: colors.line,
          }}
        />
      ) : null}
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="title" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" numberOfLines={subtitleLines}>
            {subtitle}
          </Text>
        ) : null}
        {below}
      </View>
      {meta ? (
        <View style={{ alignItems: "flex-end", gap: 5, minHeight: line?.height, justifyContent: "center" }}>
          {meta}
        </View>
      ) : null}
      {chevron ? (
        <View style={line ? leadBox(line, 16) : null}>
          <Icon name="right" size={16} color={colors.faint} />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}
