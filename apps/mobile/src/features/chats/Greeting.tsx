import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentAvatar, Button, Card, Icon, PixelOrbit, Sky, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook, firstName, greetingKey } from "../shared/logic";
import { Tile, useSurface } from "../shared/parts";
import { FIRST_AGENT_EXAMPLES } from "./examples";
import { type FinishedItem, finishedKey, greetingLine } from "./now";

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

/** Opens Agentes (who is working, doing what). */
const openAgents = () => router.navigate("/agents");

/** The light sky behind Conversas' bar, large title and greeting, fading out toward the list. */
export function GreetingSky() {
  return <Sky color="sky" depth={0.9} fade={0.45} style={StyleSheet.absoluteFill} />;
}

/**
 * The greeting under Conversas' large title,
 * scrolling away with the list: "Boa noite, Walter", then what changed: what an agent finished ("Theo
 * terminou “…”", opens where it happened) and how many work now (opens Agentes), with the faces of the
 * ones working (moving).
 */
export function Greeting({
  working,
  finished,
  onFinishedPress,
}: {
  working: readonly string[];
  /** The newest thing an agent finished (null: nothing new). */
  finished: FinishedItem | null;
  /** Tapped what finished (it opens there and is taken off). */
  onFinishedPress?: (f: FinishedItem) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const greeting = useGreeting();
  const color = agentLook(working[0] ? dir.agentById.get(working[0]) : undefined).color;
  const line = greetingLine(finished, working.length);
  const workingText =
    line.kind === "finished"
      ? t("mobile.homeNow.working", { count: line.working })
      : line.kind === "working"
        ? t("mobile.chats.workingNowLine", { count: line.working })
        : t("mobile.chats.nobodyWorking");
  const finishedName = line.kind === "finished" ? (dir.agentById.get(line.finished.agentId)?.name ?? "") : "";
  const finishedText =
    line.kind === "finished" ? t(finishedKey(line.finished), { what: line.finished.what ?? "" }) : "";
  const openFinished = (f: FinishedItem) => {
    onFinishedPress?.(f);
    router.push(f.href ?? `/agent/${f.agentId}`);
  };
  const workingPart = (
    <View style={styles.part}>
      {line.kind !== "idle" && working.length > 0 ? <PixelOrbit color={color} size={9} /> : null}
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
        {workingText}
      </Text>
    </View>
  );
  return (
    <View style={styles.mini}>
      <View style={styles.grow}>
        <Text variant="body" tone="ink2" numberOfLines={1}>
          {greeting}
        </Text>
        <View style={styles.line}>
          {line.kind === "finished" ? (
            <>
              <Pressable
                onPress={() => openFinished(line.finished)}
                accessibilityRole="button"
                accessibilityLabel={`${finishedName} ${finishedText}`}
                hitSlop={8}
                style={({ pressed }) => [styles.part, styles.shrink, pressed && styles.pressed]}
              >
                <Icon name="checkc" size={13} color={c.muted} />
                <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
                  {finishedName ? (
                    <Text variant="footnote" tone="ink2" style={styles.bold}>
                      {`${finishedName} `}
                    </Text>
                  ) : null}
                  {finishedText}
                </Text>
              </Pressable>
              {line.working > 0 ? (
                <>
                  <Text variant="footnote" tone="faint">
                    ·
                  </Text>
                  <Pressable
                    onPress={openAgents}
                    accessibilityRole="button"
                    accessibilityLabel={workingText}
                    hitSlop={8}
                    style={({ pressed }) => [styles.noShrink, pressed && styles.pressed]}
                  >
                    {workingPart}
                  </Pressable>
                </>
              ) : null}
            </>
          ) : line.kind === "working" ? (
            <Pressable
              onPress={openAgents}
              accessibilityRole="button"
              accessibilityLabel={workingText}
              hitSlop={8}
              style={({ pressed }) => [styles.shrink, pressed && styles.pressed]}
            >
              {workingPart}
            </Pressable>
          ) : (
            workingPart
          )}
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
 * Conversas with nothing in it yet: the sky with an agent about to
 * be born, one primary "Criar meu primeiro agente", and examples of what an agent can do (each opens "Novo
 * agente" with "o que faz" filled in).
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
          <Sky color="indigo" depth={0.9} surface="raised" style={StyleSheet.absoluteFill} />
          <AgentAvatar agent={NEWBORN} size={78} />
        </View>
        <Text variant="display2" style={styles.center} accessibilityRole="header">
          {t("mobile.chats.first.title")}
        </Text>
        <Text variant="small" tone="muted" style={[styles.center, styles.emptyText]}>
          {t("mobile.homeNow.first.subtitle")}
        </Text>
        <View style={styles.acts}>
          <Button
            variant="primary"
            wide
            icon="plus"
            label={t("mobile.homeNow.first.create")}
            onPress={() => newAgent()}
          />
        </View>
      </View>
      <View style={styles.ideas}>
        <Text variant="label" style={styles.ideasTitle}>
          {t("mobile.homeNow.first.examples")}
        </Text>
        <Card>
          {FIRST_AGENT_EXAMPLES.map((ex, i) => (
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
  mini: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingBottom: 18 },
  line: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  part: { flexDirection: "row", alignItems: "center", gap: 4 },
  shrink: { flexShrink: 1 },
  noShrink: { flexShrink: 0 },
  pressed: { opacity: 0.6 },
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
