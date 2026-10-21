import type { Expression } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { Sky } from "@/sky/Sky";
import { IconButton } from "../IconButton";
import { Text } from "../Text";
import { useTheme } from "../theme";

export interface AuthScaffoldProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  /** A new key fades the question in (the steps of one screen). */
  stepKey?: string;
  /** The agent works while a request is out ("run": writing dashes) and reacts with a face. */
  agentMode?: "idle" | "run";
  expression?: Expression;
}

/** One calm question per screen: the pixel sky with an agent on top, a large title, the answer below. */
export function AuthScaffold({
  title,
  subtitle,
  onBack,
  children,
  footer,
  stepKey,
  agentMode = "idle",
  expression,
}: AuthScaffoldProps) {
  const { colors } = useTheme();
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
            <AgentAvatar
              agent={{ color: "sky", eyes: "round", id: "agentes" }}
              size={72}
              mode={agentMode}
              expression={expression}
            />
          </View>
          {onBack ? (
            <View style={{ position: "absolute", top: insets.top + 6, left: 10 }}>
              <IconButton icon="back" label={t("mobile.common.back")} onPress={onBack} plate />
            </View>
          ) : null}
        </View>
        <Animated.View
          key={stepKey}
          entering={FadeIn.duration(220)}
          style={{ paddingHorizontal: 24, paddingTop: 8, flex: 1 }}
        >
          <Text variant="display" accessibilityRole="header" accessibilityLiveRegion="polite">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="callout" tone="muted" style={{ marginTop: 6 }}>
              {subtitle}
            </Text>
          ) : null}
          <View style={{ marginTop: 22, gap: 10 }}>{children}</View>
          <View style={{ flex: 1 }} />
          {footer ? <View style={{ marginTop: 24, alignItems: "center" }}>{footer}</View> : null}
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
