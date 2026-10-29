import {
  useApi,
  useCatalog,
  useChannels,
  useConnections,
  useCreateAgent,
  useCustomServers,
  useDms,
  useSkills,
} from "@agenteschat/client";
import { type Level, saveLevels } from "@agenteschat/client/lib/access-levels";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  cleanHandle,
  freeHandle,
  handleForName,
  handleProblem,
  presetChannels,
  presetLevels,
  ROLE_DEFAULTS,
  ROLE_GROUPS,
  type RoleId,
} from "@agenteschat/client/lib/new-agent";
import { AUTO } from "@agenteschat/client/lib/providers";
import { useNavigation } from "expo-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar, Button, Card, fieldText, Icon, Row, Text, Toggle, useToast } from "@/ui";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { suggestAgentName } from "../new/logic";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { type FullLook, fullLook } from "./edit";
import { LookPicker } from "./LookPicker";
import { firstBlockedStep, NEW_AGENT_PHONE_STEPS, type PhoneStep, stepBlocked } from "./new-agent";

/**
 * "Criar agente" on the phone, the web's steps for a thumb: Papel (the presets, grouped), Quem é
 * (name, @ and look), O que faz (the instructions, prefilled by the role) and Revisar (what it can use
 * and the channels it joins, from the role). Model, budget and who it answers start at the workspace's
 * defaults and change on its page. Created, it opens the direct conversation with it. `initialWhat`
 * (an example in the empty Conversas) starts from scratch with that text.
 */
