import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentAvatar, Button, Card, Icon, PixelOrbit, Sky, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
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

/** Faces of working agents drawn over the greeting (the rest is the count). */
const FACES = 4;

/**
 * The one-line greeting on top of Conversas (MobileHomeAgentes.html `.gmini`), seen at rest and scrolling
 * away with the list: "Boa noite, Walter", how many agents are working with the pixel orbit, and the faces of
 * the ones working (moving), over a light sky that fades out. `reach`: how far the sky extends up behind
 * the clear bar.
 */
export function Greeting({ working, reach }: { working: readonly string[]; reach: number }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const greeting = useGreeting();
  const color = agentLook(working[0] ? dir.agentById.get(working[0]) : undefined).color;
  const line =
    working.length > 0 ? t("mobile.chats.workingNowLine", { count: working.length }) : t("mobile.chats.nobodyWorking");
  return (
    <View style={styles.mini}>
      <Sky color="sky" depth={0.9} fade={0.45} style={[StyleSheet.absoluteFill, { top: -reach }]} />
      <View style={styles.grow} accessible accessibilityLabel={`${greeting}. ${line}`}>
        <Text variant="small" tone="ink" style={styles.bold} numberOfLines={1} accessibilityRole="header">
          {greeting}
        </Text>
        <View style={styles.line}>
          {working.length > 0 ? <PixelOrbit color={color} size={9} /> : null}
          <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
            {line}
          </Text>
        </View>
      </View>
      {working.length > 0 ? (
        <View style={styles.faces}>
          {working.slice(0, FACES).map((id, i) => (
            <Pressable
              key={id}
              onPress={() => router.push(`/agent/${id}`)}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.agents.workingLabel", { name: dir.agentById.get(id)?.name ?? "" })}
              style={i > 0 ? styles.overlap : undefined}
            >
              <AgentFace agentId={id} size={30} mode="run" />
            </Pressable>
          ))}
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
  mini: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 6 },
  line: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
  shrink: { flexShrink: 1 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -8 },
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
