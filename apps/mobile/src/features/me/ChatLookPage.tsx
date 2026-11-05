import { useSetChatPrefs } from "@agenteschat/client";
import {
  CHAT_STYLES,
  type ChatOpenAt,
  type ChatPrefs,
  type ChatStyle,
  type ChatTone,
  chatLookOf,
  mineOnRight,
} from "@agenteschat/client/lib/chat-look";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, Segmented, Text, useTheme, useToast } from "@/ui";
import { bubbleFill } from "../chat/logic";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { Page } from "./parts";

/** The agent of the samples: the pixel face a DM has. */
const SAMPLE_COLOR: AgentColorName = "green";
const SAMPLE_AGENT = { color: SAMPLE_COLOR, eyes: "round", accessory: "none" } as const;

interface Line {
  mine: boolean;
  text: string;
  time: string;
  /** Continues the row above: no face or name. */
  grouped?: boolean;
}

/** One sample row, in the style's frame. */
function SampleRow({ line, style, tone, dm }: { line: Line; style: ChatStyle; tone: ChatTone; dm: boolean }) {
  const c = useColors();
  const { colors, scheme } = useTheme();
  const dir = useDirectory();
  const meId = useMeId();
  const name = line.mine ? dir.nameOf({ type: "person", id: meId }) : "Ada";
  const face = line.grouped ? null : line.mine ? (
    <View style={[styles.personFace, { backgroundColor: c.sunken }]}>
      <Text variant="caption" tone="muted" style={styles.personLetter}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  ) : (
    <AgentAvatar agent={SAMPLE_AGENT} size={style === "compact" ? 12 : 18} live={false} />
  );
  if (style === "compact")
    return (
      <View style={styles.compact}>
        <Text style={styles.time}>{line.time}</Text>
        <View style={styles.compactFace}>{face}</View>
        <Text style={styles.line} numberOfLines={1}>
          <Text style={styles.bold}>{line.grouped ? "" : `${name}  `}</Text>
          {line.text}
        </Text>
      </View>
    );
  const right = line.mine && mineOnRight(style);
  if (style === "bubbles") {
    const fill = line.mine ? bubbleFill(dm ? SAMPLE_COLOR : "sky", tone, colors.bg, scheme === "dark") : c.bubble;
    return (
      <View style={[styles.row, right && styles.right]}>
        {right ? null : <View style={styles.faceSlot}>{face}</View>}
        <View style={[styles.bubble, { backgroundColor: fill }]}>
          <Text style={[styles.line, line.mine && tone === "strong" ? styles.onSolid : undefined]} numberOfLines={1}>
            {line.text}
          </Text>
        </View>
      </View>
    );
  }
  if (right)
    return (
      <View style={[styles.row, styles.right]}>
        <View style={[styles.bubble, { backgroundColor: c.bubble }]}>
          <Text style={styles.line} numberOfLines={1}>
            {line.text}
          </Text>
        </View>
      </View>
    );
  return (
    <View style={styles.row}>
      <View style={styles.faceSlot}>{face}</View>
      <View style={styles.flex}>
        {line.grouped ? null : (
          <Text style={styles.line} numberOfLines={1}>
            <Text style={styles.bold}>{name}</Text>
            <Text style={styles.time}> {line.time}</Text>
          </Text>
        )}
        <Text style={styles.line} numberOfLines={1}>
          {line.text}
        </Text>
      </View>
    </View>
  );
}

