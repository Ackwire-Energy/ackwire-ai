import { isWaitingHandoff, useBrowserHandoffActions } from "@agenteschat/client";
import { entryLine, entryState } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Icon, PressScale, useTheme, useToast } from "@/ui";
import { BUTTON_SIZES } from "@/ui/Button";
import { useDirectory, useNow } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { phoneEntryButton } from "./logic";
import { useSetupWait } from "./SetupWait";
import { useAgentComputer } from "./useAgentComputer";

/** Opens an agent's computer full screen. */
export const openComputer = (agentId: string) => router.push(`/computer/${agentId}`);

/** As tall as the profile's Chat beside it (`md`), and as wide: a square on the button ruler. */
const SIZE = BUTTON_SIZES.md.height;

/**
 * The agent's computer on its profile, beside Chat: a square secondary button that opens it, as the web's
 * entry does. Only for whoever may watch the computer, the wait included; nothing while that loads. A screen reader
 * hears the entry's status line with it. On a request of the agent's for this person it helps (takes control, then
 * opens), and a dot in the waiting color says so, since a request is the one thing here that waits on them. The
 * button never opens a stream.
 */
export function AgentComputerButton({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { org, orgId } = useOrg();
  const { colors: c, shadows, scheme } = useTheme();
  const dir = useDirectory();
  const toast = useToast();
  const actions = useBrowserHandoffActions(orgId);
  const view = useAgentComputer(agentId);
  const wait = useSetupWait(view.setup);
  const f = view.facts;
  // A request's minutes left move on too. While the computer is on its way, the time every other line reads.
  const requestNow = useNow(f?.handoff && isWaitingHandoff(f.handoff) ? 15_000 : 60_000);
  // Only for whoever may watch it; nothing while that loads, never one edition's words before the other's.
  if (view.forbidden || !view.ready || !f) return null;
  const now = wait.now ?? requestNow;
  const state = entryState(f, now);
  const name = dir.agentById.get(agentId)?.name ?? "";
  const g = agentGrammar(name);
  const line = entryLine(t, state, {
    edition: f.edition,
    locale: i18n.language,
    computer: computerName(t, org?.name ?? "", view.machine),
    lastSeenAt: view.machine?.lastSeenAt ?? null,
    person: (id) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson"),
    step: null,
    emailPromised: wait.emailed,
    now: new Date(now),
  });
  const helps = phoneEntryButton(state) === "help";
  const what = helps ? t("agentComputer.help") : t("agentComputer.openOf", g);
  // The secondary button's lit top edge (`Button`).
  const edge = scheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.9)";
  const open = () => {
    tapHaptic();
    openComputer(agentId);
  };
  const help = async () => {
    if (state.kind !== "needsYou") return;
    tapHaptic();
    try {
      await actions.takeControl(state.handoff.id);
      openComputer(agentId);
    } catch (err) {
      toast({
        title: (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
        icon: "x",
      });
    }
  };
  return (
    <PressScale
      onPress={helps ? () => void help() : open}
      sink
      accessibilityRole="button"
      accessibilityLabel={[what, line].filter(Boolean).join(", ")}
      style={[styles.button, { boxShadow: shadows.e1 }]}
    >
      <View style={[styles.face, { backgroundColor: c.raised }]}>
        <View style={[styles.edge, { backgroundColor: edge }]} />
        <Icon name="laptop" size={BUTTON_SIZES.md.icon} color={c.ink} />
      </View>
      {helps ? <View style={[styles.dot, { backgroundColor: c.amber, borderColor: c.grouped }]} /> : null}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  button: { width: SIZE, height: SIZE, borderRadius: BUTTON_SIZES.md.radius },
  face: {
    flexGrow: 1,
    borderRadius: BUTTON_SIZES.md.radius,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  edge: { position: "absolute", top: 0, left: 0, right: 0, height: 1 },
  dot: { position: "absolute", top: -3, right: -3, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
});
