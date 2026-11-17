import { markTerms } from "@agenteschat/client/lib/search-filters";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { type AgentPresetColor, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { useTrueSheetNavigation } from "@lodev09/react-native-true-sheet/navigation/expo-router";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BackHandler,
  Keyboard,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  fieldText,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  PixelOrbit,
  SheetBar,
  SheetSurface,
  Text,
  useRouteSheetScrollable,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { busyAgents } from "../agents/logic";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { goBack } from "../shared/parts";
import { useConversations, useWorkingNow } from "../shared/queries";
import { newWikiPage } from "../wiki/WikiScreen";
import { askTargets, type CreateItem, chatMatches, createItems } from "./logic";
import { useOpenDm } from "./useOpenDm";

/** The sheet's detents: two thirds over the list at rest; the whole screen once the keyboard is up. */
const DETENTS_REST = [0.66, 1];
const DETENTS_TYPING = [1];

/**
 * "New", the "+" of the tabs, as the system's new message: a sheet over the list (the native form sheet: it tracks
 * the finger, a drag or a flick puts it away, the screen behind steps back), on the grouped gray, the task sheets'
 * bar (`SheetBar`, × in its corner) and the "Para:" field on top (nothing focused until the person taps). Under it,
 * everything as rows: what to start, each with its icon on a soft tile of its color (found at a glance); the agents,
 * the one you talked to last first, a tap opening your conversation in this sheet's place (its keyboard down, as
 * every screen opens: the person taps the field); then the people, and "Invite people" at their end. Typing raises
 * the sheet to the full detent with the keyboard and filters the same agents and people (what to start steps aside,
 * at once, as the system's own search lists do); × puts the sheet away.
 */
export function NewScreen() {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const navigation = useTrueSheetNavigation();
  const { colors } = useTheme();
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const list = useConversations();
  const busy = busyAgents(useWorkingNow());
  const openDm = useOpenDm();
  const field = useRef<TextInputInstance>(null);
  const [q, setQ] = useState("");
  const [typing, setTyping] = useState(false);
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

  const talkTo = (agentId: string) => void openDm({ agentId }, { replace: true });
  const cancel = () => {
    Keyboard.dismiss();
    goBack();
  };

  // The keyboard up: the sheet rises to the whole screen (the system animates the detent change); down, it may rest
  // at two thirds again. The route is a TrueSheet screen (`app/(app)/_layout.tsx`): its heights are its `detents`.
  useEffect(() => {
    navigation.setOptions({ detents: typing ? DETENTS_TYPING : DETENTS_REST });
  }, [navigation, typing]);

  // Android's back drops the keyboard first (as the field's blur does), not the sheet.
  useEffect(() => {
    if (!typing || !focused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      field.current?.blur();
      Keyboard.dismiss();
      return true;
    });
    return () => sub.remove();
  });

  // The list is the sheet's scroll view (dragging at its top moves the sheet, the keyboard insets it).
  const scroll = useRef<ScrollViewInstance>(null);
  useRouteSheetScrollable(scroll);

  return (
    <SheetSurface>
      <ScrollView
        ref={scroll}
        style={styles.fill}
        // The bar rides at the top of the scroll view, pinned, on the sheet's color as the list passes under it.
        stickyHeaderIndices={[0]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
      >
        <SheetBar title={t("mobile.new.title")} onClose={cancel} />
        <View>
          {/* "Para:" and the words, white with a hairline on the gray, as the system's new message. */}
          <View style={styles.search}>
            <View
              style={[styles.field, { backgroundColor: colors.raised, boxShadow: `0px 0px 0px 0.5px ${colors.line2}` }]}
            >
              <Text variant="body" tone="muted">
                {t("mobile.new.to")}
              </Text>
              <TextInput
                ref={field}
                value={q}
                onChangeText={setQ}
                onFocus={() => setTyping(true)}
                onBlur={() => setTyping(false)}
                placeholder={t("mobile.new.search")}
                placeholderTextColor={colors.faint}
                accessibilityLabel={t("mobile.new.chatSearch")}
                autoCorrect={false}
                autoCapitalize="words"
                returnKeyType="search"
                selectionColor={colors.agent}
                style={[styles.input, fieldText("body"), { color: colors.ink }]}
              />
            </View>
          </View>
          <View style={styles.lists}>
            {!typed ? <CreateList items={items.filter((i) => i !== "invite")} /> : null}
            {agents.length > 0 ? (
              <View>
                <GroupedHeader>{t("mobile.find.agents")}</GroupedHeader>
                <GroupedList>
                  {agents.map((a) => {
                    const working = busy.has(a.id);
                    // Who works shows the orbit and the word in the value's place; nobody gets a tag.
                    return (
                      <GroupedRow
                        key={a.id}
                        leading={<AgentFace agentId={a.id} size={FACE} mode={working ? "run" : "idle"} live={false} />}
                        label={a.name}
                        {...(typed ? { labelParts: markTerms(a.name, [typed]) } : {})}
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
              </View>
            ) : null}
            {people.length > 0 || invite ? (
              <View>
                <GroupedHeader>{t("mobile.new.people")}</GroupedHeader>
                <GroupedList>
                  {people.map((p) => (
                    <GroupedRow
                      key={p.userId}
                      leading={<Face who={{ type: "person", id: p.userId }} size={FACE} />}
                      label={p.name}
                      {...(typed ? { labelParts: markTerms(p.name, [typed]) } : {})}
                      chevron
                      // As an agent's: the conversation opens in the sheet's place.
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
              </View>
            ) : null}
            {typed && agents.length + people.length === 0 && !dir.loading ? (
              <EmptyState
                size="inline"
                title={t("mobile.find.nothing", { q: typed })}
                action={
                  <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
                }
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </SheetSurface>
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

/**
 * What to start, as rows: a soft tile of its color, a short name and a hint under it. A personal workspace's channel
 * is a group conversation, and its wiki is for its person's agents (ADR 0159).
 */
function CreateList({ items }: { items: CreateItem[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // The short names reuse labels already translated in every language (a form field's or a screen's name elsewhere).
  const spec: Record<Exclude<CreateItem, "invite">, { label: string; sub: string; onPress: () => void }> = {
    agent: { label: t("missions.new.agent"), sub: t("mobile.new.agentHint"), onPress: () => router.push("/new-agent") },
    channel: {
      label: isPersonal(org) ? t("mobile.new.channelPersonal") : t("missions.new.channel"),
      sub: t(modeKey(org, "mobile.chats.newChannelHint")),
      onPress: () => router.push("/new-channel"),
    },
    task: { label: t("mobile.agent.task"), sub: t("mobile.new.taskHint"), onPress: () => router.push("/issues/new") },
    routine: {
      label: t("routines.panel.eyebrow"),
      sub: t("mobile.new.routineHint"),
      onPress: () => router.push("/routines/new"),
    },
    wiki: {
      label: t("mobile.new.wikiPage"),
      sub: t(modeKey(org, "mobile.new.wikiHint")),
      onPress: () => newWikiPage(),
    },
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

/** The faces in the rows: framed in their skies at 36 (the list's small size); the tiles match them. */
const FACE = 36;

const TILE = 36;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  search: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  field: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 14, borderRadius: 14 },
  input: { flex: 1, minWidth: 0, paddingVertical: 0 },
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
