import { type AgentPresetColor, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Keyboard, StyleSheet, type TextInputInstance, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  EmptyState,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  PixelOrbit,
  SearchField,
  useReducedMotion,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { busyAgents } from "../agents/logic";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useConversations, useWorkingNow } from "../shared/queries";
import { newWikiPage } from "../wiki/WikiScreen";
import { askTargets, type CreateItem, chatMatches, createItems } from "./logic";
import { useOpenDm } from "./useOpenDm";

/**
 * "New", the "+" of the tabs, as the system's "new message": a pushed screen on the grouped gray with the "To" field
 * on top (nothing focused until the person taps) and everything else as rows. What to start, each with its icon on a
 * soft tile of its own color (found at a glance); the agents, the one you talked to last first, a tap opening your
 * conversation ready to type; then the people, and "Invite people" at their end. Typing filters the same agents and
 * people (what to start steps aside), and "Cancel" brings the screen back.
 */
export function NewScreen() {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const reduced = useReducedMotion();
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const list = useConversations();
  const busy = busyAgents(useWorkingNow());
  const openDm = useOpenDm();
  const field = useRef<TextInputInstance>(null);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const typed = q.trim();
  const recent = useMemo(() => askTargets(dir.agents, list.rows), [dir.agents, list.rows]);
  const found = useMemo(
    () => chatMatches(typed, dir.agents, dir.memberById.values(), meId),
    [typed, dir.agents, dir.memberById, meId],
  );
  // No words: the agents in the order you talk to them; words: the matches.
  const agents = typed ? found.agents : recent;
  const people = found.people;
  const ownsAgent = Boolean(meId) && dir.agents.some((a) => a.ownerUserId === meId);
  const items = createItems(org, { ownsAgent });
  const invite = !typed && items.includes("invite");

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

  // Groups that come and go as the person types fade, and what stays slides into place.
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);

  return (
    <PushedLargeTitle title={t("mobile.new.title")} collapsed={searching} grouped>
      <Animated.View layout={layout}>
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
            raised
          />
        </View>
        <View style={styles.lists}>
          {!typed ? (
            <Animated.View {...fade} layout={layout}>
              <CreateList items={items.filter((i) => i !== "invite")} />
            </Animated.View>
          ) : null}
          {agents.length > 0 ? (
            <Animated.View {...fade} layout={layout}>
              <GroupedHeader>{t("mobile.find.agents")}</GroupedHeader>
              <GroupedList>
                {agents.map((a) => {
                  const working = busy.has(a.id);
                  return (
                    <GroupedRow
                      key={a.id}
                      leading={<AgentFace agentId={a.id} size={30} mode={working ? "run" : "idle"} live={false} />}
                      label={a.name}
                      {...(a.role?.trim() ? { sub: a.role.trim() } : {})}
                      {...(working
                        ? {
                            value: t("taskManager.state.working"),
                            valueLeading: <PixelOrbit color={agentLook(a).color} size={12} />,
                          }
                        : {})}
                      chevron
                      onPress={() => talkTo(a.id)}
                    />
                  );
                })}
              </GroupedList>
            </Animated.View>
          ) : null}
          {people.length > 0 || invite ? (
            <Animated.View {...fade} layout={layout}>
              <GroupedHeader>{t("mobile.new.people")}</GroupedHeader>
              <GroupedList>
                {people.map((p) => (
                  <GroupedRow
                    key={p.userId}
                    leading={<Face who={{ type: "person", id: p.userId }} size={30} />}
                    label={p.name}
                    chevron
                    onPress={() => void openDm({ userId: p.userId }, { replace: true })}
                  />
                ))}
                {invite ? (
                  <GroupedRow
                    leading={<TintTile icon="members" color="teal" />}
                    label={t("members.inviteTitle")}
                    sub={t("mobile.new.inviteHint")}
                    chevron
                    onPress={() => router.push("/invite-people")}
                  />
                ) : null}
              </GroupedList>
            </Animated.View>
          ) : null}
          {typed && agents.length + people.length === 0 && !dir.loading ? (
            <EmptyState size="inline" title={t("mobile.find.nothing", { q: typed })} />
          ) : null}
        </View>
      </Animated.View>
    </PushedLargeTitle>
  );
}

/** Each thing to start has a color of its own, so it is found without reading. */
const CREATE_LOOK: Record<Exclude<CreateItem, "invite">, { icon: IconName; color: AgentPresetColor }> = {
  agent: { icon: "agent", color: "violet" },
  channel: { icon: "hash", color: "sky" },
  task: { icon: "checkc", color: "green" },
  routine: { icon: "clock", color: "amber" },
  wiki: { icon: "file", color: "graphite" },
};

/** What to start, as rows: a soft tile of its color, a short name and a hint under it. */
function CreateList({ items }: { items: CreateItem[] }) {
  const { t } = useTranslation();
  // The short names reuse labels already translated in every language (a form field's or a screen's name elsewhere).
  const spec: Record<Exclude<CreateItem, "invite">, { label: string; sub: string; onPress: () => void }> = {
    agent: { label: t("missions.new.agent"), sub: t("mobile.new.agentHint"), onPress: () => router.push("/new-agent") },
    channel: {
      label: t("missions.new.channel"),
      sub: t("mobile.chats.newChannelHint"),
      onPress: () => router.push("/new-channel"),
    },
    task: { label: t("mobile.agent.task"), sub: t("mobile.new.taskHint"), onPress: () => router.push("/issues/new") },
    routine: {
      label: t("routines.panel.eyebrow"),
      sub: t("mobile.new.routineHint"),
      onPress: () => router.push("/routines/new"),
    },
    wiki: { label: t("mobile.new.wikiPage"), sub: t("mobile.new.wikiHint"), onPress: () => newWikiPage() },
  };
  const create = items.filter((i): i is Exclude<CreateItem, "invite"> => i !== "invite");
  if (create.length === 0) return null;
  return (
    <>
      <GroupedHeader>{t("mobile.new.create")}</GroupedHeader>
      <GroupedList>
        {create.map((item) => (
          <GroupedRow key={item} leading={<TintTile {...CREATE_LOOK[item]} />} {...spec[item]} subLines={2} chevron />
        ))}
      </GroupedList>
    </>
  );
}

/** An icon on a soft tile of its color: the color's light tone over the row, its deep tone for the glyph. */
function TintTile({ icon, color }: { icon: IconName; color: AgentPresetColor }) {
  const { colors, scheme } = useTheme();
  const [light, deep] = gradientOf(color);
  const dark = scheme === "dark";
  return (
    <View style={[styles.tint, { backgroundColor: mixHex(colors.raised, light, dark ? 0.3 : 0.45) }]}>
      <Icon name={icon} size={16} color={dark ? light : deep} />
    </View>
  );
}

const TILE = 30;

const styles = StyleSheet.create({
  search: { paddingHorizontal: 16, paddingBottom: 4 },
  lists: { paddingHorizontal: 16, paddingBottom: 24 },
  tint: {
    width: TILE,
    height: TILE,
    // Proportional, as the faces' tiles beside it.
    borderRadius: Math.round(TILE * 0.3),
    alignItems: "center",
    justifyContent: "center",
  },
});
