import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { useAnimatedStyle, withSpring, withTiming } from "react-native-reanimated";
import { primaryLook } from "./Button";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { useTheme } from "./theme";

export interface ComposerProps {
  placeholder: string;
  onSend: (text: string) => void;
  onPlus: () => void;
  /** Pills above the field; tapping one puts its text in the field. */
  suggestions?: { icon: IconName; label: string }[];
}

/**
 * The center of the app: a raised field near the thumb, a "+" for attachments and actions, and a send
 * button that grows and lights up when there is text. The screen places it (above the keyboard).
 */
export function Composer({ placeholder, onSend, onPlus, suggestions }: ComposerProps) {
  const theme = useTheme();
  const { colors, fonts, shadows, motion, reducedMotion } = theme;
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const has = text.trim().length > 0;
  const look = primaryLook(theme);

  const sendStyle = useAnimatedStyle(() => ({
    width: reducedMotion ? (has ? 46 : 38) : withSpring(has ? 46 : 38, motion.pop),
  }));
  const litStyle = useAnimatedStyle(() => ({
    opacity: withTiming(has ? 1 : 0, { duration: reducedMotion ? 0 : 180 }),
  }));

  const send = () => {
    const value = text.trim();
    if (!value) return;
    haptics.light();
    onSend(value);
    setText("");
  };

  return (
    <View>
      {suggestions && suggestions.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 6, paddingHorizontal: 4, paddingBottom: 8 }}
        >
          {suggestions.map((s) => (
            <PressScale
              key={s.label}
              onPress={() => setText(s.label)}
              accessibilityRole="button"
              style={{
                height: 32,
                borderRadius: 999,
                backgroundColor: colors.raised,
                boxShadow: `${shadows.e1}, ${shadows.top}`,
              }}
            >
              <View style={{ flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12 }}>
                <Icon name={s.icon} size={15} color={colors.muted} />
                <RNText style={{ fontFamily: fonts.semibold, fontSize: 13.5, color: colors.ink2 }}>{s.label}</RNText>
              </View>
            </PressScale>
          ))}
        </ScrollView>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 6,
          padding: 6,
          borderRadius: 24,
          backgroundColor: colors.raised,
          boxShadow: `${focused ? shadows.e3 : shadows.e2}, ${shadows.top}`,
        }}
      >
        <PressScale
          to={0.9}
          onPress={onPlus}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.a11y.attach")}
          style={{ width: 38, height: 38, borderRadius: 14, backgroundColor: colors.sunken }}
        >
          <View style={styles.center}>
            <Icon name="plus" size={20} color={colors.ink2} />
          </View>
        </PressScale>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          multiline
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 110,
            fontFamily: fonts.sans,
            fontSize: 16,
            lineHeight: 22,
            paddingVertical: 8,
            paddingHorizontal: 4,
            color: colors.ink,
          }}
        />
        <Animated.View
          style={[{ height: 38, borderRadius: 14, overflow: "hidden", backgroundColor: colors.sunken }, sendStyle]}
        >
          <Animated.View style={[StyleSheet.absoluteFill, litStyle]} pointerEvents="none">
            <LinearGradient colors={look.gradient} style={StyleSheet.absoluteFill} />
          </Animated.View>
          <Pressable
            onPress={send}
            disabled={!has}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.a11y.send")}
            accessibilityState={{ disabled: !has }}
            style={styles.center}
          >
            <Icon name="send" size={20} color={has ? look.text : colors.faint} />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
});
