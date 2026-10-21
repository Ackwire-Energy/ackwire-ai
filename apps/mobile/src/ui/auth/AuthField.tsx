import { type ComponentRef, forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { systemText } from "../Text";
import { useTheme } from "../theme";

/** The one input of an auth screen: raised, large, 16-point text (no zoom on iOS). `paddingRight` leaves room for a button inside. */
export const AuthField = forwardRef<
  ComponentRef<typeof TextInput>,
  Omit<TextInputProps, "style"> & { paddingRight?: number }
>(function AuthField({ paddingRight = 16, ...props }, ref) {
  const { colors, shadows } = useTheme();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.faint}
      {...props}
      style={{
        minHeight: 52,
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
