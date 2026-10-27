import { entryLine, entryState } from "@agenteschat/client/lib/agent-computer";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/ui";
import { openComputer } from "../computer/AgentComputerRow";
import { useAgentComputer } from "../computer/useAgentComputer";
import { useDirectory } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";

/** The entry's states worth hearing on the button (the web's dot): someone is needed there, or it's in use. */
const SAYS: ReadonlySet<string> = new Set(["needsYou", "needsOther", "working", "you", "other"]);

/**
 * "Computador" in an agent's DM header, as the web's: for whoever may watch the agent's computer (the
 * profile's entry shows to the same people) once it has one, it opens it full screen. While the agent needs
 * someone there or works on it, a screen reader hears that too.
 */
export function DmComputerButton({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const view = useAgentComputer(agentId);
  const f = view.facts;
  if (!view.ready || view.forbidden || !f) return null;
  const entry = entryState(f);
  // A self-hosted agent with no computer yet: nothing to open from here (its profile offers to pick one).
  if (entry.kind === "noComputer") return null;
  const says = SAYS.has(entry.kind)
    ? entryLine(t, entry, {
        edition: f.edition,
        locale: i18n.language,
        computer: view.machine?.name ?? "",
        lastSeenAt: null,
        person: (id) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson"),
        step: null,
        emailPromised: false,
      })
    : "";
  return (
    <IconButton
      icon="laptop"
      label={says ? `${t("agentComputer.button")}, ${says}` : t("agentComputer.button")}
      onPress={() => {
        tapHaptic();
        openComputer(agentId);
      }}
    />
  );
}
