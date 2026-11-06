import { foldsText } from "@agenteschat/client/lib/text";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/ui";
import { MessageText } from "./MessageText";

/** A long text an agent wrote, on a page rather than in a conversation (the web's `FoldedBody`): folded until asked. */
export function FoldedBody({ body, muted = false }: { body: string; muted?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = foldsText(body);
  return (
    <View>
      <View style={long && !open ? styles.folded : undefined}>
        <MessageText body={body} muted={muted} small selectable={false} />
      </View>
      {long ? (
        // An 18-point line: 13 of slop around it gives the 44-point target.
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={13}
          onPress={() => setOpen(!open)}
          style={({ pressed }) => (pressed ? styles.pressed : null)}
        >
          <Text variant="footnote" tone="ink2" style={styles.more}>
            {t(open ? "folded.less" : "folded.more")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  folded: { maxHeight: 114, overflow: "hidden" },
  more: { marginTop: 2, textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
});
