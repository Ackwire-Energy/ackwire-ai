import { meQuery } from "@agenteschat/client";
import { safeRedirect } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthPage } from "@/pages/AuthPage";

/** The same flow as /login (the e-mail decides), worded for someone new. */
export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (me) throw redirect({ href: search.redirect ?? "/" });
  },
  component: function Signup() {
    return <AuthPage start="up" redirect={Route.useSearch().redirect} />;
  },
});
