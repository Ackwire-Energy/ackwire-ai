import type { SignInProvider } from "@agenteschat/client";
import { createFileRoute } from "@tanstack/react-router";
import { DesktopSignInPage } from "@/pages/DesktopSignInPage";

const PROVIDERS: SignInProvider[] = ["google", "github", "apple"];

/** The Mac app's social sign-in, in the browser (D79): the app opens this here instead of loading it. */
export const Route = createFileRoute("/desktop/sign-in")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { provider?: SignInProvider; challenge?: string; done?: string } => ({
    provider: PROVIDERS.find((p) => p === search.provider),
    challenge:
      typeof search.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(search.challenge)
        ? search.challenge
        : undefined,
    done: search.done === "1" || search.done === 1 ? "1" : undefined,
  }),
  component: function DesktopSignIn() {
    const { provider, challenge, done } = Route.useSearch();
    return <DesktopSignInPage provider={provider} challenge={challenge} done={done === "1"} />;
  },
});
