import { type Memory, useMemoryAction, useOrgMemories } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { router } from "expo-router";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  EmptyState,
  Filters,
  Row,
  SearchField,
  SectionHeader,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { MemoryFix } from "../agents/AgentProfileScreen";
import { canEditMemories } from "../agents/logic";
import { useMemoryOriginText } from "../agents/useMemoryOriginText";
import { StarCard, StarStrip } from "../constellation/Constellation";
import { aroundStar, memoryMap } from "../constellation/logic";
import { useFailed } from "../routines/hooks";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { agentFilters, inAgent, justLearned, mostUsed, searchMemories } from "./logic";

const openMemory = (id: string) => router.push(`/memory/${id}`);

/**
 * Memória, pushed from Você: what the agents learned as a sky (each agent with its memories; pages live in the wiki's
 * own map), the search, a filter per agent, what they learned last and what they use most.
 */
export function MemoryScreen({ agent: initialAgent }: { agent?: string } = {}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const memories = useOrgMemories(orgId);
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState(initialAgent || "all");
  const [picked, setPicked] = useState<string | null>(null);
  const search = useDeferredValue(q.trim());
  const shown = useMemo(() => inAgent(memories.data ?? [], agent), [memories.data, agent]);
  const map = useMemo(() => memoryMap(shown, dir.agents), [shown, dir.agents]);
  const selected = map.stars.find((s) => s.id === picked) ?? map.stars.find((s) => s.kind === "memory") ?? null;
  // The sky and the search's results cross-fade as a search starts and ends, and fade in when they load.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const when = (iso: string) => relativeTime(t, i18n.language, iso);
  const row = (m: Memory, i: number) => (
    <Row
      key={m.id}
      divider={i > 0}
      leading={<Face who={{ type: "agent", id: m.agentId }} size={36} live={false} />}
      title={m.summary ?? m.text}
      subtitle={`${dir.nameOf({ type: "agent", id: m.agentId })} · ${when(m.updatedAt)}`}
      chevron
      onPress={() => openMemory(m.id)}
    />
  );
  const found = search ? searchMemories(shown, search) : [];
  const subtitle = !selected
    ? ""
    : selected.kind === "agent"
      ? t("mobile.memory.agentLine", { count: shown.filter((m) => m.agentId === selected.id).length })
      : t("mobile.memory.line", {
          name: dir.nameOf({ type: "agent", id: selected.agentId ?? null }),
          count: selected.weight,
        });
  return (
    <PushedLargeTitle title={t("mobile.memory.title")}>
      <Text variant="subhead" tone="muted" style={styles.lead}>
        {t("mobile.memory.subtitle")}
      </Text>
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.memory.search")}
          accessibilityLabel={t("mobile.memory.search")}
          returnKeyType="search"
        />
      </View>
      {memories.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {memories.isError && !memories.data ? (
        <View style={styles.center}>
          <Text tone="muted">{t("common.loadFailed")}</Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.common.retry")}
            onPress={() => void memories.refetch()}
          />
        </View>
      ) : null}
      {memories.isSuccess && (memories.data ?? []).length === 0 ? (
        <EmptyState icon="brain" title={t("mobile.memory.emptyTitle")} subtitle={t("mobile.memory.empty")} />
      ) : null}
      {(memories.data ?? []).length > 0 ? (
        <Filters
          items={agentFilters(memories.data ?? [], dir.agents, t("mobile.memory.all"))}
          value={agent}
          onChange={(k) => {
            setAgent(k);
            setPicked(null);
          }}
        />
      ) : null}
      {search ? (
        <Animated.View key="found" {...fade}>
          {found.length === 0 ? <EmptyState icon="search" title={t("mobile.memory.noMatch")} /> : found.map(row)}
        </Animated.View>
      ) : selected ? (
        <Animated.View key="sky" {...fade}>
          <StarCard
            label={t("mobile.memory.sky")}
            count={shown.length}
            map={map}
            selected={selected.id}
            onSelect={setPicked}
            title={selected.title}
            subtitle={subtitle}
            onOpen={() => (selected.kind === "agent" ? router.push(`/agent/${selected.id}`) : openMemory(selected.id))}
          />
          <SectionHeader title={t("mobile.memory.recent")} />
          {justLearned(shown).map(row)}
          <SectionHeader title={t("mobile.memory.mostUsed")} />
          {mostUsed(shown).map(row)}
        </Animated.View>
      ) : null}
    </PushedLargeTitle>
  );
}

/** One memory, with its small sky. */
export function MemoryDetailScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <MemoryDetail id={id} />
    </SheetHostProvider>
  );
}

function MemoryDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useMeId();
  const { org } = useOrg();
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const failed = useFailed();
  const sheet = useSheet();
  const originText = useMemoryOriginText();
  const memories = useOrgMemories(orgId);
  const m = memories.data?.find((x) => x.id === id);
  const agentId = m?.agentId ?? "";
  const action = useMemoryAction(orgId, agentId);
  const reduced = useReducedMotion();
  const agent = dir.anyAgent(agentId);
  const name = dir.nameOf({ type: "agent", id: agentId });
  const editable = canEditMemories(agent, { id: meId, org });
  const [details, setDetails] = useState(false);
  const around = useMemo(
    () => aroundStar(memoryMap(memories.data ?? [], dir.agents), agentId),
    [memories.data, dir.agents, agentId],
  );
  if (!m) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader solid={false} />
        {memories.isLoading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : (
          <EmptyState icon="brain" title={t("mobile.memory.gone")} />
        )}
      </View>
    );
  }
  const forget = () =>
    Alert.alert(t("mobile.memory.forgetTitle"), t("mobile.memory.forgetText", { name }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.intentAgents.fix.forget"),
        style: "destructive",
        onPress: () =>
          action.mutate(
            { type: "archive", id: m.id, archived: true },
            {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId });
                goBack();
              },
              onError: failed,
            },
          ),
      },
    ]);
  const fix = () =>
    sheet.open(
      <MemoryFix
        memory={m}
        agentId={agentId}
        agentName={name}
        g={genderOf(name)}
        source={originText(m)}
        onSee={undefined}
        onDone={sheet.close}
      />,
    );
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <StarStrip map={around} selected={m.id} />
        <View style={styles.body}>
          <View style={styles.who}>
            <Face who={{ type: "agent", id: agentId }} size={20} />
            <Text variant="subhead" tone="faint">
              {t("mobile.memory.of", { name })}
            </Text>
          </View>
          <Text variant="title2" accessibilityRole="header">
            {m.summary ?? m.text}
          </Text>
          {m.summary ? (
            <Pressable
              onPress={() => setDetails((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: details }}
              hitSlop={12}
              style={({ pressed }) => [styles.details, pressed && styles.pressed]}
            >
              <Text variant="subhead" tone="ink2" style={styles.bold}>
                {t("mobile.memory.details")}
              </Text>
              {details ? (
                <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
                  <Text variant="subhead" tone="muted" selectable>
                    {m.text}
                  </Text>
                </Animated.View>
              ) : null}
            </Pressable>
          ) : null}
          <View style={styles.chips}>
            <Chip
              icon={m.verified ? "check" : "sparkle"}
              label={t(m.verified ? "mobile.memory.confirmed" : "mobile.memory.unconfirmed")}
            />
            <Chip icon="clock" label={t("mobile.memory.uses", { count: m.uses })} />
          </View>
          <Text variant="subhead" tone="muted">
            {originText(m)}
          </Text>
          {m.supersedes ? (
            <View style={[styles.before, { backgroundColor: c.sunken }]}>
              <Text variant="subhead" tone="muted">
                {t("mobile.memory.before", { text: m.supersedes })}
              </Text>
            </View>
          ) : null}
        </View>
        {editable ? (
          <View style={styles.actions}>
            <Button variant="secondary" wide icon="pen" label={t("mobile.memory.fix")} onPress={fix} />
            <Button
              variant="ghost"
              wide
              label={t("mobile.intentAgents.fix.forget")}
              disabled={action.isPending}
              onPress={forget}
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  lead: { paddingHorizontal: 20, marginTop: -4 },
  search: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  loading: { marginVertical: 24 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  body: { paddingHorizontal: 20, paddingTop: 14, gap: 10 },
  who: { flexDirection: "row", alignItems: "center", gap: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  before: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  actions: { paddingHorizontal: 20, paddingTop: 20, gap: 8 },
  details: { gap: 6 },
  pressed: { opacity: 0.6 },
  bold: { fontWeight: "600" },
});
