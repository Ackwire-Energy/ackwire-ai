import { type ReactNode, useSyncExternalStore } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Locked } from "@/ui";
import { useColors } from "../shared/hooks";
import { type HeaderWordAction, PushedHeader } from "../shared/parts";
import type { AccountDraft } from "./logic";

/**
 * One screen of Você's (Conta, Membros, Notificações…), pushed with the platform's push: the native bar (its back
 * button and edge swipe, the title, a word that saves on the right) over the grouped gray, which scrolls under it.
 * `footer`: a button that stays at the bottom, over the keyboard, with the page scrolling above it.
 */
export function Page({
  title,
  action,
  footer,
  locked = false,
  children,
}: {
  title: string;
  action?: HeaderWordAction;
  footer?: ReactNode;
  /** The page's form is sending: its controls are off, the page still scrolls. */
  locked?: boolean;
  children?: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const scroll = (
    <ScrollView
      style={styles.fill}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets={!footer}
      contentContainerStyle={[styles.body, { paddingBottom: footer ? 24 : 24 + insets.bottom }]}
    >
      {/* What is there as the screen opens doesn't fade in; what loads while it is watched does (`Loaded`). */}
      <Locked when={locked}>
        <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
      </Locked>
    </ScrollView>
  );
  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader title={title} solid={false} grouped {...(action ? { action } : {})} />
      {footer ? (
        <KeyboardAvoidingView behavior="padding" style={styles.fill}>
          {scroll}
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>{footer}</View>
        </KeyboardAvoidingView>
      ) : (
        scroll
      )}
    </View>
  );
}

/**
 * Conta's form while it is open, shared with Fuso (a screen pushed over it): Conta starts it from the profile and
 * drops it when it closes; Fuso writes the zone picked and goes back.
 */
let accountDraft: AccountDraft | null = null;
const draftListeners = new Set<() => void>();

export function setAccountDraft(next: AccountDraft | null) {
  accountDraft = next;
  for (const listener of draftListeners) listener();
}

export function useAccountDraft(): AccountDraft | null {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => {
        draftListeners.delete(listener);
      };
    },
    () => accountDraft,
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 4 },
  footer: { paddingHorizontal: 16, paddingTop: 12 },
});
