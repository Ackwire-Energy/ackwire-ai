import { router, useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Keyboard, ScrollView, StyleSheet, type TextInputInstance, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Icon, type IconName, PressScale, SearchField, Section, Text } from "@/ui";
import { busyAgents } from "../agents/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { Tile, useSurface } from "../shared/parts";
import { useConversations, useWorkingNow } from "../shared/queries";
import { newWikiPage } from "../wiki/WikiScreen";
import { ChatTargets } from "./ChatTargets";
import { askTargets, type CreateItem, createItems } from "./logic";
import { useOpenDm } from "./useOpenDm";

/** Agent cards whose face moves (a long team stays light). */
const LIVE_CARDS = 6;

/**
 * "New", the "+" of the tabs, as a pushed screen with nothing focused (no keyboard until the person taps): the large
 * title, the "Person or agent" search, the agents as cards with their faces (the one you talked to last first; a tap
 * opens your conversation ready to type), then a grid of what to start, each where this person may ("Invite people"
 * the wide row at its end). Tapping the search folds the title away and lists people and agents as it filters;
 * "Cancel" brings the screen back.
 */
export function NewScreen() {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const list = useConversations();
  const busy = busyAgents(useWorkingNow());
  const openDm = useOpenDm();
  const field = useRef<TextInputInstance>(null);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const agents = useMemo(() => askTargets(dir.agents, list.rows), [dir.agents, list.rows]);
  const ownsAgent = Boolean(meId) && dir.agents.some((a) => a.ownerUserId === meId);
  const items = createItems(org, { ownsAgent });

  const talkTo = (agentId: string) => void openDm({ agentId }, { compose: true, replace: true });
  const cancel = () => {
    setQ("");
    setSearching(false);
    field.current?.blur();
    Keyboard.dismiss();
  };

  // Android's back ends the search first (as "Cancel" does), not the screen.
  useEffect(() => {
    if (!searching || !focused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      cancel();
      return true;
    });
    return () => sub.remove();
  });

  return (
    <PushedLargeTitle title={t("mobile.new.title")} collapsed={searching}>
      <Animated.View layout={LinearTransition.duration(220)}>
        <View style={styles.search}>
          <SearchField
            ref={field}
            value={q}
            onChangeText={setQ}
            placeholder={t("mobile.new.search")}
            accessibilityLabel={t("mobile.new.chatSearch")}
            onFocus={() => setSearching(true)}
            onCancel={cancel}
            showCancel={searching}
            autoCorrect={false}
          />
        </View>
        {searching ? (
          <View style={styles.results}>
            <ChatTargets q={q} onAgent={talkTo} onPerson={(userId) => void openDm({ userId }, { replace: true })} />
          </View>
        ) : (
          <>
            {agents.length > 0 ? (
              <Section title={t("palette.ask")}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.cardsOut}
                  contentContainerStyle={styles.cards}
                >
                  {agents.map((a, i) => (
                    <AgentCard
                      key={a.id}
                      agentId={a.id}
                      name={a.name}
                      role={a.role}
                      working={busy.has(a.id)}
                      live={i < LIVE_CARDS}
                      onPress={() => talkTo(a.id)}
                    />
                  ))}
                </ScrollView>
              </Section>
            ) : null}
            <Section title={t("mobile.new.create")}>
              <CreateGrid items={items} />
            </Section>
          </>
        )}
      </Animated.View>
    </PushedLargeTitle>
  );
}

