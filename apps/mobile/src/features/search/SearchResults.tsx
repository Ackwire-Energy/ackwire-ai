import { useApi, useChannels, useDms, useSearch } from "@agenteschat/client";
import { hitText } from "@agenteschat/client/lib/media";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Count, Filters, Text, useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { ActionList, Tile } from "../shared/parts";
import {
  filterResults,
  isEmpty,
  SEARCH_KINDS,
  type SearchAction,
  type SearchFilter,
  searchCounts,
  searchResults,
} from "./logic";

const ACTION_ICON = { newConversation: "compose", newTask: "target", newAgent: "agent" } as const;

/**
 * Busca, under the field of the search tab (the phone's ⌘K): the actions with no words, then the
 * results grouped (Conversas, Ações do time, Mensagens, Arquivos) with a chip per group and its count.
 */
export function SearchResults({ q }: { q: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const dir = useDirectory();
  const when = useWhen();
  const toast = useToast();
  const createsAgents = can(useOrg().org, "create_agents");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const hits = useSearch(orgId, q, SEARCH_KINDS);
  const labels: Record<SearchAction, string> = {
    newConversation: t("mobile.find.action.newConversation"),
    newTask: t("mobile.find.action.newTask"),
    newAgent: t("mobile.find.action.newAgent"),
  };
  const found = searchResults(q, {
    actionLabels: labels,
    agents: dir.agents,
    channels: (channels.data ?? []).filter((x) => x.isMember),
    dms: dms.data ?? [],
    hits: hits.data ?? [],
  });
  // "Novo agente" only for who may create one (ADR 0085).
  const all = createsAgents ? found : { ...found, actions: found.actions.filter((a) => a !== "newAgent") };
  const counts = searchCounts(all);
  const r = filterResults(all, filter);
  const runAction = (a: SearchAction) => {
    if (a === "newConversation") router.push("/new-chat");
    else if (a === "newAgent") router.push("/new-agent");
    else router.navigate("/agents");
  };
  const channelName = (id: string | undefined) => (id ? channels.data?.find((x) => x.id === id)?.name : undefined);
  const openFile = (id: string) =>
    api.artifacts
      .download(orgId, id)
      .then(({ url }) => Linking.openURL(url))
      .catch(() => toast({ title: t("mobile.chat.fileFailed"), icon: "x" }));
  const words = Boolean(q.trim());

  return (
    <View>
      {words ? (
        <Filters
          items={[
            { key: "all", label: t("mobile.find.filter.all"), count: counts.all },
            { key: "chats", label: t("mobile.find.conversations"), count: counts.chats },
            { key: "team", label: t("searchPage.kinds.action"), count: counts.team },
            { key: "messages", label: t("mobile.find.messages"), count: counts.messages },
            { key: "files", label: t("mobile.find.files"), count: counts.files },
          ]}
          value={filter}
          onChange={(key) => setFilter(key as SearchFilter)}
        />
      ) : null}
      <View style={styles.res}>
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
        {words && r.agents.length + r.channels.length + r.dms.length > 0 ? (
          <Group title={t("mobile.find.conversations")} count={r.agents.length + r.channels.length + r.dms.length}>
            <ActionList
              items={[
                ...r.agents.map((a) => ({
                  key: `a:${a.id}`,
                  leading: <AgentFace agentId={a.id} size={38} live={false} />,
                  label: a.name,
                  ...(a.role ? { hint: a.role } : {}),
                  onPress: () => router.push(`/agent/${a.id}`),
                })),
                ...r.dms.map((d) => ({
                  key: `d:${d.channelId}`,
                  leading: <Face who={{ type: d.with.type, id: d.with.id }} size={38} live={false} />,
                  label: d.with.name,
                  ...(d.lastMessage
                    ? {
                        hint: previewBody(
                          t,
                          previewOf(d.lastMessage.body),
                          d.lastMessage.meta ?? null,
                          d.lastMessage.mediaKind,
                        ),
                      }
                    : {}),
                  onPress: () => router.push(chatHref(d.channelId)),
                })),
                ...r.channels.map((ch) => ({
                  key: `c:${ch.id}`,
                  leading: <Tile icon="hash" size={38} />,
                  label: ch.name,
                  ...(ch.topic ? { hint: ch.topic } : {}),
                  onPress: () => router.push(chatHref(ch.id)),
                })),
              ]}
            />
          </Group>
        ) : null}
        {r.team.length > 0 ? (
          <Group title={t("searchPage.kinds.action")} count={r.team.length}>
            <ActionList
              items={r.team.map((h) => {
                const channelId = h.channelIds[0] ?? "";
                const where = channelName(channelId);
                return {
                  key: h.sourceId,
                  leading: h.author ? (
                    <AgentFace agentId={h.author.id} size={34} live={false} />
                  ) : (
                    <Tile icon="reply" size={34} />
                  ),
                  label: previewOf(h.snippet || h.title),
                  hint: [
                    h.author?.name,
                    where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null,
                    when.short(h.createdAt),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  onPress: () => router.push(chatHref(channelId)),
                };
              })}
            />
          </Group>
        ) : null}
        {r.messages.length > 0 ? (
          <Group title={t("mobile.find.messages")} count={r.messages.length}>
            <ActionList
              items={r.messages.map((h) => {
                const channelId = h.channelIds[0] ?? "";
                const where = channelName(channelId);
                return {
                  key: h.sourceId,
                  leading: <Tile icon="chat" size={34} />,
                  label: previewOf(hitText(t, h) || h.title),
                  hint: [where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null, when.short(h.createdAt)]
                    .filter(Boolean)
                    .join(" · "),
                  onPress: () => router.push(chatHref(channelId)),
                };
              })}
            />
          </Group>
        ) : null}
        {r.files.length > 0 ? (
          <Group title={t("mobile.find.files")} count={r.files.length}>
            <ActionList
              items={r.files.map((h) => {
                const where = channelName(h.channelIds[0]);
                return {
                  key: h.sourceId,
                  leading: <Tile icon="doc" size={34} />,
                  label: h.title || t("mobile.chat.file"),
                  hint: [where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null, when.short(h.createdAt)]
                    .filter(Boolean)
                    .join(" · "),
                  onPress: () => void openFile(h.sourceId),
                };
              })}
            />
          </Group>
        ) : null}
        {words && isEmpty(r) && !hits.isFetching ? (
          <Text tone="faint" style={styles.empty}>
            {t("mobile.find.nothing", { q: q.trim() })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <View style={styles.groupTitle}>
        <Text variant="label" accessibilityRole="header">
          {title}
        </Text>
        {count !== undefined ? <Count value={count} size={14} /> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  res: { paddingHorizontal: 16, paddingTop: 2 },
  group: { marginTop: 14, gap: 8 },
  groupTitle: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  empty: { textAlign: "center", paddingVertical: 40 },
});
