import { useComputerSetup, useSandboxSettings } from "@agenteschat/client";
import { setupView } from "@agenteschat/client/lib/computer";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { AgentComputersCard, CloudComputerCard } from "@/components/AgentComputer";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { HostComputerCard, MachinesSection } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { WorkspaceComputerCard } from "@/components/WorkspaceComputer";

/**
 * Configurações → Computadores. Where the workspace gets its own computer (ADR 0056 §10): its card and
 * nothing else, no pairing and no pickers. Where people bring their own: this server's computer first, the
 * other computers and how to connect one, which computer each agent uses, Daytona's sandboxes only on a
 * server that has them, then the help page on how computers work.
 */
export function ComputersSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const setup = useComputerSetup(org.id);
  const view = setupView(setup.data, setup.dataUpdatedAt);
  const sandbox = useSandboxSettings(org.id, setup.data?.mode === "pair");
  // No edition's cards before the server says which one this is: a failed answer is asked again, not guessed.
  if (!setup.data) {
    return setup.isError ? (
      <ErrorState error={setup.error} onRetry={() => void setup.refetch()} />
    ) : (
      <LoadingCards count={2} />
    );
  }
  if (view) return <WorkspaceComputerCard view={view} />;
  return (
    <>
      <HostComputerCard />
      <MachinesSection />
      <AgentComputersCard />
      {can(org.role, "configure") && sandbox.data?.available && <CloudComputerCard />}
      <p className="page__note">
        <HelpLink slug="computers">{t("computers.how")}</HelpLink>
      </p>
    </>
  );
}
