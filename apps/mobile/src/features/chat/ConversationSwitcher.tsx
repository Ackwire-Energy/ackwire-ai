import { previewBody } from "@agenteschat/client/lib/message-body";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { Card, Count, Icon, Row, SearchField, Text } from "@/ui";
import { type ConversationRow, rowName } from "../chats/logic";
import { matches } from "../search/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { Tile } from "../shared/parts";
import { useConversations } from "../shared/queries";

type Conversation = Extract<ConversationRow, { kind: "dm" | "channel" }>;

/**
 * "Trocar de conversa", the sheet that holding the conversation's pill opens: every DM and channel, newest first
 * within Agentes, Canais and Pessoas, with a search on top. The current one has a check; the others their unread
 * count. A tap picks (`onPick`); the screen swaps the conversation in place.
 */
export function ConversationSwitcher({
  channelId,
  onPick,
}: {
  channelId: string;
  onPick: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const { rows } = useConversations();
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const shown = rows.filter(
      (r): r is Conversation =>
        (r.kind === "dm" || r.kind === "channel") &&
        matches(q, rowName(r), r.kind === "dm" && r.with.type === "agent" ? dir.agentById.get(r.with.id)?.role : null),
    );
    const agent = (r: Conversation) => r.kind === "dm" && r.with.type === "agent";
    return [
      { key: "agents", label: t("mobile.chat.switchAgents"), rows: shown.filter(agent) },
      { key: "channels", label: t("mobile.chat.switchChannels"), rows: shown.filter((r) => r.kind === "channel") },
      { key: "people", label: t("mobile.chat.switchPeople"), rows: shown.filter((r) => r.kind === "dm" && !agent(r)) },
    ].filter((g) => g.rows.length > 0);
  }, [rows, q, dir.agentById, t]);

  const leading = (r: Conversation) =>
    r.kind === "channel" ? (
      <Tile icon="hash" size={34} />
    ) : r.with.type === "agent" ? (
      <AgentFace agentId={r.with.id} size={34} mode={r.working ? "run" : "idle"} live={false} />
    ) : (
      <Face who={{ type: r.with.type, id: r.with.id }} size={34} live={false} />
    );
  const subtitle = (r: Conversation): string | undefined => {
    if (r.kind === "dm" && r.working) return t("mobile.chat.switchWorking");
    // A GIF or a sticker with no text says which (ADR 0091).
    if (r.last?.text || r.last?.mediaKind) return previewBody(t, r.last.text, r.last.meta ?? null, r.last.mediaKind);
    return r.kind === "dm" && r.with.type === "agent" ? (dir.agentById.get(r.with.id)?.role ?? undefined) : undefined;
  };

  return (
    <>
      <SheetTitle title={t("mobile.chat.switchTitle")} />
      <SearchField value={q} onChangeText={setQ} placeholder={t("mobile.chat.switchSearch")} autoCorrect={false} />
      {groups.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {t("mobile.chat.switchNone")}
        </Text>
      ) : (
        groups.map((g) => (
          <Card key={g.key} style={styles.group}>
            <Text variant="label" style={styles.sec}>
              {g.label}
            </Text>
            {g.rows.map((r) => {
              const sub = subtitle(r);
              const current = r.channelId === channelId;
              return (
                <Row
                  key={r.key}
                  leading={leading(r)}
                  title={rowName(r)}
                  {...(sub ? { subtitle: sub } : {})}
                  meta={
                    current ? (
                      <Icon name="check" size={18} color={c.muted} />
                    ) : r.unread > 0 ? (
                      <Count value={r.unread} max={99} inverted />
                    ) : undefined
                  }
                  onPress={() => onPick(r.channelId)}
                />
              );
            })}
          </Card>
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 8 },
  group: { marginTop: 10 },
  sec: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 2 },
});
