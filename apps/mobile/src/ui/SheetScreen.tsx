import type { ReactNode } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface SheetScreenProps {
  children?: ReactNode;
}

/**
 * The content of a route presented as a native form sheet (`useFormSheetOptions`): the system draws the
 * sheet, its grabber, the drag to dismiss and the dimmed, scaled screen behind. This is only the
 * scrolling body (the first scroll view, so dragging at its top edge moves the sheet), keyboard-aware.
 */
export function SheetScreen({ children }: SheetScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.fill}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.in, { paddingBottom: 22 + insets.bottom }]}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  in: { paddingHorizontal: 18, paddingTop: 24, gap: 12 },
});
