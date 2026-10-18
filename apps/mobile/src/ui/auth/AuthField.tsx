import { type ComponentRef, forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { systemText } from "../Text";
import { useTheme } from "../theme";

/** The one input of an auth screen: raised, large, 16-point text (no zoom on iOS). */
export const AuthField = forwardRef<ComponentRef<typeof TextInput>, Omit<TextInputProps, "style">>(
  function AuthField(props, ref) {
    const { colors, shadows } = useTheme();
    return (
      <TextInput
        ref={ref}
        placeholderTextColor={colors.faint}
        {...props}
        style={{
          minHeight: 52,
          borderRadius: 15,
          paddingHorizontal: 16,
          backgroundColor: colors.raised,
          boxShadow: `${shadows.e1}, ${shadows.top}`,
          paddingVertical: 12,
          fontSize: systemText("body").fontSize,
          color: colors.ink,
        }}
      />
    );
  },
);
