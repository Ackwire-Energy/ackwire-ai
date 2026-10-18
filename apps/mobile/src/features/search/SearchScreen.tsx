import { useChannels, useDms, useSearch } from "@agenteschat/client";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, SearchField, Text } from "@/ui";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { ActionList, goBack, Tile } from "../shared/parts";
import { isEmpty, type SearchAction, searchResults } from "./logic";

const ACTION_ICON = { newConversation: "plus", newTask: "target", newAgent: "agent" } as const;

/** Busca, the phone's ⌘K: actions, agents, conversations and messages, in a native modal. */
export function SearchScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const hits = useSearch(orgId, q, ["message"]);
  const labels: Record<SearchAction, string> = {
    newConversation: t("mobile.find.action.newConversation"),
    newTask: t("mobile.find.action.newTask"),
    newAgent: t("mobile.find.action.newAgent"),
  };
  const r = searchResults(q, {
    actionLabels: labels,
    agents: dir.agents,
    channels: (channels.data ?? []).filter((x) => x.isMember),
    dms: dms.data ?? [],
    hits: hits.data ?? [],
  });
  const go = (href: Parameters<typeof router.push>[0]) => {
    router.back();
    setTimeout(() => router.push(href), 50);
  };
  const runAction = (a: SearchAction) => {
    if (a === "newConversation") go("/chats?new=1");
    else if (a === "newAgent") go("/agents?new=1");
    else go("/agents");
  };
  const channelName = (id: string) => channels.data?.find((x) => x.id === id)?.name;

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      {/* A native modal: a page sheet on iOS (drag down to close), full screen on Android. */}
      <View style={[styles.box, { paddingTop: Platform.OS === "ios" ? 16 : insets.top + 8 }]}>
        <View style={styles.grow}>
          <SearchField value={q} onChangeText={setQ} placeholder={t("mobile.find.placeholder")} autoFocus />
        </View>
        <Button variant="ghost" size="sm" label={t("mobile.common.cancel")} onPress={goBack} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.res, { paddingBottom: insets.bottom + 24 }]}
      >
        {r.actions.length > 0 ? (
          <Group title={t("mobile.find.actions")}>
            <ActionList
              items={r.actions.map((a) => ({
                key: a,
                icon: ACTION_ICON[a],
                label: labels[a],
                onPress: () => runAction(a),
              }))}
            />
          </Group>
        ) : null}
        {r.agents.length > 0 ? (
          <Group title={t("mobile.find.agents")}>
            <ActionList
              items={r.agents.map((a) => ({
                key: a.id,
                leading: <AgentFace agentId={a.id} size={28} live={false} />,
                label: a.name,
                ...(a.role ? { hint: a.role } : {}),
                onPress: () => go(`/agent/${a.id}`),
              }))}
            />
          </Group>
        ) : null}
        {r.channels.length + r.dms.length > 0 ? (
          <Group title={t("mobile.find.conversations")}>
            <ActionList
              items={[
                ...r.dms.map((d) => ({
                  key: d.channelId,
                  leading: <Face who={{ type: d.with.type, id: d.with.id }} size={28} live={false} />,
                  label: d.with.name,
                  ...(d.lastMessage ? { hint: previewOf(d.lastMessage.body) } : {}),
                  onPress: () => go(chatHref(d.channelId)),
                })),
                ...r.channels.map((ch) => ({
                  key: ch.id,
                  leading: <Tile icon="hash" size={28} />,
                  label: `#${ch.name}`,
                  ...(ch.topic ? { hint: ch.topic } : {}),
                  onPress: () => go(chatHref(ch.id)),
                })),
              ]}
            />
          </Group>
        ) : null}
        {r.messages.length > 0 ? (
          <Group title={t("mobile.find.messages")}>
            <ActionList
              items={r.messages.map((h) => {
                const channelId = h.channelIds[0] ?? "";
                const where = channelName(channelId);
                return {
                  key: h.sourceId,
                  icon: "chat" as const,
                  label: previewOf(h.snippet || h.title),
                  hint: [where ? `#${where}` : null, when.short(h.createdAt)].filter(Boolean).join(" · "),
                  onPress: () => go(chatHref(channelId)),
                };
              })}
            />
          </Group>
        ) : null}
        {q.trim() && isEmpty(r) && !hits.isFetching ? (
          <Text tone="faint" style={styles.empty}>
            {t("mobile.find.nothing", { q: q.trim() })}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <Text variant="label" tone="faint" style={styles.groupTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  box: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  grow: { flex: 1 },
  res: { paddingHorizontal: 16, paddingTop: 6 },
  group: { marginTop: 14, gap: 8 },
  groupTitle: { paddingHorizontal: 4 },
  empty: { textAlign: "center", paddingVertical: 40 },
});
