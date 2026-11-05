import { router, useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Keyboard, ScrollView, StyleSheet, type TextInputInstance, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { GroupedHeader, GroupedList, GroupedRow, type GroupedRowProps, PressScale, SearchField, Text } from "@/ui";
import { busyAgents } from "../agents/logic";
import { AgentFace } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useConversations, useWorkingNow } from "../shared/queries";
import { newWikiPage } from "../wiki/WikiScreen";
import { ChatTargets } from "./ChatTargets";
import { askTargets, type CreateItem, createItems } from "./logic";
import { useOpenDm } from "./useOpenDm";

/** Faces in the row that move (a long team stays light). */
const LIVE_FACES = 6;

/**
 * "New", the "+" of the tabs, as a pushed screen on the grouped gray with nothing focused (no keyboard until the
 * person taps): the large title, the "Chat with…" search, the agents as a row of faces with their names (the one you
 * talked to last first; a tap opens your conversation ready to type), then what to start as a settings-like list,
 * each where this person may, and "Invite people" in a list of its own. Tapping the search folds the title away and
 * lists people and agents as it filters; "Cancel" brings the screen back.
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
    <PushedLargeTitle title={t("mobile.new.title")} collapsed={searching} grouped>
      <Animated.View layout={LinearTransition.duration(220)}>
        <View style={styles.search}>
          <SearchField
            ref={field}
            value={q}
            onChangeText={setQ}
            placeholder={t("mobile.new.chat")}
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
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.faces}>
                {agents.map((a, i) => (
                  <AgentChip
                    key={a.id}
                    agentId={a.id}
                    name={a.name}
                    working={busy.has(a.id)}
                    live={i < LIVE_FACES}
                    onPress={() => talkTo(a.id)}
                  />
                ))}
              </ScrollView>
            ) : null}
            <CreateLists items={items} />
          </>
        )}
      </Animated.View>
    </PushedLargeTitle>
  );
}

/** One agent you can talk to: its face and its name under it, nothing around them. */
function AgentChip({
  agentId,
  name,
  working,
  live,
  onPress,
}: {
  agentId: string;
  name: string;
  working: boolean;
  live: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PressScale
      to={0.96}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={working ? t("mobile.a11y.agentWorking", { name }) : t("mobile.a11y.agent", { name })}
      style={styles.face}
      contentStyle={styles.faceIn}
    >
      <AgentFace agentId={agentId} size={52} mode={working ? "run" : "idle"} live={live} />
      <Text variant="caption" tone="ink2" numberOfLines={1}>
        {name}
      </Text>
    </PressScale>
  );
}

type CreateRow = Required<Pick<GroupedRowProps, "icon" | "label" | "sub" | "onPress">>;

/**
 * What to start, as rows with an icon, a short name and a hint under it; "Invite people" is a list of its own
 * below, since it brings people in rather than making something.
 */
function CreateLists({ items }: { items: CreateItem[] }) {
  const { t } = useTranslation();
  // The short names reuse labels already translated in every language (a form field's or a screen's name elsewhere).
  const spec: Record<CreateItem, CreateRow> = {
    agent: {
      icon: "agent",
      label: t("missions.new.agent"),
      sub: t("mobile.new.agentHint"),
      onPress: () => router.push("/new-agent"),
    },
    channel: {
      icon: "hash",
      label: t("missions.new.channel"),
      sub: t("mobile.chats.newChannelHint"),
      onPress: () => router.push("/new-channel"),
    },
    task: {
      icon: "checkc",
      label: t("mobile.agent.task"),
      sub: t("mobile.new.taskHint"),
      onPress: () => router.push("/issues/new"),
    },
    routine: {
      icon: "clock",
      label: t("routines.panel.eyebrow"),
      sub: t("mobile.new.routineHint"),
      onPress: () => router.push("/routines/new"),
    },
    wiki: {
      icon: "file",
      label: t("mobile.new.wikiPage"),
      sub: t("mobile.new.wikiHint"),
      onPress: () => newWikiPage(),
    },
    invite: {
      icon: "members",
      label: t("members.inviteTitle"),
      sub: t("mobile.new.inviteHint"),
      onPress: () => router.push("/invite-people"),
    },
  };
  const create = items.filter((i) => i !== "invite");
  return (
    <View style={styles.lists}>
      {create.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.new.create")}</GroupedHeader>
          <GroupedList>
            {create.map((item) => (
              <GroupedRow key={item} {...spec[item]} subLines={2} chevron />
            ))}
          </GroupedList>
        </>
      ) : null}
      {items.includes("invite") ? (
        <View style={styles.apart}>
          <GroupedList>
            <GroupedRow {...spec.invite} subLines={2} chevron />
          </GroupedList>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 4 },
  results: { paddingHorizontal: 16, paddingTop: 8, gap: 10 },
  // The row runs edge to edge, its first and last faces at the screen's margin.
  faces: { gap: 14, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2 },
  face: { width: 62 },
  faceIn: { alignItems: "center", gap: 6 },
  lists: { paddingHorizontal: 16 },
  apart: { marginTop: 22 },
});
