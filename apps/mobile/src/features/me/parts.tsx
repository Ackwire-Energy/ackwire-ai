import { type ReactNode, useSyncExternalStore } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../shared/hooks";
import { type HeaderWordAction, PushedHeader } from "../shared/parts";
import type { AccountDraft } from "./logic";

/**
 * One screen of Você's (Conta, Membros, Notificações…), pushed with the platform's push: the native bar (its back
 * button and edge swipe, the title, a word that saves on the right) over the grouped gray, which scrolls under it.
 */
export function Page({ title, action, children }: { title: string; action?: HeaderWordAction; children?: ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader title={title} solid={false} grouped {...(action ? { action } : {})} />
      <ScrollView
        style={styles.fill}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.body, { paddingBottom: 24 + insets.bottom }]}
      >
        {children}
      </ScrollView>
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
});
