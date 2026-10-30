import { previewBody } from "@agenteschat/client/lib/message-body";
import { router } from "expo-router";
import { memo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Count, LIST_AVATAR, LIST_PREVIEW, LineIcon, ListRow, PixelOrbit, Text } from "@/ui";
import { workTitle } from "../agents/work";
import { agentIntro } from "../chat/intent";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Tile } from "../shared/parts";
import { usePresenceOf } from "../status/hooks";
import { type ConversationRow, type LastLine, threadRowLines } from "./logic";
import type { AgentRowState } from "./now";

/** The avatar column. */
const AVATAR = LIST_AVATAR;

/**
 * One conversation in the list, in the shared
 * `ListRow`: the agent's living body (moving while it works), a person's face, or the tile of a channel;
 * the name and the time; the last line ("Nome: …", two lines). An agent's row says what matters instead
 * (`agent`): it waits on your ok (amber, "espera seu ok · PR #128"), it waits for its offline computer
 * (dozing, "Esperando o MacBook Air"), or what it is doing with the pixel orbit. Unread: bold name, darker time and preview, the count. Threads and missions
 * add a faint line with what and where ("Missão · #canal"): a mission shows its agent, its state
 * and items ("Esperando você · 4 de 9 itens") and what waits on you in it; a thread shows the face and the
 * line of its last reply. `live`: the agent moves (the first rows only). A DM's face carries the presence badge
 * and its name the status emoji (ADR 0081); an agent with a line of its own says it in place of its last message.
 */
export const ConversationRowView = memo(function ConversationRowView({
  row: r,
  divider = false,
  live = false,
  agent,
  onHold,
  holdLabel,
}: {
  row: ConversationRow;
  /** A hairline above (every row but the first). */
  divider?: boolean;
  live?: boolean;
  /** An agent DM: it waits on you, or what it is doing (from `agentRowState`). */
  agent?: AgentRowState;
  /** A channel on the home: its menu ("Mover para…"), given the row's channel (stable, so the row stays memoized). */
  onHold?: (channelId: string) => void;
  /** What the long press does, for screen readers. */
  holdLabel?: string;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const presenceOf = usePresenceOf();
  const lastText = (last: LastLine | null) => {
    if (!last) return { who: "", text: "" };
    const who = last.name || (last.author ? dir.nameOf(last.author) : "");
    return { who, text: previewBody(t, last.text, last.meta ?? null) };
  };
  const agentDm = r.kind === "dm" && r.with.type === "agent";
  /** A DM with nothing in it yet: who the agent is (as its first conversation says), or a word to start. */
  const introLine = (): string => {
    if (r.kind !== "dm") return "";
    const a = agentDm ? dir.agentById.get(r.with.id) : undefined;
    if (!a) return t("mobile.chats.sayHi", { name: r.with.name });
    const intro = agentIntro(a);
    return intro.kind === "what"
      ? intro.text
      : intro.kind === "role"
        ? t("mobile.chat.intent.roleIntro", { role: intro.role })
        : t("mobile.chat.intent.noIntro");
  };
  const agentState = agentDm ? (agent ?? null) : null;
  // Presence and line (ADR 0081): the agent's from its work, the person's as they set it.
  const agentShown = r.kind === "dm" && agentDm ? presenceOf.agent(r.with.id) : null;
  const personShown = r.kind === "dm" && !agentDm ? presenceOf.person(r.with.id) : null;
  const agentLine = agentShown?.line ?? null;
  const presenceWord = agentShown
    ? t(`presence.${agentShown.presence}`)
    : personShown
      ? t(`presence.${personShown.presence}`)
      : null;
  // Waiting for its offline computer: dozing, no working orbit (its run only waits).
  const away = agentState?.kind === "computer";
  const working = r.kind === "channel" || away ? false : r.working || agentState?.kind === "working";
  const leading =
    r.kind === "dm" ? (
      agentDm ? (
        <AgentFace
          agentId={r.with.id}
          size={AVATAR - 2}
          mode={away ? "rest" : working ? "run" : "idle"}
          live={live}
          presence
        />
      ) : (
        <Face who={{ type: r.with.type, id: r.with.id }} size={AVATAR} live={false} presence />
      )
    ) : r.kind === "mission" && r.mission ? (
      <AgentFace agentId={r.mission.agentId} size={AVATAR - 2} mode={working ? "run" : "idle"} live={live} />
    ) : r.kind === "thread" || r.kind === "mission" ? (
      <Face who={r.face} size={r.face.type === "agent" ? AVATAR - 2 : AVATAR} live={live} />
    ) : (
      <Tile icon="hash" size={AVATAR} />
    );
  const name = r.kind === "channel" ? r.name : r.kind === "dm" ? r.with.name : r.title;
  // The status emoji after a DM's name: the agent's line's, the person's.
  const nameEmoji = agentLine?.emoji ?? personShown?.status?.emoji ?? null;
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
        {lines.state === "waiting" ? (
          <LineIcon name="wait" size={14} color={c.amber} variant="small" text={LIST_PREVIEW} />
        ) : null}
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
        <LineIcon name="wait" size={14} color={c.amber} variant="small" text={LIST_PREVIEW} />
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text variant="small" style={[LIST_PREVIEW, styles.em, { color: c.amber }]}>
            {verb}
          </Text>
          {agentState.title ? ` · ${agentState.title}` : ""}
        </Text>
      </View>
    );
  } else if (agentState?.kind === "computer") {
    label = t("mobile.outage.rowWaiting", { computer: agentState.computer });
    line = (
      <View style={styles.work}>
        <LineIcon name="clock" size={14} color={c.muted} variant="small" text={LIST_PREVIEW} />
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {label}
        </Text>
      </View>
    );
  } else if (agentLine) {
    // Its own line, or the one picked for its run, in place of the last message while it works.
    label = agentLine.text;
    line = (
      <View style={styles.work}>
        {working ? <PixelOrbit color={orbitColor} size={13} /> : null}
        <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.em, styles.shrink]}>
          {agentLine.text}
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
    const text = r.kind === "channel" ? last.text || r.topic : r.last ? last.text : introLine();
    // In a DM the other side's own words need no "Ada:" before them (the row is already Ada's).
    const theirs = r.kind === "dm" && r.last?.author?.type === r.with.type && r.last.author.id === r.with.id;
    const lead = theirs ? "" : last.who;
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
    presenceWord,
    personShown?.status?.text ?? null,
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
      {...(onHold && r.kind === "channel"
        ? {
            onLongPress: () => onHold(r.channelId),
            delayLongPress: 380,
            accessibilityActions: [{ name: "menu", label: holdLabel ?? name }],
            onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
              if (e.nativeEvent.actionName === "menu") onHold(r.channelId);
            },
          }
        : {})}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      divider={divider}
      unread={r.unread > 0}
      leading={leading}
      title={nameEmoji ? `${name} ${nameEmoji}` : name}
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
