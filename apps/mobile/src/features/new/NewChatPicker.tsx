import { useMe } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { Icon, SearchField, SheetScreen, Text } from "@/ui";
import { matches } from "../search/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { ActionList } from "../shared/parts";
import { SheetHeader } from "./parts";
import { useOpenDm } from "./useOpenDm";

/** "Conversa com…": an agent or a person; tapping opens the direct conversation. */
export function NewChatPicker() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const me = useMe();
  const c = useColors();
  const openDm = useOpenDm();
  const [q, setQ] = useState("");
  const agents = dir.agents
    .filter((a) => a.canTalk !== false && matches(q, a.name, a.role, a.handle))
    .sort((a, b) => a.name.localeCompare(b.name));
  const people = [...dir.memberById.values()]
    .filter((m) => m.userId !== me.data?.user.id && matches(q, m.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chevron = <Icon name="right" size={16} color={c.faint} />;
  return (
    <SheetScreen>
      <SheetHeader title={t("mobile.new.chat")} icon="back" />
      <SearchField value={q} onChangeText={setQ} placeholder={t("mobile.new.chatSearch")} autoCorrect={false} />
      {agents.length > 0 ? (
        <>
          <Text variant="label" style={styles.sec}>
            {t("mobile.find.agents")}
          </Text>
          <ActionList
            items={agents.map((a) => ({
              key: a.id,
              leading: <AgentFace agentId={a.id} size={38} live={false} presence ring={c.raised} />,
              label: a.name,
              ...(a.role ? { hint: a.role } : {}),
              trailing: chevron,
              onPress: () => void openDm({ agentId: a.id }),
            }))}
          />
        </>
      ) : null}
      {people.length > 0 ? (
        <>
          <Text variant="label" style={styles.sec}>
            {t("mobile.new.people")}
          </Text>
          <ActionList
            items={people.map((p) => ({
              key: p.userId,
              leading: <Face who={{ type: "person", id: p.userId }} size={38} presence ring={c.raised} />,
              label: p.name,
              trailing: chevron,
              onPress: () => void openDm({ userId: p.userId }),
            }))}
          />
        </>
      ) : null}
      {agents.length + people.length === 0 && !dir.loading ? (
        <Text tone="faint" style={styles.empty}>
          {q.trim() ? t("mobile.find.nothing", { q: q.trim() }) : t("mobile.new.nobody")}
        </Text>
      ) : null}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  sec: { paddingHorizontal: 4, paddingTop: 10 },
  empty: { textAlign: "center", paddingVertical: 30 },
});
