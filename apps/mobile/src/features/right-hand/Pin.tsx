import { rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { rightHandSeen } from "@/lib/storage";
import { Count, Text } from "@/ui";
import { router } from "@/ui/navigation";
import type { ConversationRow } from "../chats/logic";
import { chatHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useMeId, useOrgId } from "../shared/hooks";
import { useSurface } from "../shared/parts";

/**
 * The right hand on Conversas (ADR 0137): one place to ask anything, under the greeting on the sky, shaped as the
 * conversation's composer ("Mensagem para Atlas", its face before it), the app's card with its cut corner. It opens
 * its DM (starting one when there is none yet); its unread count at the end, the red dot until its DM first opens on
 * this phone. It is not one of Agentes' rows.
 */
export function RightHandAsk({ row, onStart }: { row: ConversationRow; onStart: (agentId: string) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const fresh = rightHandSeen.useFresh(rightHandSeenKey(useMeId() ?? "", useOrgId()));
  if (row.kind !== "dm") return null;
  const words = t("mobile.chat.messageTo", { name: row.with.name });
  const open = () => {
    if (!row.channelId) onStart(row.with.id);
    else router.push(chatHref(row.channelId));
  };
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={words}
      style={({ pressed }) => [styles.field, surface, pressed && styles.pressed]}
    >
      <AgentFace agentId={row.with.id} size={FACE} />
      <Text variant="body" tone="faint" numberOfLines={1} style={styles.grow}>
        {words}
      </Text>
      {row.unread > 0 ? (
        <Count value={row.unread} max={99} inverted />
      ) : fresh ? (
        <View style={[styles.dot, { backgroundColor: c.badge }]} />
      ) : null}
    </Pressable>
  );
}

/** The field's height and its face: the face sits as far from the left edge as from the top and bottom. */
const HEIGHT = 52;
const FACE = 34;

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: HEIGHT,
    paddingLeft: (HEIGHT - FACE) / 2,
    paddingRight: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
  },
  grow: { flex: 1, minWidth: 0 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pressed: { opacity: 0.85 },
});
