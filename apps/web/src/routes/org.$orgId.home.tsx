import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { HomePage } from "@/pages/HomePage";

/** Início: what waits on me, what my agents are doing, what got done (ADR 0108). */
export const Route = createFileRoute("/org/$orgId/home")({
  component: () => (
    <Main>
      <HomePage />
    </Main>
  ),
});
