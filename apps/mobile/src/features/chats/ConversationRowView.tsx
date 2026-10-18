import { router } from "expo-router";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Count, Icon, PixelOrbit, Text } from "@/ui";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { type ConversationRow, type LastLine, threadRowLines } from "./logic";

/** The avatar column (and where the hairline between rows starts). */
const AVATAR = 52;
const INSET = 14 + AVATAR + 12;

/**
 * One conversation in the list (MobileConversas.html): the agent's living body (moving while it works),
 * a person's face, or the tile of a channel; the name and the time; the last line ("Nome: …", two lines),
 * or "trabalhando…" with the pixel orbit when an agent is on it; the unread count in Doto. Threads and
 * missions (MobileRefinos.html `trowApp`) add a faint line with what and where ("Missão · #canal"): a
 * mission shows its agent, its state and items ("Esperando você · 4 de 9 itens") and what waits on you in
 * it; a thread shows the face and the line of its last reply. `live`: the agent moves (the first rows only).
 */
export const ConversationRowView = memo(function ConversationRowView({
  row: r,
  divider = false,
  live = false,
}: {
  row: ConversationRow;
  /** A hairline above (every row but the first). */
  divider?: boolean;
  live?: boolean;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const lastText = (last: LastLine | null) => {
    if (!last) return { who: "", text: "" };
    const who = last.name || (last.author ? dir.nameOf(last.author) : "");
    return { who, text: last.text };
  };
  const agentDm = r.kind === "dm" && r.with.type === "agent";
  const working = r.kind === "channel" ? false : r.working;
  const leading =
    r.kind === "dm" ? (
      agentDm ? (
        <AgentFace agentId={r.with.id} size={AVATAR - 2} mode={working ? "run" : "idle"} live={live} />
      ) : (
        <Face who={{ type: r.with.type, id: r.with.id }} size={AVATAR} live={false} />
      )
    ) : r.kind === "mission" && r.mission ? (
      <AgentFace agentId={r.mission.agentId} size={AVATAR - 2} mode={working ? "run" : "idle"} live={live} />
    ) : r.kind === "thread" || r.kind === "mission" ? (
      <Face who={r.face} size={r.face.type === "agent" ? AVATAR - 2 : AVATAR} live={live} />
    ) : (
      <Tile icon="hash" size={AVATAR} />
    );
  const name = r.kind === "channel" ? r.name : r.kind === "dm" ? r.with.name : r.title;
  // Whose orbit: the DM's agent, or the mission's.
  const orbitAgent = r.kind === "dm" ? r.with.id : r.kind === "mission" ? r.mission?.agentId : null;
  const orbitColor = agentLook(orbitAgent ? dir.agentById.get(orbitAgent) : undefined).color;
  const lines = r.kind === "thread" || r.kind === "mission" ? threadRowLines(r, dir.nameOf) : null;
  // The faint line of a thread or mission: what it is and where ("Missão · #canal").
  const placeLine = lines
    ? [t(lines.kind === "mission" ? "mobile.chats.mission" : "mobile.chats.thread"), lines.where]
        .filter(Boolean)
        .join(" · ")
    : null;
  const badge = lines ? lines.badge : r.unread;

  let line: ReactNode;
  let label: string;
  if (lines?.state && lines.progress) {
    const progress = t("mobile.chats.missionProgress", lines.progress);
    const state = t(`mobile.chats.missionState.${lines.state}`);
    const lead = lines.state === "working" || lines.state === "waiting";
    label = `${state} · ${progress}`;
    line = (
      <View style={styles.work}>
        {lines.state === "working" ? <PixelOrbit color={orbitColor} size={13} /> : null}
        {lines.state === "waiting" ? <Icon name="shield" size={14} color={c.ink2} /> : null}
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
          <Text variant="small" tone={lead ? "ink2" : "muted"} style={lead ? styles.em : undefined}>
            {state}
          </Text>
          {` · ${progress}`}
        </Text>
      </View>
    );
  } else if (working && r.kind !== "mission") {
    label = t("mobile.chats.working");
    line = (
      <View style={styles.work}>
        <PixelOrbit color={orbitColor} size={13} />
        <Text variant="small" tone="ink2" numberOfLines={1} style={[styles.em, styles.shrink]}>
          {label}
        </Text>
      </View>
    );
  } else {
    const last = lastText(r.last);
    const text = r.kind === "channel" ? last.text || r.topic : last.text;
    const lead = last.who;
    label = lead ? `${lead}: ${text}` : text;
    line = (
      <Text variant="small" tone="muted" numberOfLines={lines ? 1 : 2} style={styles.last}>
        {lead ? (
          <Text variant="small" tone="ink2">
            {`${lead}: `}
          </Text>
        ) : null}
        {text}
      </Text>
    );
  }
  if (r.kind === "thread" && r.closed) label = `${t("mobile.chats.closed")}, ${label}`;

  const open = () =>
    router.push(chatHref(r.channelId, r.kind === "thread" || r.kind === "mission" ? r.threadId : null));
  const a11y = [
    name,
    placeLine,
    label,
    r.at ? when.short(r.at) : null,
    r.unread > 0 ? t("mobile.chats.unreadLabel", { count: r.unread }) : null,
    lines?.kind === "mission" && badge > 0
      ? t("mobile.tabs.withCount", { label: t("mobile.home.waiting"), count: badge })
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.avatar}>{leading}</View>
      <View style={styles.tx}>
        <View style={styles.l1}>
          <Text variant="title" numberOfLines={1} style={styles.shrink}>
            {name}
          </Text>
          <View style={styles.grow} />
          {r.at ? (
            <Text variant="small" tone="faint">
              {when.short(r.at)}
            </Text>
          ) : null}
        </View>
        {placeLine ? (
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {r.kind === "thread" && r.closed ? `${placeLine} · ${t("mobile.chats.closed")}` : placeLine}
          </Text>
        ) : null}
        <View style={styles.l2}>
          <View style={styles.grow}>{line}</View>
          {badge > 0 ? <Count value={badge} max={99} inverted /> : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 16,
    minHeight: 76,
  },
  divider: { position: "absolute", top: 0, left: INSET, right: 0, height: StyleSheet.hairlineWidth },
  avatar: { width: AVATAR, height: AVATAR, alignItems: "center", justifyContent: "center" },
  tx: { flex: 1, minWidth: 0, gap: 1 },
  l1: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  l2: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  last: { lineHeight: 20 },
  work: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 },
  em: { fontWeight: "500" },
});
