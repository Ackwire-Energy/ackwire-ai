import { createFileRoute } from "@tanstack/react-router";
import { type InstallSystem, systemOfParam } from "@/components/install/guide";
import { DownloadPage } from "@/pages/DownloadPage";

/**
 * The desktop app's download page, public on every server (ADR 0036 §10): the newest build for this computer's
 * system, why the system asks the first time (beta), and each step with a drawing. `?system=mac|windows|linux` opens
 * another system's steps (the "Full step by step" link under a download says which one was picked).
 */
export const Route = createFileRoute("/download")({
  validateSearch: (search: Record<string, unknown>): { system?: InstallSystem } => {
    const system = systemOfParam(search.system);
    return system ? { system } : {};
  },
  component: function Download() {
    const { system } = Route.useSearch();
    return <DownloadPage initial={system} />;
  },
});
