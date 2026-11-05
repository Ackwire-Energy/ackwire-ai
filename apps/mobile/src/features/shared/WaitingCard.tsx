import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Fuse, Icon, type IconName, Sky, Text, weights } from "@/ui";
import { AgentFace } from "./Face";
import { useColors, useDirectory } from "./hooks";
import { agentLook } from "./logic";
import { useSurface } from "./parts";

/** The leading face: an agent's (on its sky), or what stands for whoever asks (a server's mark, people's faces). */
const FACE = 36;

export interface WaitingCardProps {
  /** The agent asking: its face leads the card and its sky tints the card's top. */
  agentId?: string | null;
  /** Leads the card when no agent asks (a connector's mark, the faces of who asks to join), FACE points wide. */
  leading?: ReactNode;
  /** Who asks ("Ada", "TikTok"); the kind goes under it. */
  name?: string;
  kind: { icon: IconName; label: string };
  title?: string;
  /** Under the title: why it was asked, what it costs, its own actions. */
  children?: ReactNode;
  /** Its deadline: the fuse's remaining share (0–1) and "expira em …". */
  expires?: { remaining: number; label: string } | null;
  /** Without a deadline: where and when ("#marketing · 19:58"). */
  where?: string;
  action?: { label: string; onPress: () => void } | null;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Under the card's foot, after a hairline ("e mais 2 esperando você"). */
  footer?: ReactNode;
}

/**
 * One thing waiting on you, as Atividade and Conversas' strip show it: the card with its cut corner (square
 * bottom left, as the chat's blocks), the asking agent's sky faint across the top, its face with the name and the
 * kind under it (the icon in amber, the waiting color), the request in words, then the fuse and "expira em" (or
 * where and when) and one tactile button.
 */
export function WaitingCard({
  agentId,
  leading,
  name,
  kind,
  title,
  children,
  expires,
  where,
  action,
  onPress,
  accessibilityLabel,
  footer,
}: WaitingCardProps) {
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  return (
    <View style={[styles.card, surface]}>
      <View style={styles.clip}>
        {agent ? (
          <Sky color={agentLook(agent).color} depth={0.55} fade={0.15} surface="raised" style={styles.sky} />
        ) : null}
        <Pressable
          onPress={onPress}
          disabled={!onPress}
          accessibilityRole={onPress ? "button" : undefined}
          accessibilityLabel={accessibilityLabel}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
        >
          <View style={styles.hd}>
            {agentId ? <AgentFace agentId={agentId} size={FACE} live={false} /> : leading}
            <View style={styles.grow}>
              {name ? (
                <Text variant="small" tone="ink" numberOfLines={1} style={styles.semibold}>
                  {name}
                </Text>
              ) : null}
              <View style={styles.kind}>
                <Icon name={kind.icon} size={13} color={c.amber} />
                <Text variant="footnote" tone="muted" numberOfLines={1} style={[styles.medium, styles.shrink]}>
                  {kind.label}
                </Text>
              </View>
            </View>
          </View>
          {title ? (
            <Text variant="title" tone="ink" numberOfLines={3}>
              {title}
            </Text>
          ) : null}
          {children}
        </Pressable>
        {expires || where || action ? (
          <View style={styles.ft}>
            {expires ? (
              <>
                <Fuse color="amber" remaining={expires.remaining} style={styles.fuse} />
                <Text variant="footnote" numberOfLines={1} style={[styles.when, styles.shrink, { color: c.amber }]}>
                  {expires.label}
                </Text>
              </>
            ) : where ? (
              <Text variant="footnote" tone="faint" numberOfLines={1} style={[styles.when, styles.shrink]}>
                {where}
              </Text>
            ) : null}
            <View style={styles.grow} />
            {action ? <Button variant="primary" size="sm" label={action.label} onPress={action.onPress} /> : null}
          </View>
        ) : null}
        {footer ? <View style={[styles.footer, { borderTopColor: c.line2 }]}>{footer}</View> : null}
      </View>
    </View>
  );
}

/** The cut corner: square-ish bottom left, the rest round (the chat's blocks, the web's cards). */
const RADIUS = 20;
const CUT = 6;

const styles = StyleSheet.create({
  card: { borderRadius: RADIUS, borderBottomLeftRadius: CUT },
  clip: { borderRadius: RADIUS, borderBottomLeftRadius: CUT, overflow: "hidden", paddingBottom: 14 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 56, opacity: 0.5 },
  body: { paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  hd: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 2 },
  kind: { flexDirection: "row", alignItems: "center", gap: 4 },
  ft: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  fuse: { flex: 0, width: 90 },
  when: { fontVariant: ["tabular-nums"] },
  footer: { marginTop: 12, marginHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  semibold: { fontWeight: weights.semibold },
  medium: { fontWeight: weights.medium },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.85 },
});
