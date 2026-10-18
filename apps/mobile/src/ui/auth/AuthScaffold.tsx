import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, ScrollView, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { Sky } from "@/sky/Sky";
import { IconButton } from "../IconButton";
import { Text } from "../Text";
import { useTheme } from "../theme";
import { CHROME_MAX_SCALE } from "../type-scale";

export interface AuthScaffoldProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}

/** One calm question per screen: the pixel sky with an agent on top, a large title, the answer below. */
export function AuthScaffold({ title, subtitle, onBack, children, footer }: AuthScaffoldProps) {
  const { colors, fonts } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const skyHeight = Math.round(Math.min(300, height * 0.32));
  return (
    // The keyboard library's view: with its provider on, Android no longer resizes the window by itself.
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 16 }}
      >
        <View
          style={{ height: skyHeight + insets.top }}
          accessibilityLabel={t("mobile.auth.skyLabel")}
          accessibilityRole="image"
        >
          <Sky
            color="sky"
            depth={0.9}
            fade={0.55}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          />
          <View style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", paddingBottom: 18 }}>
            <AgentAvatar agent={{ color: "sky", eyes: "round", id: "agentes" }} size={72} mode="idle" />
          </View>
          {onBack ? (
            <View style={{ position: "absolute", top: insets.top + 6, left: 10 }}>
              <IconButton icon="back" label={t("mobile.common.back")} onPress={onBack} plate />
            </View>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 24, paddingTop: 8, flex: 1 }}>
          <RNText
            accessibilityRole="header"
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={{ fontFamily: fonts.display, fontSize: 32, lineHeight: 35, letterSpacing: -0.64, color: colors.ink }}
          >
            {title}
          </RNText>
          {subtitle ? (
            <Text variant="callout" tone="muted" style={{ marginTop: 6 }}>
              {subtitle}
            </Text>
          ) : null}
          <View style={{ marginTop: 22, gap: 10 }}>{children}</View>
          <View style={{ flex: 1 }} />
          {footer ? <View style={{ marginTop: 24, alignItems: "center" }}>{footer}</View> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
