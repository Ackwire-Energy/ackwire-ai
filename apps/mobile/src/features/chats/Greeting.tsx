import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentAvatar, Button, Card, Icon, PixelOrbit, Sky, Text } from "@/ui";
import { crewOf } from "../agents/logic";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook, firstName, greetingKey } from "../shared/logic";
import { Tile, useSurface } from "../shared/parts";

/** The examples under "Comece pelo seu primeiro agente": each fills "o que faz" of a new agent. */
const EXAMPLES = [
  { key: "support", icon: "chat" },
  { key: "reports", icon: "doc" },
  { key: "weekly", icon: "clock" },
] as const;

/** The look of an agent still to be born (the new-agent sheet and the empty state). */
export const NEWBORN = { color: "indigo", eyes: "round" } as const;

/** "Bom dia, Walter" (or just "Bom dia"). */
function useGreeting() {
  const { t } = useTranslation();
  const me = useMe();
  const name = firstName(me.data?.user.name ?? "");
  return name ? t(`mobile.home.greeting.${greetingKey()}`, { name }) : t(`mobile.home.hello.${greetingKey()}`);
}

/**
 * The old Início's sky on top of Conversas, seen at rest and scrolling away with the list: the greeting,
 * who is working and what waits on you, and the crew (working ones bigger, with their orbit and name).
 * `reach`: how far the sky extends up behind the clear bar.
 */
export function Greeting({ busy, waiting, reach }: { busy: ReadonlySet<string>; waiting: number; reach: number }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const greeting = useGreeting();
  const crew = crewOf(dir.agents, busy, 5);
  return (
    <View style={styles.pull}>
      <Sky color="sky" depth={0.95} style={[StyleSheet.absoluteFill, { top: -reach }]} />
      <Text variant="display" accessibilityRole="header">
        {greeting}
      </Text>
      <Text variant="small" tone="muted" style={styles.sub}>
        {[
          busy.size > 0 ? t("mobile.chats.workingNowLine", { count: busy.size }) : t("mobile.chats.nobodyWorking"),
          waiting > 0 ? t("mobile.chats.waitingLine", { count: waiting }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {crew.length > 0 ? (
        <View style={styles.crew}>
          {crew.map(({ agent, busy: on }, i) => {
            const look = agentLook(agent);
            return (
              <Pressable
                key={agent.id}
                onPress={() => router.push(`/agent/${agent.id}`)}
                accessibilityRole="button"
                accessibilityLabel={on ? t("mobile.agents.workingLabel", { name: agent.name }) : agent.name}
                style={styles.ag}
              >
                <AgentAvatar agent={look} size={on ? 46 - i * 2 : 34} mode={on ? "run" : "idle"} />
                <View style={styles.agName}>
                  {on ? <PixelOrbit color={look.color} size={9} /> : null}
                  <Text variant="caption" tone="muted" numberOfLines={1} style={styles.medium}>
                    {agent.name}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Conversas with nothing in it yet: the sky with an agent about to be born, "Novo agente" and "Novo
 * canal", and examples of what an agent can do (each opens "Novo agente" with "o que faz" filled in).
 */
export function FirstAgentEmpty() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const newAgent = (what?: string) =>
    router.push(what ? { pathname: "/new-agent", params: { what } } : { pathname: "/new-agent" });
  return (
    <View>
      <View style={[styles.empty, surface]}>
        <View style={styles.emptySky}>
          <Sky color="indigo" depth={0.9} style={StyleSheet.absoluteFill} />
          <AgentAvatar agent={NEWBORN} size={78} />
        </View>
        <Text variant="display" style={styles.center} accessibilityRole="header">
          {t("mobile.chats.first.title")}
        </Text>
        <Text variant="small" tone="muted" style={[styles.center, styles.emptyText]}>
          {t("mobile.chats.first.subtitle")}
        </Text>
        <View style={styles.acts}>
          <Button variant="primary" wide icon="plus" label={t("mobile.agents.new")} onPress={() => newAgent()} />
          <Button
            variant="secondary"
            wide
            icon="hash"
            label={t("mobile.chats.newChannel")}
            onPress={() => router.push("/new-channel")}
          />
        </View>
      </View>
      <View style={styles.ideas}>
        <Text variant="label" style={styles.ideasTitle}>
          {t("mobile.chats.first.examples")}
        </Text>
        <Card>
          {EXAMPLES.map((ex, i) => (
            <Pressable
              key={ex.key}
              onPress={() => newAgent(t(`mobile.chats.first.example.${ex.key}.what`))}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.idea,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 },
                pressed && { backgroundColor: c.sunken },
              ]}
            >
              <Tile icon={ex.icon} />
              <View style={styles.grow}>
                <Text variant="callout" style={styles.bold}>
                  {t(`mobile.chats.first.example.${ex.key}.title`)}
                </Text>
                <Text variant="footnote" tone="muted" numberOfLines={1}>
                  {t(`mobile.chats.first.example.${ex.key}.hint`)}
                </Text>
              </View>
              <Icon name="right" size={16} color={c.faint} />
            </Pressable>
          ))}
        </Card>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pull: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 18 },
  sub: { marginTop: 4 },
  crew: { flexDirection: "row", alignItems: "flex-end", gap: 16, marginTop: 16, minHeight: 60 },
  ag: { alignItems: "center", gap: 3 },
  agName: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 70 },
  medium: { fontWeight: "500" },
  empty: { marginHorizontal: 16, marginTop: 6, borderRadius: 28, overflow: "hidden", padding: 22, paddingTop: 0 },
  emptySky: { height: 150, marginHorizontal: -22, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  center: { textAlign: "center" },
  emptyText: { marginTop: 6, marginBottom: 18 },
  acts: { gap: 8 },
  ideas: { paddingHorizontal: 16, paddingTop: 18 },
  ideasTitle: { paddingHorizontal: 4, paddingBottom: 8 },
  idea: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 56,
  },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
