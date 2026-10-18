import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SettingsPage } from "@/pages/SettingsPage";

/** Configurações → Computadores → one computer: its state, folders and tools (ADR 0036). */
export const Route = createFileRoute("/org/$orgId/settings_/computers/$machineId")({
  component: function MachineRoute() {
    const { machineId } = Route.useParams();
    return (
      <Main>
        <SettingsPage section="computers" machineId={machineId} />
      </Main>
    );
  },
});
