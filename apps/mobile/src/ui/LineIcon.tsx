import { useWindowDimensions, View } from "react-native";
import { Icon, type IconProps } from "./Icon";
import { lineHeightOf, type TextVariant } from "./Text";

export interface LineIconProps extends IconProps {
  /** The text beside it (default body). */
  variant?: TextVariant;
}

/**
 * An icon before text that may wrap, in a row aligned to the top: a box as tall as the text's first line
 * (it grows with the text size setting) with the icon in its middle, so both sit on the same line.
 */
export function LineIcon({ variant = "body", size = 20, ...icon }: LineIconProps) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ height: Math.max(lineHeightOf(variant, fontScale), size), justifyContent: "center" }}>
      <Icon {...icon} size={size} />
    </View>
  );
}
