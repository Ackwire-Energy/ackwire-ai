import { router } from "expo-router";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Count, Icon, LIST_AVATAR, LIST_PREVIEW, ListRow, PixelOrbit, Text } from "@/ui";
import { workTitle } from "../agents/work";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { type ConversationRow, type LastLine, threadRowLines } from "./logic";
import type { AgentRowState } from "./now";

/** The avatar column. */
const AVATAR = LIST_AVATAR;

/**
 * One conversation in the list (MobileConversas.html, readable per MobileIntencional.html), in the shared
 * `ListRow`: the agent's living body (moving while it works), a person's face, or the tile of a channel;
 * the name and the time; the last line ("Nome: …", two lines). An agent's row says what matters instead
 * (`agent`): it waits on your ok (amber, "espera seu ok · PR #128"), or what it is doing with the pixel
 * orbit. Unread: bold name, darker time and preview, the count. Threads and missions (MobileRefinos.html
 * `trowApp`) add a faint line with what and where ("Missão · #canal"): a mission shows its agent, its state
 * and items ("Esperando você · 4 de 9 itens") and what waits on you in it; a thread shows the face and the
 * line of its last reply. `live`: the agent moves (the first rows only).
 */
export const ConversationRowView = memo(function ConversationRowView({
  row: r,
  divider = false,
  live = false,
  agent,
}: {
  row: ConversationRow;
  /** A hairline above (every row but the first). */
  divider?: boolean;
  live?: boolean;
  /** An agent DM: it waits on you, or what it is doing (from `agentRowState`). */
  agent?: AgentRowState;
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
  const agentState = agentDm ? (agent ?? null) : null;
  const working = r.kind === "channel" ? false : r.working || agentState?.kind === "working";
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
        {lines.state === "waiting" ? <Icon name="shield" size={14} color={c.amber} /> : null}
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text
            variant="small"
            tone={lead ? "ink2" : "muted"}
            style={[LIST_PREVIEW, lead ? styles.em : null, lines.state === "waiting" ? { color: c.amber } : null]}
          >
            {state}
          </Text>
          {` · ${progress}`}
        </Text>
      </View>
    );
  } else if (agentState?.kind === "waiting") {
    const verb = t(`mobile.homeNow.rowWait.${agentState.wait}`);
    label = [verb, agentState.title].filter(Boolean).join(" · ");
    line = (
      <View style={styles.work}>
        <Icon name="shield" size={14} color={c.amber} />
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text variant="small" style={[LIST_PREVIEW, styles.em, { color: c.amber }]}>
            {verb}
          </Text>
          {agentState.title ? ` · ${agentState.title}` : ""}
        </Text>
      </View>
    );
  } else if (working && r.kind !== "mission") {
    const doing = agentState?.kind === "working" ? workTitle(t, agentState.work) : "";
    label = doing ? t("mobile.homeNow.doingLabel", { what: doing }) : t("mobile.chats.working");
    line = (
      <View style={styles.work}>
        <PixelOrbit color={orbitColor} size={13} />
        <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.em, styles.shrink]}>
          {doing || t("mobile.chats.working")}
        </Text>
      </View>
    );
  } else {
    const last = lastText(r.last);
    const text = r.kind === "channel" ? last.text || r.topic : last.text;
    const lead = last.who;
    label = lead ? `${lead}: ${text}` : text;
    line = (
      <Text variant="small" tone={r.unread > 0 ? "ink2" : "muted"} numberOfLines={lines ? 1 : 2} style={LIST_PREVIEW}>
        {lead ? (
          <Text variant="small" tone="ink2" style={[LIST_PREVIEW, styles.em]}>
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
    <ListRow
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      divider={divider}
      unread={r.unread > 0}
      leading={leading}
      title={name}
      time={r.at ? when.short(r.at) : null}
      over={
        placeLine ? (
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {r.kind === "thread" && r.closed ? `${placeLine} · ${t("mobile.chats.closed")}` : placeLine}
          </Text>
        ) : null
      }
      sub={line}
      trailing={badge > 0 ? <Count value={badge} max={99} inverted /> : null}
    />
  );
});

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  work: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 },
  em: { fontWeight: "500" },
});
