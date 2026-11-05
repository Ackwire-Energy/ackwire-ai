import { type ReactNode, useEffect } from "react";
import { Keyboard, type StyleProp, View, type ViewStyle } from "react-native";

/**
 * `<Locked when={sending}>` turns off every control inside while its action runs, or once its result is final: no touch
 * reaches them, the keyboard closes on the field in use, the words stay. It is a real box, so it takes the children's
 * place in the layout: `style` gives it what the parent gave them (a `gap`). A `loading` Button and a Cancel that really
 * cancels stay outside: this dims what it holds. Inside a ScrollView, never around it: the page must still scroll.
 */
export function Locked({
  when,
  style,
  children,
}: {
  when: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  useEffect(() => {
    if (when) Keyboard.dismiss();
  }, [when]);
  return (
    <View pointerEvents={when ? "none" : "auto"} aria-hidden={when} style={[style, when ? { opacity: 0.6 } : null]}>
      {children}
    </View>
  );
}
