import { useWindowDimensions, View } from "react-native";
import { Icon, type IconProps } from "./Icon";
import { type TextVariant, textLineOf } from "./Text";

export interface LineIconProps extends IconProps {
  /** The text beside it (default body). */
  variant?: TextVariant;
  /** The text's own size, when it sets one over its variant (e.g. `LIST_PREVIEW`). */
  text?: { fontSize?: number; lineHeight?: number };
}

/**
 * An icon before a line of text: a box as tall as the text's first line (it grows with the text size setting),
 * the icon centered where the eye reads the letters, a hair under the line's middle. In a row aligned to the
 * top it sits on the first line of wrapping text; in a centered row, on its only line.
 */
export function LineIcon({ variant = "body", text, size = 20, ...icon }: LineIconProps) {
  const { fontScale } = useWindowDimensions();
  const line = textLineOf(variant, fontScale, text);
  const top = Math.max(0, line.middle - size / 2);
  return (
    <View style={{ height: Math.max(line.height, top + size), paddingTop: top }}>
      <Icon {...icon} size={size} />
    </View>
  );
}
