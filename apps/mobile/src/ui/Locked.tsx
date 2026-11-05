import { type ReactNode, useEffect } from "react";
import { Keyboard, View } from "react-native";

/**
 * `<Locked when={sending}>` turns off every control inside while its action runs, or once its result is final: no touch
 * reaches them, the keyboard closes on the field in use, the words stay. It is a real box, so it takes the children's
 * place in the layout. A `loading` Button and a Cancel that really cancels stay outside: this dims what it holds.
 */
export function Locked({ when, children }: { when: boolean; children: ReactNode }) {
  useEffect(() => {
    if (when) Keyboard.dismiss();
  }, [when]);
  return (
    <View pointerEvents={when ? "none" : "auto"} aria-hidden={when} style={when ? { opacity: 0.6 } : undefined}>
      {children}
    </View>
  );
}
