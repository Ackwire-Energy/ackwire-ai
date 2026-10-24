import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/pages/LegalPage";

/** Terms of Use, public (the sign-in screen and the phone app link here). */
export const Route = createFileRoute("/terms")({
  component: () => <LegalPage kind="terms" />,
});