/** A choice: its picture over its radio and name. */
function Choice({
  label,
  checked,
  onPress,
  wide,
  children,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={[
        styles.card,
        wide && styles.cardWide,
        { backgroundColor: c.raised, borderColor: checked ? c.ink : c.line },
      ]}
    >
      <View style={[styles.mini, { backgroundColor: c.bg }]}>{children}</View>
      <View style={styles.foot}>
        <View style={[styles.radio, { borderColor: checked ? c.ink : c.faint }]}>
          {checked ? <View style={[styles.dot, { backgroundColor: c.ink }]} /> : null}
        </View>
        <Text variant="footnote" tone="ink" style={styles.bold} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Conversa, as Sua conta has it on the web: how conversations look to me on every device. Channels and DMs each have
 * their own style, Bolhas its Clara or Forte, and where a conversation opens.
 */
export function ChatLookPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const set = useSetChatPrefs(orgId);
  const [kind, setKind] = useState<"channels" | "dms">("channels");
  const dm = kind === "dms";
  const prefs = org?.chatPrefs;
  const { style, tone } = chatLookOf(prefs, dm);
  const openAt: ChatOpenAt = prefs?.openAt ?? "latest";
  const save = (patch: ChatPrefs) =>
    set.mutate(patch, { onError: () => toast({ title: t("settings.account.activityFailed"), icon: "x" }) });
  const names: Record<ChatStyle, string> = {
    comfortable: t("settings.account.chat.comfortable"),
    left: t("settings.account.chat.left"),
    bubbles: t("settings.account.chat.bubbles"),
    compact: t("settings.account.chat.compact"),
  };
  const talk: Line[] = [
    { mine: true, text: t("settings.account.chat.sample.ask"), time: "14:30" },
    { mine: false, text: t("settings.account.chat.sample.answer"), time: "14:31" },
    { mine: true, text: t("settings.account.chat.sample.go"), time: "14:32" },
  ];
  const fresh: Line[] = [
    { mine: false, text: t("settings.account.chat.sample.new1"), time: "11:02" },
    { mine: false, text: t("settings.account.chat.sample.new2"), time: "11:40", grouped: true },
  ];
  const sent: Line = { mine: false, text: t("settings.account.chat.sample.sent"), time: "09:14" };
  const rows = (lines: Line[], s: ChatStyle) =>
    lines.map((line) => <SampleRow key={line.text} line={line} style={s} tone={tone} dm={dm} />);
  return (
    <Page title={t("settings.account.chat.title")}>
      <View style={styles.gap} />
      <GroupedHeader>{t("settings.account.chat.density")}</GroupedHeader>
      <View style={styles.pad}>
        <Segmented
          items={[
            { key: "channels", label: t("settings.account.chat.channels") },
            { key: "dms", label: t("settings.account.chat.dms") },
          ]}
          value={kind}
          onChange={(k) => setKind(k as "channels" | "dms")}
        />
      </View>
      <View style={styles.grid} accessibilityRole="radiogroup">
        {CHAT_STYLES.map((s) => (
          <Choice
            key={s}
            label={names[s]}
            checked={s === style}
            onPress={() => save(dm ? { dmStyle: s } : { channelStyle: s })}
          >
            {rows(talk, s)}
          </Choice>
        ))}
      </View>
      <GroupedFooter>{t("settings.account.chat.densityHelp")}</GroupedFooter>
      {style === "bubbles" ? (
        <>
          <GroupedHeader>
            {t(dm ? "settings.account.chat.toneDms" : "settings.account.chat.toneChannels")}
          </GroupedHeader>
          <View style={styles.pad}>
            <Segmented
              items={[
                { key: "light", label: t("settings.account.chat.toneLight") },
                { key: "strong", label: t("settings.account.chat.toneStrong") },
              ]}
              value={tone}
              onChange={(v) => save(dm ? { dmTone: v as ChatTone } : { channelTone: v as ChatTone })}
            />
          </View>
          <GroupedFooter>
            {t(dm ? "settings.account.chat.toneDmsHelp" : "settings.account.chat.toneChannelsHelp")}
          </GroupedFooter>
        </>
      ) : null}
      <GroupedHeader>{t("settings.account.chat.openAt")}</GroupedHeader>
      <View style={styles.grid} accessibilityRole="radiogroup">
        <Choice
          wide
          label={t("settings.account.chat.openRead")}
          checked={openAt === "read"}
          onPress={() => save({ openAt: "read" })}
        >
          {rows([sent], style)}
          <UnreadLine />
          {rows(fresh, style)}
        </Choice>
        <Choice
          wide
          label={t("settings.account.chat.openLatest")}
          checked={openAt === "latest"}
          onPress={() => save({ openAt: "latest" })}
        >
          <View style={styles.toEnd}>{rows(fresh, style)}</View>
        </Choice>
      </View>
    </Page>
  );
}

function UnreadLine() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.unread}>
      <Text style={[styles.time, { color: c.action }]}>{t("channel.unreadDivider")}</Text>
      <View style={[styles.rule, { backgroundColor: c.action }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { height: 8 },
  pad: { paddingHorizontal: 16, paddingBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16 },
  card: { flexBasis: "48%", flexGrow: 1, padding: 6, gap: 6, borderRadius: 12, borderWidth: 1 },
  cardWide: { flexBasis: "100%" },
  mini: { height: 88, gap: 3, padding: 6, borderRadius: 8, overflow: "hidden" },
  foot: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 2 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  dot: { width: 9, height: 9, borderRadius: 5 },
  bold: { fontWeight: "600" },
  row: { flexDirection: "row", gap: 4 },
  right: { justifyContent: "flex-end" },
  flex: { flex: 1, minWidth: 0 },
  faceSlot: { width: 18 },
  personFace: { width: 18, height: 18, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  personLetter: { fontSize: 9, lineHeight: 12, fontWeight: "600" },
  bubble: { maxWidth: "86%", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 9 },
  line: { fontSize: 9.5, lineHeight: 13, flexShrink: 1 },
  onSolid: { color: "#ffffff" },
  time: { fontSize: 8, lineHeight: 13 },
  compact: { flexDirection: "row", alignItems: "center", gap: 3 },
  compactFace: { width: 12, overflow: "hidden" },
  toEnd: { flex: 1, justifyContent: "flex-end", gap: 3 },
  unread: { flexDirection: "row", alignItems: "center", gap: 4 },
  rule: { flex: 1, height: 1 },
});
