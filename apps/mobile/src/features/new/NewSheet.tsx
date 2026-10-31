import { useApi } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, SheetScreen, Text } from "@/ui";
import { busyAgents } from "../agents/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { ActionList, successHaptic, Tile, useSurface } from "../shared/parts";
import { useConversations, useWorkingNow } from "../shared/queries";
import { TextArea } from "../shared/TextArea";
import { askTargets, pickedTarget, requestBody } from "./logic";
import { SheetHeader } from "./parts";
import { useOpenDm } from "./useOpenDm";

/** "Criar agente" is a pushed screen of its own: "Novo" closes first, so it opens over the tabs. */
function openNewAgent() {
  if (router.canDismiss()) router.dismissAll();
  setTimeout(() => router.push("/new-agent"), 60);
}

/**
 * "Novo" (the "+" of the tabs): request first. "O que você precisa?",
 * for whom (the agent you talked to last comes picked; a tap changes it), and one button, "Pedir ao
 * Theo", that posts the request in that agent's conversation and opens it. Starting something new (an
 * agent, a channel, a conversation with a person) sits below, smaller.
 */
export function NewSheet() {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  // "Criar agente" only for who may create one (ADR 0085).
  const createsAgents = can(useOrg().org, "create_agents");
  const dir = useDirectory();
  const list = useConversations();
  const openDm = useOpenDm();
  const busyIds = busyAgents(useWorkingNow());
  const targets = useMemo(() => askTargets(dir.agents, list.rows), [dir.agents, list.rows]);
  const [text, setText] = useState("");
  const [tapped, setTapped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = pickedTarget(targets, tapped);
  const body = requestBody(text);

  const ask = async () => {
    if (!target || !body || busy) return;
    setBusy(true);
    try {
      await openDm({ agentId: target.id }, (channelId) =>
        api.chat.post(orgId, channelId, { body }).then(() => successHaptic()),
      );
    } finally {
      setBusy(false);
    }
  };

  const noAgents = !dir.loading && targets.length === 0;
  const startItems = [
    ...(noAgents || !createsAgents
      ? []
      : [
          {
            key: "agent",
            leading: <Tile icon="agent" size={32} />,
            label: t("mobile.agents.new"),
            onPress: () => openNewAgent(),
          },
        ]),
    {
      key: "channel",
      leading: <Tile icon="hash" size={32} />,
      label: t("mobile.chats.newChannel"),
      onPress: () => router.push("/new-channel"),
    },
    {
      key: "person",
      leading: <Tile icon="compose" size={32} />,
      label: t("mobile.new.ask.person"),
      onPress: () => router.push("/new-chat"),
    },
  ];

  return (
    <SheetScreen>
      <SheetHeader title={t("mobile.new.title")} />
      {noAgents ? (
        <>
          <Text variant="body" tone="muted" style={styles.lone}>
            {t("mobile.new.ask.noAgents")}
          </Text>
          {createsAgents ? (
            <Button variant="primary" wide icon="plus" label={t("mobile.agents.new")} onPress={() => openNewAgent()} />
          ) : null}
        </>
      ) : (
        <>
          <Text variant="display2" style={styles.question} accessibilityRole="header">
            {t("mobile.new.ask.question")}
          </Text>
          <TextArea
            value={text}
            onChangeText={setText}
            placeholder={t("mobile.new.ask.placeholder")}
            accessibilityLabel={t("mobile.new.ask.question")}
            minHeight={110}
            autoFocus
          />
          <Text variant="label" tone="faint" style={styles.label}>
            {t("mobile.new.ask.to")}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.whos}
            style={styles.whosOut}
          >
            {targets.map((a) => (
              <WhoChip
                key={a.id}
                agentId={a.id}
                name={a.name}
                role={a.role}
                working={busyIds.has(a.id)}
                picked={a.id === target?.id}
                onPress={() => setTapped(a.id)}
              />
            ))}
          </ScrollView>
          <Button
            variant="primary"
            wide
            label={
              target ? t(`mobile.new.ask.send${genderOf(target.name)}`, { name: target.name }) : t("mobile.app.send")
            }
            disabled={!target || !body || busy}
            onPress={() => void ask()}
          />
          <Text variant="label" tone="faint" style={[styles.label, styles.more]}>
            {t("mobile.new.ask.more")}
          </Text>
        </>
      )}
      <ActionList items={startItems} />
    </SheetScreen>
  );
}

/**
 * One agent a request can go to: its face in its own sky tile (as the "Esperando você" strip shows it), its name
 * and its role; picked, the chip turns dark.
 */
function WhoChip({
  agentId,
  name,
  role,
  working,
  picked,
  onPress,
}: {
  agentId: string;
  name: string;
  role: string;
  working: boolean;
  picked: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const surface = useSurface();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: picked }}
      accessibilityLabel={role ? `${name}, ${role}` : name}
      style={({ pressed }) => [styles.who, picked ? { backgroundColor: c.ink } : surface, pressed && styles.pressed]}
    >
      <AgentFace agentId={agentId} size={32} mode={working ? "run" : "idle"} live={picked} />
      <Text variant="subhead" style={[styles.bold, { color: picked ? c.bg : c.ink2 }]} numberOfLines={1}>
        {name}
      </Text>
      {role ? (
        <Text variant="footnote" style={[styles.role, { color: picked ? c.bg : c.faint }]} numberOfLines={1}>
          {role}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  question: { marginHorizontal: 4, marginTop: 4 },
  lone: { marginHorizontal: 4, marginTop: 4 },
  label: { paddingHorizontal: 4, paddingTop: 4 },
  more: { paddingTop: 14 },
  whosOut: { marginHorizontal: -18 },
  whos: { gap: 6, paddingHorizontal: 18, paddingVertical: 4 },
  who: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    maxWidth: 260,
    paddingLeft: 6,
    paddingRight: 14,
    borderRadius: 22,
  },
  pressed: { transform: [{ scale: 0.96 }] },
  bold: { fontWeight: "600" },
  role: { flexShrink: 1, opacity: 0.85 },
});
