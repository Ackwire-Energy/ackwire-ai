import { useTranslation } from "react-i18next";
import { Pressable, TextInput, type TextInputProps, View } from "react-native";
import { Icon } from "./Icon";
import { useTheme } from "./theme";

export interface SearchFieldProps extends Omit<TextInputProps, "style"> {
  value: string;
  onChangeText: (text: string) => void;
}

/** The search box: sunken, a magnifier, a clear button when there is text. */
export function SearchField({ value, onChangeText, placeholder, ...rest }: SearchFieldProps) {
  const { colors, fonts } = useTheme();
  const { t } = useTranslation();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: 42,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: colors.sunken,
      }}
    >
      <Icon name="search" size={18} color={colors.faint} />
      <TextInput
        {...rest}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? t("mobile.search.placeholder")}
        placeholderTextColor={colors.faint}
        returnKeyType="search"
        autoCorrect={false}
        style={{ flex: 1, fontFamily: fonts.sans, fontSize: 15.5, color: colors.ink, paddingVertical: 0 }}
      />
      {value ? (
        <Pressable
          onPress={() => onChangeText("")}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.a11y.clearSearch")}
          hitSlop={8}
        >
          <Icon name="x" size={16} color={colors.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}
