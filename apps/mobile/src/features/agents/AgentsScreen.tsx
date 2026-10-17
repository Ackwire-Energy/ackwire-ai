import { useCreateAgent, useWorkingRuns } from "@agenteschat/client";
import { handleFrom } from "@agenteschat/client/lib/text";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import {
  AgentAvatar,
  Button,
  Card,
  EmptyState,
  fonts,
  Icon,
  IconButton,
  LargeTitleScreen,
  PixelOrbit,
  Text,
  useToast,
} from "@/ui";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { successHaptic, Tile } from "../shared/parts";
import { useWorkingNow } from "../shared/queries";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { busyAgents } from "./logic";

/** Agentes: the team in two columns, who is working (orbit) or free (moon); "Novo agente". */
export function AgentsScreen() {
  return (
    <SheetHostProvider>
      <Agents />
    </SheetHostProvider>
  );
}

function Agents() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const sheet = useSheet();
  const runs = useWorkingRuns(useOrgId());
  const busy = busyAgents(useWorkingNow());
  const agents = [...dir.agents].sort((a, b) => a.name.localeCompare(b.name));
  const working = agents.filter((a) => busy.has(a.id)).length;
  const newAgent = () => sheet.open(<NewAgentForm />);
  // Busca → "Criar agente" opens this screen with `?new=1`.
  const params = useLocalSearchParams<{ new?: string }>();
  useEffect(() => {
    if (!params.new) return;
    sheet.open(<NewAgentForm />);
    router.setParams({ new: undefined });
  }, [params.new, sheet]);
  return (
    <LargeTitleScreen
      title={t("mobile.agents.title")}
      subtitle={t("mobile.agents.subtitle", { count: agents.length, working })}
      headerRight={<IconButton icon="plus" label={t("mobile.agents.new")} onPress={newAgent} />}
      refreshControl={<RefreshControl refreshing={runs.isRefetching} onRefresh={() => void runs.refetch()} />}
    >
      {dir.loading ? null : agents.length === 0 ? <EmptyState title={t("mobile.agents.empty")} sky /> : null}
      <View style={styles.grid}>
        {agents.map((a, i) => {
          const on = busy.has(a.id);
          const look = agentLook(a);
          return (
            <Pressable
              key={a.id}
              onPress={() => router.push(`/agent/${a.id}`)}
              accessibilityRole="button"
              accessibilityLabel={on ? t("mobile.agents.workingLabel", { name: a.name }) : a.name}
              style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
            >
              <Card>
                <View style={styles.agc}>
                  <AgentAvatar agent={look} size={52} mode={on ? "run" : "idle"} live={i < 8} />
                  <Text variant="body" style={styles.name} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <Text variant="small" tone="muted" numberOfLines={1}>
                    {a.role || " "}
                  </Text>
                  <View style={styles.st}>
                    {on ? <PixelOrbit color={look.color} size={11} /> : <Icon name="moon" size={13} color={c.faint} />}
                    <Text variant="caption" tone="faint">
                      {on ? t("mobile.agents.working") : t("mobile.agents.free")}
                    </Text>
                  </View>
                </View>
              </Card>
            </Pressable>
          );
        })}
        <Pressable
          onPress={newAgent}
          accessibilityRole="button"
          style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
        >
          <View style={[styles.newCard, { borderColor: c.line2 ?? c.line }]}>
            <Tile icon="plus" size={44} />
            <Text variant="small" tone="muted" style={styles.bold}>
              {t("mobile.agents.new")}
            </Text>
          </View>
        </Pressable>
      </View>
    </LargeTitleScreen>
  );
}

/** "Novo agente": its name and what it will do; the rest is suggested and adjusted later. */
function NewAgentForm() {
  const { t } = useTranslation();
  const toast = useToast();
  const sheet = useSheet();
  const create = useCreateAgent(useOrgId());
  const [name, setName] = useState("");
  const [what, setWhat] = useState("");
  const ready = name.trim().length >= 2 && what.trim().length > 0;
  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      { name: name.trim(), handle: handleFrom(name), instructions: what.trim() },
      {
        onSuccess: (agent) => {
          sheet.close();
          successHaptic();
          toast({ title: t("mobile.agents.created", { name: agent.name }), agentId: agent.id });
          router.push(`/agent/${agent.id}`);
        },
        onError: () => toast({ title: t("mobile.agents.createFailed"), icon: "x" }),
      },
    );
  };
  return (
    <>
      <SheetTitle title={t("mobile.agents.new")} />
      <Text variant="body" tone="muted">
        {t("mobile.agents.newIntro")}
      </Text>
      <TextArea
        value={name}
        onChangeText={setName}
        placeholder={t("mobile.agents.namePlaceholder")}
        accessibilityLabel={t("mobile.agents.namePlaceholder")}
        multiline={false}
        minHeight={48}
        autoFocus
      />
      <TextArea
        value={what}
        onChangeText={setWhat}
        placeholder={t("mobile.agents.whatPlaceholder")}
        accessibilityLabel={t("mobile.agents.whatPlaceholder")}
      />
      <Button
        variant="primary"
        wide
        icon="sparkle"
        label={t("mobile.agents.create")}
        disabled={!ready || create.isPending}
        onPress={submit}
      />
    </>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 16 },
  cell: { width: "48.5%" },
  pressed: { transform: [{ scale: 0.97 }] },
  agc: { padding: 14, gap: 2 },
  name: { fontFamily: fonts.bold, marginTop: 10 },
  bold: { fontFamily: fonts.semibold },
  st: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  newCard: {
    minHeight: 150,
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
});
