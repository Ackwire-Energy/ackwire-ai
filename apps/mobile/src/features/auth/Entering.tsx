import { type Agent, keys } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { useOrgMaybe } from "@/providers/org";
import { Sky } from "@/sky/Sky";
import { Text, useTheme } from "@/ui";
import { agentLook } from "../shared/logic";
import { OrgAvatar } from "../shared/OrgAvatar";

/** How many of the team stand on the horizon. */
const TEAM = 4;

/**
 * The passage into the app after signing in: the workspace's mark over its sky, "Entrando na Acme…", and the team
 * already there on the horizon (the agents the phone knows of it; none on a first visit), so you see who you are
 * about to meet. The screen then becomes the conversations (or the first run when there is no workspace yet). It
 * also stands in for the launch splash, already gone by then, for as long as the account takes to load.
 */
export function Entering({ org }: { org: string | null }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const state = useOrgMaybe();
  const qc = useQueryClient();
  // What the phone already holds of this workspace's agents: never a request, the account is still loading.
  const agents = state?.orgId ? (qc.getQueryData<Agent[]>(keys.agents(state.orgId)) ?? []) : [];
  const team = agents.filter((a) => !a.former).slice(0, TEAM);
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(260)}
      style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}
      accessibilityLiveRegion="polite"
    >
      {/* The sky low on the screen, the horizon the team stands on; its glow fades upward on its own. */}
      <Sky color="sky" depth={0.7} fade={0.45} style={styles.sky} />
      <View style={styles.center}>
        {org ? (
          <OrgAvatar logo={state?.org?.logo} name={org} size={72} />
        ) : (
          <AgentAvatar agent={{ color: "sky", eyes: "round", id: "agentes" }} size={88} expression="happy" />
        )}
        <Text variant="display" style={styles.text}>
          {org ? t("mobile.entering.title", { org }) : t("mobile.entering.titleNew")}
        </Text>
        <Text variant="subhead" tone="muted" style={styles.text}>
          {org && team.length > 0 ? t("mobile.entering.team") : t("mobile.entering.lead")}
        </Text>
      </View>
      {team.length > 0 ? (
        <View style={styles.team} accessibilityElementsHidden>
          {team.map((a, i) => (
            <View key={a.id} style={styles.member}>
              {/* The first one at work: the team is busy, not posed. */}
              <AgentAvatar agent={{ ...agentLook(a), id: a.id }} size={36} framed={false} mode={i === 0 ? "run" : "idle"} />
              <Text variant="caption" tone="ink2" numberOfLines={1} style={styles.name}>
                {a.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sky: { position: "absolute", left: 0, right: 0, bottom: 0, height: 380 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32 },
  text: { textAlign: "center" },
  team: {
    position: "absolute",
    left: 32,
    right: 32,
    bottom: 120,
    flexDirection: "row",
    justifyContent: "center",
    gap: 18,
  },
  member: { alignItems: "center", gap: 4, maxWidth: 72 },
  name: { maxWidth: 72 },
});
