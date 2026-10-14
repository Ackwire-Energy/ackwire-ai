import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { OnboardingPage } from "@/pages/OnboardingPage";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: ({ context, location }) => requireUser(context, location.href),
  component: OnboardingPage,
});
