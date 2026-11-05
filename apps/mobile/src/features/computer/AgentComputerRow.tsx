import {
  asksPicture,
  isWaitingHandoff,
  PICTURE_IDLE_MS,
  useBrowserHandoffActions,
  useDesktopPicture,
} from "@agenteschat/client";
import { entryKind, entryLine, entryPortrait, entryState, pictureWhen } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Image } from "expo-image";
import { router, useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet } from "react-native";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { Button, Card, Row, Section, Text, useToast } from "@/ui";
import { useDirectory, useNow } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { phoneEntryButton } from "./logic";
import { useSetupWait } from "./SetupWait";
import { useAgentComputer } from "./useAgentComputer";

/** Opens an agent's computer full screen. */
export const openComputer = (agentId: string) => router.push(`/computer/${agentId}`);

/**
 * "Computador" on the agent's profile, as the web's entry: the computer's portrait, "Computador da Ada", the
 * same status line and Abrir, or Ajudar on a request of the agent's for this person, under a recent picture of its
 * screen while one runs. Only for whoever may watch the computer, the wait included. The row never opens a stream.
 */
export function AgentComputerRow({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const actions = useBrowserHandoffActions(orgId);
  const focused = useIsFocused();
  const view = useAgentComputer(agentId, focused ? PICTURE_IDLE_MS : false);
  const wait = useSetupWait(view.setup);
  const f = view.facts;
  const asks = asksPicture(focused, view.desktopQ.data ?? null);
  const shot = useDesktopPicture(orgId, agentId, { enabled: asks, working: Boolean(f?.working) });
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
  const picture = asks ? shot.data?.picture : null;
  return (
    <Section title={t("agentComputer.button")}>
      {picture ? (
        <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={t("agentComputer.openOf", g)}>
          <Image
            source={{ uri: `data:image/jpeg;base64,${picture.data}` }}
            contentFit="cover"
            contentPosition="left top"
            style={styles.picture}
            accessible={false}
          />
          <Text variant="caption" tone="muted" style={styles.when}>
            {pictureWhen(t, i18n.language, picture.capturedAt, new Date(now))}
          </Text>
        </Pressable>
      ) : null}
      <Card>
        <Row
          leading={<ComputerPortrait kind={entryKind(f.edition, view.machine)} state={entryPortrait(state, f.setup)} />}
          title={t("agentComputer.title", g)}
          subtitle={line}
          meta={
            phoneEntryButton(state) === "help" ? (
              <Button variant="primary" size="sm" label={t("agentComputer.help")} onPress={() => void help()} />
            ) : (
              <Button variant="secondary" size="sm" label={t("agentComputer.open")} onPress={open} />
            )
          }
          onPress={open}
        />
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  picture: { width: "100%", aspectRatio: 16 / 10, borderRadius: 12 },
  when: { marginTop: 6, marginBottom: 10 },
});
