import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { AgentAvatar } from "@/agent/AgentAvatar";
import type { AgentLookInput } from "@/agent/looks";
import { Sky } from "@/sky/Sky";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  /** A window of pixel sky with a few agents on it (only where the subject is agents). */
  sky?: boolean;
  /** Who stands on the sky, the first in the middle (the workspace's agents; three of the app's colors without). */
  crew?: readonly AgentLookInput[];
  /** The sky's color (the first agent's by default). */
  color?: AgentColorName;
  /** Without the sky: a quiet icon over the words (a search with nothing found, an empty folder). */
  icon?: IconName;
  /** One way out under the text (a `Button`), centered at its own size. */
  action?: ReactNode;
}

/** The agents standing on an empty sky when the screen has none of its own to show. */
const SOMEONE: readonly AgentLookInput[] = [
  { color: "indigo", eyes: "round", id: "empty-1" },
  { color: "green", eyes: "round", id: "empty-2" },
  { color: "rose", eyes: "round", id: "empty-3" },
];

/**
 * Nothing here yet, in the app's language: where the subject is agents, a window of their pixel sky with a few of
 * them on it (the middle one awake, the others resting); elsewhere a quiet icon or just the words. Then the title,
 * a line of what will be here, and one way out. Loose on the page, as the lists it stands for.
 */
export function EmptyState({ title, subtitle, sky = false, crew, color, icon, action }: EmptyStateProps) {
  const { colors } = useTheme();
  const cast = (crew && crew.length > 0 ? crew : SOMEONE).slice(0, 3);
  const lead = cast[0];
  // The first in the middle, a little bigger and awake; whoever else beside it, resting.
  const order = cast.length === 3 ? [cast[1], cast[0], cast[2]] : cast;
  return (
    <View style={styles.wrap}>
      {sky ? (
        <View style={styles.window}>
          <Sky color={color ?? lead?.color ?? "sky"} depth={0.75} style={StyleSheet.absoluteFill} />
          <View style={styles.crew}>
            {order.map((look, i) =>
              look ? (
                <AgentAvatar
                  key={look.id ?? `${look.color}-${i}`}
                  agent={look}
                  size={look === lead ? 48 : 38}
                  mode={look === lead ? "idle" : "rest"}
                />
              ) : null,
            )}
          </View>
        </View>
      ) : icon ? (
        <View style={[styles.tile, { backgroundColor: colors.sunken, borderColor: colors.line }]}>
          <Icon name={icon} size={24} color={colors.muted} />
        </View>
      ) : null}
      <Text variant="title" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="subhead" tone="muted" style={styles.subtitle}>
          {subtitle}
        </Text>
      ) : null}
      {action ? (
        // A row sized to its content: the button keeps its own width and height (in a column it could take
        // the flex space it sits in, and its own `alignSelf` would pin it to the left edge).
        <View style={styles.action}>{action}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Stretched to its container's width (the sky spans it), whatever the container centers.
  wrap: { alignSelf: "stretch", alignItems: "center", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 32 },
  window: {
    alignSelf: "stretch",
    height: 136,
    marginBottom: 20,
    borderRadius: 20,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 14,
  },
  crew: { flexDirection: "row", alignItems: "flex-end", gap: 14 },
  tile: {
    width: 56,
    height: 56,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
    marginBottom: 16,
  },
  title: { textAlign: "center" },
  subtitle: { textAlign: "center", marginTop: 6, maxWidth: 300 },
  action: { flexDirection: "row", alignSelf: "center", marginTop: 20 },
});