export function NewAgentScreen({ initialWhat = "" }: { initialWhat?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const api = useApi();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const create = useCreateAgent(orgId);
  const openDm = useOpenDm();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const library = useSkills(orgId);
  const scroll = useRef<ScrollView>(null);

  const suggested = suggestAgentName(dir.agents.map((a) => a.name));
  const [index, setIndex] = useState(initialWhat ? 1 : 0);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<RoleId | null>(initialWhat ? "custom" : null);
  const [name, setName] = useState(initialWhat ? suggested : "");
  const [handle, setHandle] = useState(initialWhat ? handleForName(suggested) : "");
  const [handleTouched, setHandleTouched] = useState(false);
  const [look, setLook] = useState<FullLook>(fullLook(ROLE_DEFAULTS.custom.look));
  const [instructions, setInstructions] = useState(initialWhat);
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const created = useRef(false);

  const step: PhoneStep = NEW_AGENT_PHONE_STEPS[index] ?? "role";
  const total = NEW_AGENT_PHONE_STEPS.length;
  const items = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const levels = useMemo(() => presetLevels(role ?? "custom", items), [role, items]);
  const granted = items.filter((i) => (levels[i.id] ?? "none") !== "none");
  const myChannels = useMemo(() => {
    const dmIds = new Set((dms.data ?? []).map((d) => d.channelId));
    return (channels.data ?? []).filter((ch) => ch.isMember && !dmIds.has(ch.id));
  }, [channels.data, dms.data]);
  const taken = useMemo(
    () =>
      new Set([
        ...dir.agents.map((a) => a.handle.toLowerCase()),
        ...[...dir.memberById.values()].map((m) => m.handle.toLowerCase()).filter(Boolean),
      ]),
    [dir.agents, dir.memberById],
  );
  const draft = { role, name, handle, taken };
  const shownName = name.trim() || t("newAgent.previewName");
  const g = agentGrammar(t, name.trim() || t("newAgent.defaultName"));
  const handleIssue = handle || tried ? handleProblem(handle, taken) : null;
  const handleText =
    handleIssue === "taken"
      ? t("newAgent.errors.handleTaken", { handle, suggestion: freeHandle(handle, taken) })
      : handleIssue === "format"
        ? t("newAgent.errors.handleFormat")
        : handleIssue === "empty"
          ? t("newAgent.errors.handleEmpty")
          : handle
            ? t("newAgent.handleHelp", { handle })
            : t("newAgent.handleEmpty");

  // Leaving with a draft asks first; the header's back leaves the whole flow.
  const dirty = role !== null || name.trim() !== "" || instructions.trim() !== "";
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e) => {
        if (created.current || !dirty) return;
        e.preventDefault();
        Alert.alert(t("mobile.newAgent.leaveTitle"), t("mobile.newAgent.leaveText"), [
          { text: t("mobile.newAgent.keepGoing"), style: "cancel" },
          { text: t("newAgent.leave"), style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation, dirty, t],
  );

  const goTo = (i: number) => {
    setTried(false);
    setIndex(Math.max(0, Math.min(total - 1, i)));
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const pickRole = (id: RoleId) => {
    tapHaptic();
    const agentName = id === "custom" ? "" : t(`newAgent.roles.${id}.agent`);
    setRole(id);
    setName(agentName);
    setHandle(handleForName(agentName));
    setHandleTouched(false);
    setLook(fullLook(ROLE_DEFAULTS[id].look));
    setInstructions(t(`newAgent.roles.${id}.instructions`));
    setChannelIds(new Set(presetChannels(id, myChannels)));
    // A tap is the answer: on to the next step.
    setTimeout(() => goTo(1), 180);
  };
  const changeName = (value: string) => {
    setName(value);
    if (!handleTouched) setHandle(handleForName(value));
  };

  const submit = async () => {
    const bad = firstBlockedStep(draft);
    if (bad >= 0) {
      goTo(bad);
      setTried(true);
      return;
    }
    setBusy(true);
    try {
      const agent = await create.mutateAsync({
        name: name.trim(),
        handle,
        role: role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : "",
        instructions,
        model: AUTO,
        ownerUserId: meId ?? null,
        audience: { mode: "everyone", userIds: [] },
        credentialId: null,
        monthlyBudgetUsd: null,
        appearance: look,
      });
      created.current = true;
      // What the role brings, as the web's last step: its channels, its apps' levels, the default skills.
      const joined = myChannels.filter((ch) => channelIds.has(ch.id));
      if (joined.length > 0)
        await api.agents.setChannels(
          orgId,
          agent.id,
          joined.map((ch) => ({ channelId: ch.id })),
        );
      const chosen = Object.fromEntries(granted.map((i) => [`connector:${i.id}`, levels[i.id] as Level]));
      if (Object.keys(chosen).length > 0) await saveLevels(api, orgId, agent.id, chosen);
      const list = library.data ?? [];
      if (list.length > 0)
        await api.skills.setForAgent(
          orgId,
          agent.id,
          list.map((s) => ({ skillId: s.id, enabled: s.defaultForNewAgents })),
        );
      successHaptic();
      toast({ title: t("mobile.agents.created", { name: agent.name }), agentId: agent.id });
      void openDm({ agentId: agent.id });
    } catch (e) {
      if (created.current) {
        // The agent exists; only part of what the role brings didn't go through.
        toast({ title: t("mobile.newAgent.partly"), icon: "x" });
      } else failed(e);
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    if (busy) return;
    if (stepBlocked(step, draft)) {
      setTried(true);
      return;
    }
    if (index === total - 1) void submit();
    else goTo(index + 1);
  };

  const head = (title: string, lead?: string) => (
    <View style={styles.head}>
      <Text variant="display2" accessibilityRole="header">
        {title}
      </Text>
      {lead ? (
        <Text variant="body" tone="muted">
          {lead}
        </Text>
      ) : null}
    </View>
  );
  const input = [styles.input, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];

  const views: Record<PhoneStep, () => ReactNode> = {
    role: () => (
      <>
        {head(t("newAgent.steps.role.title"), t("newAgent.steps.role.lead"))}
        {ROLE_GROUPS.map((group) => (
          <View key={group.id} style={styles.group}>
            <Text variant="footnote" tone="faint" style={styles.groupTitle}>
              {t(`newAgent.roleGroups.${group.id}`)}
            </Text>
            {group.roles.map((id) => (
              <RoleCard
                key={id}
                on={role === id}
                onPress={() => pickRole(id)}
                leading={<AgentAvatar agent={fullLook(ROLE_DEFAULTS[id].look)} size={48} live={false} />}
                title={t(`newAgent.roles.${id}.name`)}
                caption={t("newAgent.startsAs", { name: t(`newAgent.roles.${id}.agent`) })}
                desc={t(`newAgent.roles.${id}.desc`)}
              />
            ))}
          </View>
        ))}
        <View style={styles.group}>
          <RoleCard
            on={role === "custom"}
            onPress={() => pickRole("custom")}
            leading={
              <View style={[styles.blank, { borderColor: c.line2 }]}>
                <Icon name="plus" size={20} color={c.muted} />
              </View>
            }
            title={t("newAgent.roles.custom.name")}
            desc={t("newAgent.roles.custom.desc")}
          />
        </View>
        {tried && !role ? <ErrorLine text={t("newAgent.errors.roleRequired")} /> : null}
      </>
    ),
    identity: () => (
      <>
        {head(t("newAgent.steps.identity.title"), t("newAgent.steps.identity.lead"))}
        <View style={styles.hero}>
          <AgentAvatar agent={look} size={104} name={shownName} />
        </View>
        <Text variant="footnote" tone="faint">
          {t("newAgent.name")}
        </Text>
        <TextInput
          value={name}
          onChangeText={changeName}
          maxLength={32}
          autoCorrect={false}
          placeholder={t("newAgent.namePlaceholder")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("newAgent.name")}
          style={input}
        />
        {tried && !name.trim() ? <ErrorLine text={t("newAgent.errors.nameRequired")} /> : null}
        <Text variant="footnote" tone="faint" style={styles.gapTop}>
          {t("newAgent.handle")}
        </Text>
        <View style={[styles.affix, { backgroundColor: c.raised, borderColor: c.line }]}>
          <Text variant="body" tone="faint">
            @
          </Text>
          <TextInput
            value={handle}
            onChangeText={(v) => {
              setHandleTouched(true);
              setHandle(cleanHandle(v));
            }}
            maxLength={32}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("newAgent.handlePlaceholder")}
            placeholderTextColor={c.faint}
            accessibilityLabel={t("newAgent.handle")}
            style={[styles.affixInput, fieldText("body"), { color: c.ink }]}
          />
        </View>
        {handleIssue ? (
          <ErrorLine text={handleText} />
        ) : (
          <Text variant="footnote" tone="faint">
            {handleText}
          </Text>
        )}
        <View style={styles.section}>
          <Text variant="title" accessibilityRole="header">
            {t("newAgent.look")}
          </Text>
          <LookPicker look={look} onChange={setLook} />
        </View>
      </>
    ),
    instructions: () => (
      <>
        {head(t("newAgent.steps.instructions.title", g), t("newAgent.steps.instructions.lead"))}
        <TextArea
          value={instructions}
          onChangeText={setInstructions}
          placeholder={t("newAgent.instructionsPlaceholder")}
          accessibilityLabel={t("newAgent.instructions")}
          minHeight={220}
          scrollEnabled={false}
        />
        {role && role !== "custom" && instructions !== t(`newAgent.roles.${role}.instructions`) ? (
          <View style={styles.restore}>
            <Text variant="footnote" tone="faint" style={styles.fill}>
              {t("newAgent.startedFrom", { role: t(`newAgent.roles.${role}.name`) })}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("newAgent.restore")}
              onPress={() => setInstructions(t(`newAgent.roles.${role}.instructions`))}
            />
          </View>
        ) : null}
        {!instructions.trim() ? (
          <Text variant="footnote" tone="faint">
            {t("newAgent.noInstructions", g)}
          </Text>
        ) : null}
      </>
    ),
    review: () => (
      <>
        {head(t("newAgent.steps.review.title", g), t("newAgent.hints.review"))}
        <Card>
          <Row
            leading={<AgentAvatar agent={look} size={44} name={shownName} />}
            title={shownName}
            subtitle={`@${handle}`}
            chevron
            onPress={() => goTo(1)}
          />
          <Row
            title={t("newAgent.steps.role.name")}
            meta={
              <Text variant="small" tone="muted">
                {role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : t("newAgent.roles.custom.name")}
              </Text>
            }
            chevron
            onPress={() => goTo(0)}
          />
          <Row
            title={t("newAgent.instructions")}
            subtitle={instructions.trim().split("\n")[0] || t("newAgent.onlyContext")}
            chevron
            onPress={() => goTo(2)}
          />
        </Card>

        <View style={styles.section}>
          <Text variant="title" accessibilityRole="header">
            {t("newAgent.preview.uses")}
          </Text>
          {granted.length > 0 ? (
            <Card>
              {granted.map((i) => (
                <Row
                  key={i.id}
                  leading={<ConnectorIcon def={i.def} image={i.image} label={itemName(t, i)} size={32} />}
                  title={itemName(t, i)}
                  meta={
                    <Text variant="small" tone="muted">
                      {t(`mobile.intentAgents.uses.level.${levels[i.id] === "write" ? "write" : "read"}`)}
                    </Text>
                  }
                />
              ))}
            </Card>
          ) : (
            <Text variant="footnote" tone="faint">
              {t("newAgent.preview.onlyTalks")}
            </Text>
          )}
          <Text variant="footnote" tone="faint">
            {t("newAgent.approvalsNote")}
          </Text>
        </View>

        <View style={styles.section}>
          <Text variant="title" accessibilityRole="header">
            {t("newAgent.channels")}
          </Text>
          {myChannels.length > 0 ? (
            <Card>
              {myChannels.map((ch) => (
                <Toggle
                  key={ch.id}
                  label={`#${ch.name}`}
                  value={channelIds.has(ch.id)}
                  onChange={(on) =>
                    setChannelIds((prev) => {
                      const nextSet = new Set(prev);
                      if (on) nextSet.add(ch.id);
                      else nextSet.delete(ch.id);
                      return nextSet;
                    })
                  }
                />
              ))}
            </Card>
          ) : null}
          <Text variant="footnote" tone="faint">
            {myChannels.length > 0 ? t("newAgent.channelsHelp") : t("newAgent.noChannels")}
          </Text>
        </View>
      </>
    ),
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={t("newAgent.title")}
        subtitle={t("newAgent.stepOf", { n: index + 1, total })}
        solid={false}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          <Steps index={index} total={total} />
          {views[step]()}
        </ScrollView>
        <View style={[styles.footer, { borderTopColor: c.line, paddingBottom: Math.max(insets.bottom, 12) }]}>
          {index > 0 ? <Button variant="secondary" label={t("common.back")} onPress={() => goTo(index - 1)} /> : null}
          {step !== "role" || role ? (
            <View style={styles.fill}>
              <Button
                variant="primary"
                wide
                label={
                  index === total - 1 ? t("newAgent.create", { name: name.trim() || shownName }) : t("common.continue")
                }
                disabled={busy}
                onPress={next}
              />
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Where the person is, as dots (the web's step rail, small). */
function Steps({ index, total }: { index: number; total: number }) {
  const c = useColors();
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: one dot per step, in order
          key={i}
          style={[styles.dot, { backgroundColor: i <= index ? c.ink : c.line2 }, i === index && styles.dotOn]}
        />
      ))}
    </View>
  );
}

function RoleCard({
  on,
  onPress,
  leading,
  title,
  caption,
  desc,
}: {
  on: boolean;
  onPress: () => void;
  leading: ReactNode;
  title: string;
  caption?: string;
  desc: string;
}) {
  const c = useColors();
  const surface = useSurface();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={[title, caption, desc].filter(Boolean).join(". ")}
      style={({ pressed }) => [
        styles.role,
        surface,
        { borderColor: on ? c.ink : "transparent" },
        pressed && styles.pressed,
      ]}
    >
      {leading}
      <View style={styles.fill}>
        <Text variant="body" style={styles.bold}>
          {title}
        </Text>
        {caption ? (
          <Text variant="footnote" tone="muted">
            {caption}
          </Text>
        ) : null}
        <Text variant="footnote" tone="ink2" style={styles.desc}>
          {desc}
        </Text>
      </View>
      {on ? <Icon name="checkc" size={22} color={c.ink} /> : null}
    </Pressable>
  );
}

function ErrorLine({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text variant="footnote" style={{ color: c.danger }} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 18, paddingBottom: 32, gap: 8 },
  head: { gap: 6, marginBottom: 10 },
  group: { gap: 8, marginTop: 8 },
  groupTitle: { marginTop: 6 },
  role: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 20,
    borderWidth: 2,
  },
  blank: {
    width: 48,
    height: 48,
    borderRadius: 15,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  bold: { fontWeight: "600" },
  desc: { marginTop: 2 },
  pressed: { transform: [{ scale: 0.98 }] },
  hero: { alignItems: "center", paddingVertical: 8 },
  input: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  affix: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
  },
  affixInput: { flex: 1, paddingVertical: 12 },
  gapTop: { marginTop: 10 },
  section: { marginTop: 22, gap: 10 },
  restore: { flexDirection: "row", alignItems: "center", gap: 10 },
  footer: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: "row", gap: 6, marginBottom: 14, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOn: { width: 18 },
});
