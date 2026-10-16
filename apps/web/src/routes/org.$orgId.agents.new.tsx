import { createFileRoute } from "@tanstack/react-router";
import { NewAgentPage } from "@/pages/NewAgentPage";

/** A focused flow: the org layout leaves the sidebar out while it's open (see `org.$orgId.tsx`). */
export const Route = createFileRoute("/org/$orgId/agents/new")({
  component: NewAgentPage,
});
