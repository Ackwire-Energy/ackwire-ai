import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentAvatar, Button, Card, Icon, Sky, Text, WorkspaceSky } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { firstName, greetingKey } from "../shared/logic";
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

/** Faces in the line's groups (who works, or everyone resting); the rest is the count. */
const FACES = 4;
/** The faces in the line: the size of its text, each in its own sky tile. */
const FACE = 18;

/** Opens Agentes (who is working, doing what). */
const openAgents = () => router.navigate("/agents");

/** The workspace's sky behind Conversas' bar, large title and greeting, fading out toward the list. */
export function GreetingSky() {
  return <WorkspaceSky fade={0.45} style={StyleSheet.absoluteFill} />;
}

/**
 * The greeting under Conversas' large title, scrolling away with the list: "Boa noite, Walter", then one short
 * line with the agents' own faces in it: what one finished (its face before its name; opens where it happened),
 * else who works now (their faces, working, before the count; opens Agentes; the list below says what each
 * does), else everyone's faces resting, eyes closed.
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
  const dir = useDirectory();
  const greeting = useGreeting();
  const line = greetingLine(finished, working.length);
  const workingText =
    line.kind === "working"
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
      {working.length > 0 ? <Faces ids={working} mode="run" /> : null}
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
        {workingText}
      </Text>
    </View>
  );
  const resting = line.kind === "idle" ? dir.agents.map((a) => a.id) : [];
  return (
    <View style={styles.mini}>
      <Text variant="body" tone="ink2" numberOfLines={1}>
        {greeting}
      </Text>
      <View style={styles.line}>
        {line.kind === "finished" ? (
          <Pressable
            onPress={() => openFinished(line.finished)}
            accessibilityRole="button"
            accessibilityLabel={`${finishedName} ${finishedText}`}
            hitSlop={8}
            style={({ pressed }) => [styles.part, styles.shrink, pressed && styles.pressed]}
          >
            <AgentFace agentId={line.finished.agentId} size={FACE} framed />
            <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
              {finishedName ? (
                <Text variant="footnote" tone="ink2" style={styles.bold}>
                  {`${finishedName} `}
                </Text>
              ) : null}
              {finishedText}
            </Text>
          </Pressable>
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
          <View style={styles.part}>
            {resting.length > 0 ? <Faces ids={resting} mode="rest" /> : null}
            <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
              {workingText}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

/** A few faces of the line, a little over each other (decorative: the line says who and how many). */
function Faces({ ids, mode }: { ids: readonly string[]; mode: "run" | "rest" }) {
  return (
    <View style={styles.faces} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {ids.slice(0, FACES).map((id, i) => (
        <View key={id} style={i > 0 ? styles.overlap : undefined}>
          <AgentFace agentId={id} size={FACE} framed mode={mode} />
        </View>
      ))}
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
  mini: { paddingHorizontal: 20, paddingBottom: 18 },
  line: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  part: { flexDirection: "row", alignItems: "center", gap: 6 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -5 },
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
