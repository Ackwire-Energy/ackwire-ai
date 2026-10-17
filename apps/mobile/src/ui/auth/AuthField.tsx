import { forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { useTheme } from "../theme";

/** The one input of an auth screen: raised, large, 16-point text (no zoom on iOS). */
export const AuthField = forwardRef<TextInput, Omit<TextInputProps, "style">>(function AuthField(props, ref) {
  const { colors, fonts, shadows } = useTheme();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.faint}
      {...props}
      style={{
        height: 52,
        borderRadius: 15,
        paddingHorizontal: 16,
        backgroundColor: colors.raised,
        boxShadow: `${shadows.e1}, ${shadows.top}`,
        fontFamily: fonts.sans,
        fontSize: 16,
        color: colors.ink,
      }}
    />
  );
});
