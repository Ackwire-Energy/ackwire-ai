import { type ComponentRef, forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { systemText } from "../Text";
import { useTheme } from "../theme";

/**
 * The one input of an auth screen: raised, large, 16-point text (no zoom on iOS). `paddingRight` leaves room for a
 * button inside; `minHeight` for a few lines of a `multiline` one.
 */
export const AuthField = forwardRef<
  ComponentRef<typeof TextInput>,
  Omit<TextInputProps, "style"> & { paddingRight?: number; minHeight?: number }
>(function AuthField({ paddingRight = 16, minHeight = 52, ...props }, ref) {
  const { colors, shadows } = useTheme();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.faint}
      {...props}
      style={{
        minHeight,
        borderRadius: 15,
        paddingLeft: 16,
        paddingRight,
        backgroundColor: colors.raised,
        boxShadow: `${shadows.e1}, ${shadows.top}`,
        paddingVertical: 12,
        fontSize: systemText("body").fontSize,
        color: colors.ink,
      }}
    />
  );
});
