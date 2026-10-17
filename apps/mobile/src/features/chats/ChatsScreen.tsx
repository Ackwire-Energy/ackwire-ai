import { keys, useApi, useMe } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Card, EmptyState, Filters, IconButton, LargeTitleScreen, SearchField, Text, useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { PromptForm, SheetTitle } from "../shared/PromptForm";
import { ActionList, Tile } from "../shared/parts";
import { useConversations } from "../shared/queries";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { ConversationRowView } from "./ConversationRowView";
import { type ChatFilter, filterConversations, filterCounts } from "./logic";

/** Conversas: everything you talk in, with filters; "+" starts a conversation. */
export function ChatsScreen() {
  return (
    <SheetHostProvider>
      <Chats />
    </SheetHostProvider>
  );
}

function Chats() {
  const { t } = useTranslation();
  const sheet = useSheet();
  const list = useConversations();
  const [filter, setFilter] = useState<ChatFilter>("all");
  // Busca → "Nova conversa" opens this screen with `?new=1`.
  const params = useLocalSearchParams<{ new?: string }>();
  useEffect(() => {
    if (!params.new) return;
    sheet.open(<NewConversation />);
    router.setParams({ new: undefined });
  }, [params.new, sheet]);
  const counts = filterCounts(list.rows);
  const rows = filterConversations(list.rows, filter);
  return (
    <LargeTitleScreen
      title={t("mobile.chats.title")}
      headerRight={
        <IconButton icon="plus" label={t("mobile.chats.new")} onPress={() => sheet.open(<NewConversation />)} />
      }
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={() => void list.refetch()} />}
    >
      <Pressable
        onPress={() => router.push("/search")}
        accessibilityRole="search"
        accessibilityLabel={t("mobile.find.title")}
        style={styles.search}
      >
        <View pointerEvents="none">
          <SearchField value="" onChangeText={ignore} editable={false} placeholder={t("mobile.find.short")} />
        </View>
      </Pressable>
      <Filters
        items={[
          { key: "all", label: t("mobile.chats.filter.all") },
          { key: "unread", label: t("mobile.chats.filter.unread"), count: counts.unread },
          { key: "threads", label: t("mobile.chats.filter.threads") },
          { key: "dm", label: t("mobile.chats.filter.dm") },
        ]}
        value={filter}
        onChange={(key) => setFilter(key as ChatFilter)}
      />
      <View style={styles.list}>
        {list.loading ? (
          <Text tone="faint" style={styles.center}>
            {t("mobile.common.loading")}
          </Text>
        ) : rows.length === 0 ? (
          <EmptyState title={filter === "unread" ? t("mobile.chats.allRead") : t("mobile.chats.empty")} />
        ) : (
          <Card>
            {rows.map((r, i) => (
              <ConversationRowView key={r.key} row={r} divider={i > 0} />
            ))}
          </Card>
        )}
      </View>
    </LargeTitleScreen>
  );
}

/** The field here only opens Busca. */
const ignore = () => undefined;

/** "Nova conversa": an agent, a person, or a new channel. */
export function NewConversation() {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const dir = useDirectory();
  const me = useMe();
  const toast = useToast();
  const sheet = useSheet();
  const open = (target: { agentId: string } | { userId: string }) =>
    api.dms
      .open(orgId, target)
      .then(({ channelId }) => {
        sheet.close();
        void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
        router.push(chatHref(channelId));
      })
      .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }));
  const people = [...dir.memberById.values()].filter((m) => m.userId !== me.data?.user.id);
  const agents = dir.agents.filter((a) => a.canTalk !== false);
  return (
    <>
      <SheetTitle title={t("mobile.chats.new")} />
      {agents.length > 0 ? (
        <ActionList
          items={agents.map((a) => ({
            key: a.id,
            leading: <AgentFace agentId={a.id} size={28} live={false} />,
            label: a.name,
            ...(a.role ? { hint: a.role } : {}),
            onPress: () => void open({ agentId: a.id }),
          }))}
        />
      ) : null}
      {people.length > 0 ? (
        <ActionList
          items={people.map((p) => ({
            key: p.userId,
            leading: <Face who={{ type: "person", id: p.userId }} size={28} />,
            label: p.name,
            onPress: () => void open({ userId: p.userId }),
          }))}
        />
      ) : null}
      <ActionList
        items={[
          {
            key: "channel",
            leading: <Tile icon="hash" size={28} />,
            label: t("mobile.chats.newChannel"),
            hint: t("mobile.chats.newChannelHint"),
            onPress: () =>
              sheet.open(
                <PromptForm
                  leading={<Tile icon="hash" />}
                  title={t("mobile.chats.newChannel")}
                  placeholder={t("mobile.chats.channelPlaceholder")}
                  submitLabel={t("mobile.chats.createChannel")}
                  onSubmit={(name) =>
                    api.chat
                      .createChannel(orgId, { name: name.replace(/^#/, "") })
                      .then((ch) => {
                        sheet.close();
                        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
                        router.push(chatHref(ch.id));
                      })
                      .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }))
                  }
                />,
              ),
          },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  search: { marginHorizontal: 16, marginBottom: 12 },
  list: { paddingHorizontal: 16, marginTop: 12 },
  center: { textAlign: "center", paddingVertical: 40 },
});
