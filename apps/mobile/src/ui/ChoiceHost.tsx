import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { Easing, SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedList, GroupedRow } from "./Grouped";
import { haptics } from "./haptics";
import { Text } from "./Text";
import { useTheme } from "./theme";

/** One choice in the list: its words, red when it destroys, a check on the one in use. */
export interface Choice {
  label: string;
  destructive?: boolean;
  checked?: boolean;
  onPress: () => void;
}

interface Ask {
  title: string;
  options: Choice[];
  cancel: string;
}

/** The iOS sheet curve, so the list arrives as the system's sheets do. */
const EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1);

let show: ((ask: Ask) => void) | null = null;

/**
 * Shows a choice as a list over the screen, any number of options (Android's dialog holds three buttons at most, so a
 * longer choice there lost its last options). False when no host is mounted: the caller keeps its own fallback.
 */
export function showChoices(ask: Ask): boolean {
  if (!show) return false;
  show(ask);
  return true;
}

/**
 * The host of `showChoices`, mounted once at the app's root: a system modal (above native sheets and pushed screens),
 * the list rising from the bottom edge as a sheet, the scrim, Back and Cancel closing it. Picking closes first, then
 * acts, so what it opens next (an alert, a screen) never lands under the list.
 */
export function ChoiceHost() {
  const { colors, reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    show = (next) => {
      setAsk(next);
      setOpen(true);
    };
    return () => {
      show = null;
    };
  }, []);
  const close = () => setOpen(false);
  const pick = (choice: Choice) => {
    haptics.selection();
    setOpen(false);
    choice.onPress();
  };
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <View style={styles.fill}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={ask?.cancel}
        />
        {ask ? (
          <Animated.View
            entering={reducedMotion ? undefined : SlideInDown.duration(300).easing(EASE_SHEET)}
            style={[
              styles.panel,
              { backgroundColor: colors.grouped, paddingBottom: insets.bottom + 16, maxHeight: height * 0.8 },
            ]}
          >
            <View style={[styles.grabber, { backgroundColor: colors.grabber }]} />
            <Text variant="footnote" tone="muted" style={styles.title} numberOfLines={2}>
              {ask.title}
            </Text>
            <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
              <GroupedList>
                {ask.options.map((o) => (
                  <GroupedRow
                    key={o.label}
                    label={o.label}
                    danger={Boolean(o.destructive)}
                    {...(o.checked !== undefined ? { checked: o.checked } : {})}
                    onPress={() => pick(o)}
                  />
                ))}
              </GroupedList>
              <View style={styles.gap} />
              <GroupedList>
                <GroupedRow key="cancel" label={ask.cancel} onPress={close} />
              </GroupedList>
            </ScrollView>
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "flex-end" },
  panel: { borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 16, paddingTop: 8 },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 2.5, marginBottom: 12 },
  title: { textAlign: "center", paddingHorizontal: 16, paddingBottom: 12 },
  gap: { height: 8 },
});
