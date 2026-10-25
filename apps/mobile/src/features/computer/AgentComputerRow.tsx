import { isWaitingHandoff, useBrowserHandoffActions } from "@agenteschat/client";
import { entryKind, entryLine, entryPortrait, entryState } from "@agenteschat/client/lib/agent-computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { Button, Card, Row, Section, useToast } from "@/ui";
import { useDirectory, useNow } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { phoneEntryButton } from "./logic";
import { useSetupWait } from "./SetupWait";
import { useAgentComputer } from "./useAgentComputer";

/** Opens an agent's computer full screen. */
export const openComputer = (agentId: string) => router.push(`/computer/${agentId}`);

/**
 * "Computador" on the agent's profile, as the web's entry: the computer's portrait, "Computador da Ada", the
 * same status line and Abrir, or Ajudar on a request in the agent's browser for this person. Only for whoever
 * may watch the computer, the wait included. The row never opens a stream.
 */
export function AgentComputerRow({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const actions = useBrowserHandoffActions(orgId);
  const view = useAgentComputer(agentId);
  const wait = useSetupWait(view.setup);
  const f = view.facts;
  // A request's minutes left move on too.
  const requestNow = useNow(f?.handoff && isWaitingHandoff(f.handoff) ? 15_000 : 60_000);
  // Only for whoever may watch it; nothing while that loads, never one edition's words before the other's.
  if (view.forbidden || !view.ready || !f) return null;
  const now = Math.max(requestNow, wait.now);
  const state = entryState(f, now);
  const name = dir.agentById.get(agentId)?.name ?? "";
  const g = agentGrammar(t, name);
  const line = entryLine(t, state, {
    edition: f.edition,
    locale: i18n.language,
    computer: view.machine?.name ?? t("computerSetup.title", { org: org?.name ?? "" }),
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
  return (
    <Section title={t("agentComputer.button")}>
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
