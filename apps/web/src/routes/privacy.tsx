import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/pages/LegalPage";

/** Privacy Policy, public (the sign-in screen and the phone app link here). */
export const Route = createFileRoute("/privacy")({
  component: () => <LegalPage kind="privacy" />,
});