/** One agent you can ask: its face, its name, and its role (or that it is working). */
function AgentCard({
  agentId,
  name,
  role,
  working,
  live,
  onPress,
}: {
  agentId: string;
  name: string;
  role: string;
  working: boolean;
  live: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const sub = working ? t("mobile.chats.working") : role.trim();
  return (
    <PressScale
      to={0.96}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={sub ? `${name}, ${sub}` : name}
      style={[styles.agent, surface]}
      contentStyle={styles.agentIn}
    >
      <AgentFace agentId={agentId} size={56} mode={working ? "run" : "idle"} live={live} />
      <View style={styles.agentText}>
        <Text variant="subhead" style={styles.bold} numberOfLines={1}>
          {name}
        </Text>
        {sub ? (
          <Text variant="caption" style={{ color: working ? c.ink2 : c.faint }} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
    </PressScale>
  );
}

interface CellSpec {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
}

/** The grid of what to start, two to a row; "Invite people" spans the row at the end. */
function CreateGrid({ items }: { items: CreateItem[] }) {
  const { t } = useTranslation();
  const spec: Record<CreateItem, CellSpec> = {
    agent: {
      icon: "agent",
      label: t("mobile.agents.create"),
      hint: t("mobile.new.agentHint"),
      onPress: () => router.push("/new-agent"),
    },
    channel: {
      icon: "hash",
      label: t("mobile.chats.newChannel"),
      hint: t("mobile.chats.newChannelHint"),
      onPress: () => router.push("/new-channel"),
    },
    chat: {
      icon: "compose",
      label: t("mobile.new.chatShort"),
      hint: t("mobile.new.chatHint"),
      onPress: () => router.push("/new-chat"),
    },
    task: {
      icon: "checkc",
      label: t("mobile.issues.new"),
      hint: t("mobile.new.taskHint"),
      onPress: () => router.push("/issues/new"),
    },
    routine: {
      icon: "clock",
      label: t("routines.new"),
      hint: t("mobile.new.routineHint"),
      onPress: () => router.push("/routines/new"),
    },
    wiki: {
      icon: "file",
      label: t("mobile.new.wikiPage"),
      hint: t("mobile.new.wikiHint"),
      onPress: () => newWikiPage(),
    },
    invite: {
      icon: "members",
      label: t("members.inviteTitle"),
      hint: t("mobile.new.inviteHint"),
      onPress: () => router.push("/invite-people"),
    },
  };
  const cells = items.filter((i) => i !== "invite");
  const rows: CreateItem[][] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
  return (
    <View style={styles.grid}>
      {rows.map((row) => (
        <View key={row.join("|")} style={styles.gridRow}>
          {row.map((item) => (
            <CreateCell key={item} {...spec[item]} />
          ))}
          {row.length === 1 ? <View style={styles.cellSpacer} /> : null}
        </View>
      ))}
      {items.includes("invite") ? <CreateCell {...spec.invite} wide /> : null}
    </View>
  );
}

/** A thing to start: its icon in a tile, its name and a hint; `wide` lays it out as a row with a chevron. */
function CreateCell({ icon, label, hint, onPress, wide = false }: CellSpec & { wide?: boolean }) {
  const c = useColors();
  const surface = useSurface();
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${hint}`}
      style={[styles.cell, wide ? styles.cellWide : styles.cellHalf, surface]}
      contentStyle={wide ? styles.cellWideIn : styles.cellIn}
    >
      <Tile icon={icon} size={38} />
      <View style={wide ? styles.cellWideText : null}>
        <Text variant="callout" style={styles.bold} numberOfLines={2}>
          {label}
        </Text>
        <Text variant="footnote" tone="faint" numberOfLines={2}>
          {hint}
        </Text>
      </View>
      {wide ? <Icon name="right" size={16} color={c.faint} /> : null}
    </PressScale>
  );
}

/** The cards' corner: round, with the lower left one cut (as the app's cards). */
const corner = { borderRadius: 20, borderBottomLeftRadius: 6 } as const;

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 4 },
  results: { paddingHorizontal: 16, paddingTop: 8, gap: 10 },
  // The row runs edge to edge; the room above and below keeps the cards' shadows unclipped.
  cardsOut: { marginHorizontal: -16 },
  cards: { gap: 10, paddingHorizontal: 16, paddingVertical: 4 },
  agent: { width: 104, ...corner },
  agentIn: { alignItems: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 10 },
  agentText: { alignItems: "center", alignSelf: "stretch" },
  bold: { fontWeight: "600" },
  grid: { gap: 10 },
  gridRow: { flexDirection: "row", gap: 10 },
  cell: corner,
  cellHalf: { flex: 1, minHeight: 112 },
  cellWide: { alignSelf: "stretch" },
  cellSpacer: { flex: 1 },
  cellIn: { gap: 14, padding: 14 },
  cellWideIn: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, paddingHorizontal: 14 },
  cellWideText: { flex: 1, minWidth: 0 },
});
