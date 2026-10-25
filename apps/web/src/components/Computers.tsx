import { useComputerSetup, useSandboxSettings } from "@agenteschat/client";
import { setupView } from "@agenteschat/client/lib/computer";
import { can } from "@agenteschat/client/lib/permissions";
import { AgentComputersCard, CloudComputerCard } from "@/components/AgentComputer";
import { LoadingCards } from "@/components/Loading";
import { HostComputerCard, MachinesSection } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { WorkspaceComputerCard } from "@/components/WorkspaceComputer";

/**
 * Configurações → Computadores. Where the workspace gets its own computer (ADR 0056 §10): its card and
 * nothing else, no pairing and no pickers. Where people bring their own: this server's computer first, the
 * other computers and how to connect one, which computer each agent uses, and Daytona's sandboxes only on a
 * server that has them.
 */
export function ComputersSection() {
  const { org } = useOrg();
  const setup = useComputerSetup(org.id);
  const view = setupView(setup.data, setup.dataUpdatedAt);
  const sandbox = useSandboxSettings(org.id, setup.data?.mode === "pair");
  // No edition's cards for a moment before the server says which one this is.
  if (setup.isLoading) return <LoadingCards count={2} />;
  if (view) return <WorkspaceComputerCard view={view} />;
  return (
    <>
      <HostComputerCard />
      <MachinesSection />
      <AgentComputersCard />
      {can(org.role, "configure") && sandbox.data?.available && <CloudComputerCard />}
    </>
  );
}
